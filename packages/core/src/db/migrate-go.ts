// One-shot Go songs.db → schema v1 migration (T5, master plan §3.3 in full).
//
// Order of operations: unlocked preview (idempotency + Go fingerprint) →
// WRITER lock → migration lock → old-daemon probe → the same read-only verdict
// again, now authoritative under the locks → DB-level EXCLUSIVE on the source
// → integrity/FK checks → checkpoint (busy asserted) → online backup → build
// `.migrating` at v1 → JS row-by-row transform → acceptance (counts, schema
// signature, integrity, FK, strictly-increasing ranks, fail-closed) → close
// every handle → atomic two-rename swap with old-swap rollback → cleanup.
//
// The lock order — writer → migrate → the source's EXCLUSIVE — is frozen
// across all four writers of this library (M6-18).
//
// Path discipline: every side file (.writer.lock / .migrate.lock / daemon.pid /
// .migrating / .old-swap / backup / sidecars) derives from dbPath — never from
// global paths.ts — so fixture runs in a temp dir can't touch the real nest.
//
// (`.exec` below is better-sqlite3's Database#exec — SQL, not child_process.)

import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { isUuidV4 } from '@lark/shared';
import BetterSqlite3 from 'better-sqlite3';
import {
  IncompatibleDbError,
  MigrationBusyError,
  SchemaMismatchError,
  SourceDbCorruptionError,
} from '../errors.js';
import { backupDatabase } from './backup.js';
import { type MigrateLock, acquireMigrateLock } from './migrate-lock.js';
import { LATEST_KNOWN_VERSION, applyForwardMigrations } from './migrate.js';
import { probeGoDaemon, probeGoDaemonPid } from './probe-go.js';
import { fsIsoTimestamp, migratingPath, oldSwapPath } from './recovery.js';
import { assertSchemaV1 } from './schema-signature.js';
import { acquireWriterLock } from './writer-lock.js';

/** Minimal structural logger — pino's Logger satisfies this. */
export interface MigrateLogger {
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

/** Swap-phase fs operations, injectable for fault tests. */
export interface SwapFsOps {
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
}

export interface GoMigrateOptions {
  logger?: MigrateLogger;
  fsOps?: Partial<SwapFsOps>;
  /**
   * Probe 127.0.0.1:47020 for a live Go daemon (default true). Tests turn it
   * off — the port is global, so a REAL Go daemon on this machine would fail
   * fixture runs in temp dirs.
   */
  httpProbe?: boolean;
}

export interface GoMigrateResult {
  backup_path: string;
  songs: number;
  playlists: number;
  memberships: number;
  elapsed_ms: number;
  already_migrated?: boolean;
}

const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** How long the read-only verdict waits out a competing lock holder. */
const PEEK_BUSY_TIMEOUT_MS = 2000;

/** Strict RFC3339 → unix-ms; null when unparseable. Offsets are respected. */
export function parseRfc3339(value: unknown): number | null {
  if (typeof value !== 'string' || !RFC3339_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const REQUIRED_GO_COLUMNS: Record<string, readonly string[]> = {
  songs: ['id', 'name', 'artist', 'created_at', 'lyrics_offset'], // duration tolerated absent (M1-9)
  playlists: ['id', 'list_name', 'is_system'],
  playlist_songs: ['playlist_id', 'song_id', 'position'],
};

interface GoSongRow {
  id: unknown;
  name: unknown;
  artist: string | null;
  created_at: unknown;
  lyrics_offset: number | null;
  duration?: number | null;
}

interface GoPlaylistRow {
  id: unknown;
  list_name: unknown;
  is_system: number | null;
}

interface GoMemberRow {
  playlist_id: string;
  song_id: string;
  position: number;
}

type SourceVerdict =
  | { kind: 'already-migrated'; result: GoMigrateResult }
  | { kind: 'migratable'; hasDuration: boolean };

/**
 * The complete verdict on the source library, taken through a READ-ONLY
 * handle: already at v1 (nothing to do), or a genuine Go-era library plus the
 * column layout the transform needs.
 *
 * Called twice on purpose (M6-18 ③). The first call is an unlocked fast path,
 * so re-running the command on a migrated library answers immediately instead
 * of queueing behind whoever holds the writer lock. The second runs INSIDE the
 * locks and is the authoritative one — it is what justifies the same-value
 * `user_version` write that follows, and it writes nothing itself, so a
 * library that turned out not to be migratable is handed back untouched.
 */
function inspectSource(dbPath: string, startedAt: number): SourceVerdict {
  const peek = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  try {
    // better-sqlite3 would otherwise wait out its own 5s default before
    // surfacing a raw SQLITE_BUSY. Somebody holding the source EXCLUSIVE — a
    // Go daemon, or another migrator that got here first — is a condition this
    // command has a name for, so answer with that name, quickly.
    peek.pragma(`busy_timeout = ${PEEK_BUSY_TIMEOUT_MS}`);
    const v = peek.pragma('user_version', { simple: true }) as number;
    if (v > LATEST_KNOWN_VERSION) {
      throw new IncompatibleDbError(dbPath, v, LATEST_KNOWN_VERSION);
    }
    if (v === LATEST_KNOWN_VERSION) {
      // The version number alone is not proof — the signature must hold too.
      assertSchemaV1(peek, dbPath);
      const n = (table: string) =>
        (peek.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      return {
        kind: 'already-migrated',
        result: {
          backup_path: '',
          songs: n('songs'),
          playlists: n('playlists'),
          memberships: n('playlist_songs'),
          elapsed_ms: Date.now() - startedAt,
          already_migrated: true,
        },
      };
    }
    if (v > 0) {
      throw new SchemaMismatchError(
        dbPath,
        `user_version=${v} — not a Go-era library; open it normally instead of migrating`,
      );
    }
    // v === 0: the Go fingerprint IS the column layout. Verified here, before
    // any escalation, so an unrecognised v0 database is refused without a
    // single byte written to it.
    return { kind: 'migratable', ...verifyGoColumns(peek, dbPath) };
  } catch (err) {
    if (String((err as { code?: string }).code).startsWith('SQLITE_BUSY')) {
      throw new MigrationBusyError(
        'exclusive_lock_busy',
        'another process is holding the source database — quit the Go app, or wait for the running migration to finish',
      );
    }
    throw err;
  } finally {
    peek.close();
  }
}

function verifyGoColumns(source: BetterSqlite3.Database, dbPath: string): { hasDuration: boolean } {
  for (const [table, cols] of Object.entries(REQUIRED_GO_COLUMNS)) {
    const info = source.pragma(`table_info(${table})`) as { name: string }[];
    if (info.length === 0) {
      throw new SchemaMismatchError(dbPath, `source table '${table}' is missing`);
    }
    const present = new Set(info.map((c) => c.name));
    for (const col of cols) {
      if (!present.has(col)) {
        throw new SchemaMismatchError(dbPath, `source table '${table}' missing column '${col}'`);
      }
    }
  }
  const songCols = source.pragma('table_info(songs)') as { name: string }[];
  return { hasDuration: songCols.some((c) => c.name === 'duration') };
}

function runChecks(sqlite: BetterSqlite3.Database, label: string): void {
  const integrity = sqlite.pragma('integrity_check') as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    throw new SourceDbCorruptionError(
      `${label} integrity_check failed: ${JSON.stringify(integrity)}`,
    );
  }
  const fk = sqlite.pragma('foreign_key_check') as unknown[];
  if (fk.length > 0) {
    throw new SourceDbCorruptionError(`${label} has ${fk.length} foreign_key_check violation(s)`);
  }
}

export async function migrateFromGoDb(
  dbPath: string,
  options: GoMigrateOptions = {},
): Promise<GoMigrateResult> {
  const startedAt = Date.now();
  const logger = options.logger;
  const fsOps: SwapFsOps = { renameSync, unlinkSync, ...options.fsOps };

  if (!existsSync(dbPath)) {
    throw new SchemaMismatchError(dbPath, 'no database file to migrate');
  }
  // Unlocked fast path: an already-migrated library, or one that was never a
  // Go library, is answered without waiting on anybody's lock.
  const preview = inspectSource(dbPath, startedAt);
  if (preview.kind === 'already-migrated') return preview.result;

  const migrating = migratingPath(dbPath);
  const oldSwap = oldSwapPath(dbPath);
  // Lock order (M6-18): writer → migrate → the source's own EXCLUSIVE.
  // The migrate lock is taken INSIDE the try: acquiring it can throw
  // (`migrate_lock_busy`), and a throw between the two acquisitions would
  // otherwise strand the writer lock for the life of the process.
  const writerLock = acquireWriterLock({ dbPath });
  let lock: MigrateLock | null = null;
  let source: BetterSqlite3.Database | null = null;
  let temp: BetterSqlite3.Database | null = null;

  try {
    lock = acquireMigrateLock(dbPath);

    // ── Old daemon probe (friendly tier; the EXCLUSIVE lock is the guard) ──
    if (options.httpProbe === false) {
      const pid = probeGoDaemonPid(dbPath);
      if (pid !== null) {
        throw new MigrationBusyError(
          'daemon_alive',
          `the Go lark daemon appears to be running (pid ${pid} from daemon.pid) — quit the Go app first`,
        );
      }
    } else {
      const daemon = await probeGoDaemon(dbPath);
      if (daemon.alive) {
        throw new MigrationBusyError('daemon_alive', daemon.detail);
      }
    }

    // ── Authoritative re-judge, under the locks, still zero writes ────────
    //
    // The preview above was taken with nobody holding anything: between it and
    // here, another migrator could have finished the job, or a daemon could
    // have forward-migrated the library. The same-value `user_version` write
    // below is only justified by THIS verdict.
    const verdict = inspectSource(dbPath, startedAt);
    if (verdict.kind === 'already-migrated') return verdict.result;
    const { hasDuration } = verdict;

    // ── DB-level exclusivity on the source ────────────────────────────────
    source = new BetterSqlite3(dbPath);
    source.pragma('busy_timeout = 0');
    source.pragma('locking_mode = EXCLUSIVE');
    try {
      // locking_mode is lazy: this read takes (and retains) the shared lock…
      source.prepare('SELECT count(*) FROM sqlite_master').get();
      // …and this same-value header write escalates to the retained EXCLUSIVE
      // lock. It also detects an uncommitted external write transaction
      // (a BEGIN IMMEDIATE holder) — a plain read would sail past RESERVED.
      source.exec('BEGIN IMMEDIATE');
      source.pragma('user_version = 0');
      source.exec('COMMIT');
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_BUSY') {
        throw new MigrationBusyError(
          'exclusive_lock_busy',
          'cannot take the exclusive lock on the source database — another process is holding it',
        );
      }
      throw err;
    }

    // ── Health checks ─────────────────────────────────────────────────────
    // (Structure was verified read-only above, before the escalation.)
    runChecks(source, 'source database');
    const ckpt = source.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
    if (ckpt[0]?.busy !== 0) {
      throw new MigrationBusyError('checkpoint_busy', 'WAL checkpoint reports busy');
    }

    // ── Backup (online API — consistent snapshot, no plain file copy) ─────
    const backupPath = `${dbPath}.bak-go-${fsIsoTimestamp()}`;
    if (existsSync(backupPath)) {
      throw new SourceDbCorruptionError(`backup target ${backupPath} already exists`);
    }
    await backupDatabase(source, backupPath);

    // ── Build the v1 temp db ──────────────────────────────────────────────
    if (existsSync(migrating)) {
      fsOps.unlinkSync(migrating); // ours, under the lock
    }
    temp = new BetterSqlite3(migrating);
    temp.pragma('journal_mode = DELETE'); // no sidecars → simpler residue states
    temp.pragma('foreign_keys = ON');
    applyForwardMigrations(temp, 0, LATEST_KNOWN_VERSION);

    // ── JS row-by-row transform (M1-8) ────────────────────────────────────
    const migrationTime = Date.now();
    const srcSongs = source.prepare('SELECT * FROM songs').all() as GoSongRow[];
    const srcPlaylists = source.prepare('SELECT * FROM playlists').all() as GoPlaylistRow[];
    const srcMembers = source.prepare('SELECT * FROM playlist_songs').all() as GoMemberRow[];

    const droppedPlaylists = new Set(
      srcPlaylists.filter((p) => p.is_system === 1).map((p) => p.id as string),
    );
    const keptPlaylists = srcPlaylists.filter((p) => p.is_system !== 1);
    const keptMembers = srcMembers.filter((m) => !droppedPlaylists.has(m.playlist_id));

    const insertSong = temp.prepare(
      `INSERT INTO songs (id, name, artist, source_url, source_provider, source_key,
         file_origin, lyrics_offset, duration, pinned, last_accessed_at,
         created_at, updated_at, device_id, lww_counter)
       VALUES (?, ?, ?, NULL, NULL, NULL, 'imported', ?, ?, 0, ?, ?, ?, NULL, 0)`,
    );
    const insertPlaylist = temp.prepare(
      `INSERT INTO playlists (id, name, created_at, updated_at, device_id, lww_counter)
       VALUES (?, ?, ?, ?, NULL, 0)`,
    );
    const insertMember = temp.prepare(
      `INSERT INTO playlist_songs (playlist_id, song_id, rank, added_at, updated_at, device_id, lww_counter)
       VALUES (?, ?, ?, ?, ?, NULL, 0)`,
    );

    temp.exec('BEGIN');
    try {
      for (const row of srcSongs) {
        if (typeof row.id !== 'string' || !isUuidV4(row.id)) {
          throw new SourceDbCorruptionError(
            `song id ${JSON.stringify(row.id)} is not a lowercase UUID v4 — aborting`,
          );
        }
        if (typeof row.name !== 'string') {
          throw new SourceDbCorruptionError(`song ${row.id} has a NULL/non-text name — aborting`);
        }
        // Go DDL leaves artist / lyrics_offset / duration nullable; map NULLs
        // to the Go DEFAULT semantics explicitly instead of letting them
        // become context-free NOT NULL constraint errors (M1-9).
        const artist = row.artist ?? '';
        if (row.artist === null) {
          logger?.info({ song: row.id }, 'NULL artist mapped to empty string');
        }
        const lyricsOffset = row.lyrics_offset ?? 0;
        if (row.lyrics_offset === null) {
          logger?.info({ song: row.id }, 'NULL lyrics_offset mapped to 0');
        }
        const duration = hasDuration ? (row.duration ?? 0) : 0;
        if (hasDuration && row.duration === null) {
          logger?.info({ song: row.id }, 'NULL duration mapped to 0');
        }
        let createdAt = parseRfc3339(row.created_at);
        if (createdAt === null) {
          logger?.warn(
            { song: row.id, created_at: row.created_at },
            'unparseable created_at — falling back to migration time',
          );
          createdAt = migrationTime;
        }
        insertSong.run(
          row.id,
          row.name,
          artist,
          lyricsOffset,
          duration,
          createdAt,
          createdAt,
          createdAt,
        );
      }

      for (const p of keptPlaylists) {
        if (typeof p.id !== 'string' || !isUuidV4(p.id)) {
          throw new SourceDbCorruptionError(
            `playlist id ${JSON.stringify(p.id)} is not a lowercase UUID v4 — aborting`,
          );
        }
        if (typeof p.list_name !== 'string') {
          throw new SourceDbCorruptionError(
            `playlist ${p.id} has a NULL/non-text list_name — aborting`,
          );
        }
        insertPlaylist.run(p.id, p.list_name, migrationTime, migrationTime);
      }

      for (const m of keptMembers) {
        const rank = (m.position + 1) * 1024;
        try {
          insertMember.run(m.playlist_id, m.song_id, rank, migrationTime, migrationTime);
        } catch (err) {
          throw new SourceDbCorruptionError(
            `membership (${m.playlist_id}, ${m.song_id}) failed to insert: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      temp.exec('COMMIT');
    } catch (err) {
      try {
        temp.exec('ROLLBACK');
      } catch {
        /* rollback best-effort */
      }
      throw err;
    }

    // ── Acceptance (fail-closed; source untouched on any miss) ────────────
    const countOf = (sqlite: BetterSqlite3.Database, table: string) =>
      (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const expected = {
      songs: srcSongs.length,
      playlists: keptPlaylists.length,
      memberships: keptMembers.length,
    };
    const actual = {
      songs: countOf(temp, 'songs'),
      playlists: countOf(temp, 'playlists'),
      memberships: countOf(temp, 'playlist_songs'),
    };
    if (
      actual.songs !== expected.songs ||
      actual.playlists !== expected.playlists ||
      actual.memberships !== expected.memberships
    ) {
      throw new SourceDbCorruptionError(
        `row count reconciliation failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
    assertSchemaV1(temp, migrating);
    runChecks(temp, 'migrated database');
    const rankRows = temp
      .prepare('SELECT playlist_id, rank FROM playlist_songs ORDER BY playlist_id, rank')
      .all() as { playlist_id: string; rank: number }[];
    for (let i = 1; i < rankRows.length; i++) {
      const prev = rankRows[i - 1];
      const cur = rankRows[i];
      if (cur.playlist_id === prev.playlist_id && !(cur.rank > prev.rank)) {
        throw new SourceDbCorruptionError(
          `ranks not strictly increasing in playlist ${cur.playlist_id} — duplicate positions in the source?`,
        );
      }
    }

    // ── Atomic swap (all DB handles closed FIRST — never rename under an
    //    open handle; closing the source releases the EXCLUSIVE lock) ──────
    temp.close();
    temp = null;
    source.close();
    source = null;

    fsOps.renameSync(dbPath, oldSwap);
    try {
      for (const suffix of ['-wal', '-shm']) {
        try {
          fsOps.unlinkSync(`${dbPath}${suffix}`);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      fsOps.renameSync(migrating, dbPath);
    } catch (err) {
      try {
        fsOps.renameSync(oldSwap, dbPath); // restore the original in place
      } catch {
        /* restore best-effort — recovery resolves {old-swap} on next open */
      }
      throw err;
    }
    try {
      fsOps.unlinkSync(oldSwap);
    } catch {
      /* best-effort — recovery archives a leftover old-swap on next open */
    }

    logger?.info({ ...expected, backup: backupPath }, 'Go library migrated to schema v1');
    return {
      backup_path: backupPath,
      ...expected,
      elapsed_ms: Date.now() - startedAt,
    };
  } finally {
    try {
      temp?.close();
    } catch {
      /* best-effort */
    }
    try {
      source?.close();
    } catch {
      /* best-effort */
    }
    try {
      // Failure paths only — on success `.migrating` was renamed into place.
      if (existsSync(migrating)) fsOps.unlinkSync(migrating);
    } catch {
      /* best-effort; recovery removes orphans next open */
    }
    // Released in reverse acquisition order (M6-18).
    lock?.release();
    writerLock.release();
  }
}
