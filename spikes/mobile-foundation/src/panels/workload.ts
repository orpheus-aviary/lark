// Criterion 18 — the three stalls a user waits on, replayed as STATEMENT SHAPE.
//
// EXPLICITLY A PROXY, and the label is load-bearing. This file does not import
// core's sync modules: it cannot (they reach for `node:crypto` and
// `node:fs/promises`, so Metro fails to resolve them until N1), and a spike
// that copied them in order to "verify" them would be verifying the copy
// (subplan §0). What it replays is the statement shape — same statements, same
// order, same count per item — read off core here:
//
//   backfill    sync/backfill.ts:130-171  + sync/changes.ts:43-70
//   apply       sync/apply.ts:254-300     + sync/lww.ts:50,89,
//                                           sync/hlc.ts:35-51,94,
//                                           sync/tombstones.ts:42
//   cold start  db open + portable migrate + library/songs.ts:288-322
//
// The non-SQL per-item work is replayed too — a uuid, a JSON.stringify, a UTF-8
// byte length — because on a phone each of those is a port rather than a free
// builtin (criteria 20/21), and leaving them out would flatter the result.
//
// Every number here is PROVISIONAL BY CONSTRUCTION. R5 re-runs the real
// `applyChangesInTx` after N1, and that is what freezes the batch size.

import {
  LATEST_KNOWN_VERSION,
  type SqliteLike,
  applyForwardMigrations,
  assertCurrentSchema,
  clearAudioMigrationPending,
} from '@lark/core/portable';
import { SYNC_PULL_LIMIT } from '@lark/shared';
import { randomUUID } from 'expo-crypto';
import { type SQLiteDatabase, deleteDatabaseSync, openDatabaseSync } from 'expo-sqlite';
import {
  MEASURED_ROUNDS,
  type Timing,
  WARMUP_ROUNDS,
  judge,
  measure,
  measureColdStart,
  now,
  summarize,
} from '../measure';
import { ExpoSqliteShim } from '../sqlite/shim';

/** The fixture the subplan names (§1.3-D). */
const LIBRARY_SONGS = 2_000;
const LIBRARY_PLAYLISTS = 5;
const LIBRARY_SYNC_CHANGES = 10_000;
/** A fourth count the plan does not name; see `buildLibrary`. */
const MEMBERSHIPS_PER_PLAYLIST = 200;

/** Segment sizes for the foreground threshold. The answer is the largest that fits. */
const BACKFILL_SEGMENTS = [50, 100, 200, 500] as const;
const APPLY_BATCHES = [50, 100, 200, SYNC_PULL_LIMIT] as const;
/** Above the production cap, and labelled as such wherever it is reported. */
const APPLY_STRESS_BATCH = 1_000;

const COLD_START_BUDGET_MS = 3_000;
const FOREGROUND_BUDGET_MS = 100;

const encoder = new TextEncoder();

export interface WorkloadRow {
  scenario: string;
  timing: Timing;
  /** `null` where the row is evidence rather than a judgement (stress, reference). */
  ok: boolean | null;
  note: string;
  /** Items per measured unit, so a passing row names its own batch size. */
  size: number | null;
}

// ─── Fixture ────────────────────────────────────────────

/** Deterministic uuid-shaped ids: same length and index behaviour as real ones. */
export function fakeUuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4000-8000-${hex.padStart(12, '0')}`;
}

const LOCAL_DEVICE_UUID = fakeUuid(999_999);
/** The cursor is keyed by (server, workspace), never by URL (0002's comment). */
const SERVER_ID = fakeUuid(888_888);
const WORKSPACE_ID = fakeUuid(777_777);

interface SongRow {
  id: string;
  name: string;
  artist: string;
  created_at: number;
  updated_at: number;
}

/**
 * A 2,000-song library that still owes its whole backfill.
 *
 * The `sync_changes` rows are `update`s, never `create`s. That is the trap
 * §1.3-D names: `runFullBackfillInTx` skips any row that already has a create
 * (backfill.ts:130-134), so a fixture seeded with creates would measure a
 * backfill with almost nothing to do and report it as a fast one.
 *
 * Memberships are the one count the plan's fixture list does not name. They are
 * here because the cold-start screen reads playlists, and a playlist with no
 * rows would under-measure the read it stands in for.
 */
function buildLibrary(sqlite: SqliteLike): void {
  applyForwardMigrations(sqlite, 0, LATEST_KNOWN_VERSION);
  clearAudioMigrationPending(sqlite);

  sqlite.transaction(() => {
    sqlite
      .prepare('INSERT INTO local_metadata (key, value) VALUES (?, ?)')
      .run('device_uuid', LOCAL_DEVICE_UUID);

    const insertSong = sqlite.prepare(
      `INSERT INTO songs (id, name, artist, source_url, source_provider, source_key,
         file_origin, lyrics_offset, duration, pinned, last_accessed_at,
         created_at, updated_at, device_id, lww_counter)
       VALUES (?, ?, ?, ?, 'bilibili', ?, 'downloaded', 0, ?, 0, NULL, ?, ?, NULL, 0)`,
    );
    for (let i = 0; i < LIBRARY_SONGS; i += 1) {
      const created = 1_700_000_000_000 + i * 1_000;
      const bvid = `BV1${i.toString(36).padStart(9, 'x')}`;
      insertSong.run(
        fakeUuid(i),
        `歌曲 ${i} · a title long enough to be realistic`,
        `艺人 ${i % 97}`,
        `https://www.bilibili.com/video/${bvid}`,
        `${bvid}:${i}`,
        180 + (i % 240),
        created,
        created,
      );
    }

    const insertPlaylist = sqlite.prepare(
      `INSERT INTO playlists (id, name, created_at, updated_at, device_id, lww_counter)
       VALUES (?, ?, ?, ?, NULL, 0)`,
    );
    const insertMember = sqlite.prepare(
      `INSERT INTO playlist_songs
         (playlist_id, song_id, rank, added_at, updated_at, device_id, lww_counter)
       VALUES (?, ?, ?, ?, ?, NULL, 0)`,
    );
    for (let p = 0; p < LIBRARY_PLAYLISTS; p += 1) {
      const playlistId = fakeUuid(900_000 + p);
      insertPlaylist.run(playlistId, `歌单 ${p}`, 1_700_000_000_000, 1_700_000_000_000);
      for (let m = 0; m < MEMBERSHIPS_PER_PLAYLIST; m += 1) {
        const song = (p * MEMBERSHIPS_PER_PLAYLIST + m) % LIBRARY_SONGS;
        insertMember.run(
          playlistId,
          fakeUuid(song),
          (m + 1) * 1024,
          1_700_000_000_000,
          1_700_000_000_000,
        );
      }
    }

    const insertChange = sqlite.prepare(
      `INSERT INTO sync_changes
         (device_id, entity_type, entity_id, op, payload, created_at,
          client_change_id, server_seq, synced_at)
       VALUES (?, 'song', ?, 'update', ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < LIBRARY_SYNC_CHANGES; i += 1) {
      const at = 1_700_000_000_000 + i;
      insertChange.run(
        LOCAL_DEVICE_UUID,
        fakeUuid(i % LIBRARY_SONGS),
        JSON.stringify({ name: `歌曲 ${i % LIBRARY_SONGS}`, updated_at_ms: at, lww_counter: 0 }),
        at,
        fakeUuid(500_000 + i),
        i + 1,
        at,
      );
    }
  })();
}

export interface Fixture {
  sqlite: SqliteLike;
  db: SQLiteDatabase;
  name: string;
  dispose(): void;
}

/**
 * What `createDatabase` does to every lark library on open (db/index.ts:75-93),
 * in its order — which is a rule, not a style: WAL is set only AFTER the
 * version has been read, because turning a database that might be rejected into
 * a WAL database is a write, and M1 froze "no writes before the decision".
 *
 * Journal mode is not a detail for this panel either. In the default DELETE
 * mode every COMMIT rewrites a rollback journal, which is both slower and far
 * more variable than WAL — a 500-row segment measured without it showed a p95
 * four times its own p50. Measuring a mode the product does not use would
 * produce a batch size nobody should trust. N2 owns the real mobile bootstrap;
 * if it chooses differently, this has to be re-run, which is why it is one
 * named function.
 */
function pragmasBeforeTheDecision(sqlite: SqliteLike): void {
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
}

function enableWal(sqlite: SqliteLike): void {
  sqlite.pragma('journal_mode = WAL');
}

function applyOpenPragmas(sqlite: SqliteLike): void {
  pragmasBeforeTheDecision(sqlite);
  enableWal(sqlite);
}

export function openFixture(name: string, build: boolean): Fixture {
  try {
    deleteDatabaseSync(name);
  } catch {
    // Nothing to delete — the normal case.
  }
  const db = openDatabaseSync(name);
  const sqlite = new ExpoSqliteShim(db);
  applyOpenPragmas(sqlite);
  if (build) buildLibrary(sqlite);
  return {
    sqlite,
    db,
    name,
    dispose() {
      try {
        db.closeSync();
      } catch {
        // Already closed.
      }
      try {
        deleteDatabaseSync(name);
      } catch {
        // Nothing to delete.
      }
    },
  };
}

// ─── Scenario 1: cold start ─────────────────────────────

interface SongListRow {
  id: string;
  name: string;
  created_at: number;
}

function readAllSongs(sqlite: SqliteLike): SongListRow[] {
  return sqlite.prepare('SELECT * FROM songs').all() as SongListRow[];
}

/** `listSongs`'s default path: read every row, then order in JS (songs.ts:308-317). */
function readFirstScreen(sqlite: SqliteLike): void {
  const rows = readAllSongs(sqlite);
  rows.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  sqlite.prepare('SELECT * FROM playlists').all();
  sqlite
    .prepare('SELECT playlist_id, count(*) AS n FROM playlist_songs GROUP BY playlist_id')
    .all();
}

function sortByNameLikeCore(rows: SongListRow[]): void {
  const collator = new Intl.Collator('zh-CN');
  rows.sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1));
}

/**
 * The DB half of a cold start, twice: a phone opening lark for the first time
 * (empty database, whole migration chain) and a phone opening it on day two
 * (2,000 songs, chain already applied, a first screen to fill).
 *
 * Judged by max over 5 rounds (§3.2a). It IS only the DB half — process start
 * and bundle load are not measurable from in here and belong to N2/N3.
 */
export function measureColdStarts(): WorkloadRow[] {
  const rows: WorkloadRow[] = [];
  const freshName = 'workload-cold.db';

  let opened: SQLiteDatabase | null = null;
  const fresh = measureColdStart(
    'fresh install: open + 0001→0003 + assertCurrentSchema + clear pending',
    () => {
      const db = openDatabaseSync(freshName);
      opened = db;
      const sqlite = new ExpoSqliteShim(db);
      pragmasBeforeTheDecision(sqlite);
      sqlite.pragma('user_version', { simple: true });
      enableWal(sqlite);
      applyForwardMigrations(sqlite, 0, LATEST_KNOWN_VERSION);
      assertCurrentSchema(sqlite, freshName);
      clearAudioMigrationPending(sqlite);
    },
    {
      before: () => {
        try {
          deleteDatabaseSync(freshName);
        } catch {
          // Nothing to delete.
        }
      },
      after: () => {
        opened?.closeSync();
        opened = null;
      },
    },
  );
  try {
    deleteDatabaseSync(freshName);
  } catch {
    // Nothing to delete.
  }
  rows.push({
    scenario: 'cold start',
    timing: fresh,
    ok: judge(fresh.max < COLD_START_BUDGET_MS),
    note: `max < ${COLD_START_BUDGET_MS}ms`,
    size: null,
  });

  const fixture = openFixture('workload-warm.db', true);
  try {
    fixture.db.closeSync();

    let handle: SQLiteDatabase | null = null;
    const warm = measureColdStart(
      `existing ${LIBRARY_SONGS}-song library: open + version check + first screen`,
      () => {
        const db = openDatabaseSync(fixture.name);
        handle = db;
        const sqlite = new ExpoSqliteShim(db);
        pragmasBeforeTheDecision(sqlite);
        const version = sqlite.pragma('user_version', { simple: true });
        if (version !== LATEST_KNOWN_VERSION) throw new Error(`user_version ${String(version)}`);
        enableWal(sqlite);
        assertCurrentSchema(sqlite, fixture.name);
        readFirstScreen(sqlite);
      },
      {
        after: () => {
          handle?.closeSync();
          handle = null;
        },
      },
    );
    rows.push({
      scenario: 'cold start',
      timing: warm,
      ok: judge(warm.max < COLD_START_BUDGET_MS),
      note: `max < ${COLD_START_BUDGET_MS}ms`,
      size: null,
    });

    // The same screen sorted by NAME instead of by date. `listSongs` puts that
    // one through `Intl.Collator('zh-CN')` (songs.ts:75,314) — the piece of it
    // least certain to exist on Hermes, which is why it gets its own row here
    // and a presence probe in criterion 21.
    const reopened = openDatabaseSync(fixture.name);
    try {
      const sqlite = new ExpoSqliteShim(reopened);
      applyOpenPragmas(sqlite);
      const collator = measure(
        `${LIBRARY_SONGS} rows sorted by name through Intl.Collator('zh-CN')`,
        () => sortByNameLikeCore(readAllSongs(sqlite)),
      );
      rows.push({
        scenario: 'cold start',
        timing: collator,
        ok: null,
        note: 'evidence, not a threshold — part of the screen above',
        size: null,
      });
    } finally {
      reopened.closeSync();
    }
  } finally {
    fixture.dispose();
  }

  return rows;
}

// ─── Scenario 2: login backfill ─────────────────────────

/**
 * One backfilled song, statement for statement (backfill.ts:130-171 →
 * changes.ts:43-70): has it been published, whose device am I, mint a cid,
 * serialize, measure the wire envelope, append.
 */
function backfillOne(sqlite: SqliteLike, row: SongRow): void {
  sqlite
    .prepare(
      "SELECT 1 FROM sync_changes WHERE entity_type = ? AND entity_id = ? AND op = 'create' LIMIT 1",
    )
    .get('song', row.id);
  const device = sqlite.prepare("SELECT value FROM local_metadata WHERE key='device_uuid'").get() as
    | { value: string }
    | undefined;
  const cid = randomUUID();
  const payload = {
    name: row.name,
    artist: row.artist,
    source_url: null,
    source_provider: 'bilibili',
    source_key: `key:${row.id}`,
    lyrics_offset: 0,
    duration: 200,
    created_at_ms: row.created_at,
    updated_at_ms: row.updated_at,
    lww_counter: 0,
  };
  const payloadJson = JSON.stringify(payload);
  // `assertChangeFits` measures the WHOLE envelope, not the payload
  // (changes.ts:77-96), and `Buffer.byteLength` is a port on this side.
  const wireBytes = encoder.encode(
    JSON.stringify({
      client_change_id: cid,
      entity_type: 'song',
      entity_id: row.id,
      op: 'create',
      payload,
      client_local_seq: Number.MAX_SAFE_INTEGER,
      client_created_at: row.updated_at,
    }),
  ).length;
  if (wireBytes <= 0) throw new Error('empty envelope');
  sqlite
    .prepare(
      `INSERT INTO sync_changes
         (device_id, entity_type, entity_id, op, payload, created_at, client_change_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(device?.value ?? '', 'song', row.id, 'create', payloadJson, row.updated_at, cid);
}

/**
 * The whole 2,000-song backfill in one transaction, then the same work in
 * segments.
 *
 * Production runs it as ONE transaction inside the login installer, so the
 * single-shot number is the honest "what happens today". The segmented numbers
 * answer the actual question: how large a chunk can a phone commit without
 * dropping frames.
 */
export function measureBackfill(): WorkloadRow[] {
  const rows: WorkloadRow[] = [];
  const fixture = openFixture('workload-backfill.db', true);
  try {
    const { sqlite } = fixture;
    const reset = (): void => {
      sqlite.prepare("DELETE FROM sync_changes WHERE op = 'create'").run();
    };
    const readAll = (): SongRow[] =>
      sqlite
        .prepare(
          'SELECT id, name, artist, created_at, updated_at FROM songs ORDER BY created_at, id',
        )
        .all() as SongRow[];

    const whole = measure(
      `whole backfill: ${LIBRARY_SONGS} songs in one transaction (production shape)`,
      () => {
        sqlite
          .transaction(() => {
            for (const row of readAll()) backfillOne(sqlite, row);
          })
          .immediate();
      },
      { warmup: 1, rounds: 5, before: reset },
    );
    reset();
    rows.push({
      scenario: 'login backfill',
      timing: whole,
      ok: null,
      note: 'the JS thread is blocked for this whole time — the reason segments exist',
      size: LIBRARY_SONGS,
    });

    // Segments, each its own transaction: a chunked backfill that kept one
    // transaction open across chunks would hold the write lock for the whole
    // run and gain nothing.
    const all = readAll();
    for (const size of BACKFILL_SEGMENTS) {
      const samples: number[] = [];
      let done = 0;
      let cursor = 0;
      while (done < WARMUP_ROUNDS + MEASURED_ROUNDS) {
        if (cursor + size > all.length) {
          reset();
          cursor = 0;
        }
        const slice = all.slice(cursor, cursor + size);
        cursor += size;
        const started = now();
        sqlite
          .transaction(() => {
            for (const row of slice) backfillOne(sqlite, row);
          })
          .immediate();
        const elapsed = now() - started;
        done += 1;
        if (done > WARMUP_ROUNDS) samples.push(elapsed);
      }
      reset();
      const timing = summarize(`segment of ${size} songs`, samples);
      rows.push({
        scenario: 'login backfill',
        timing,
        ok: judge(timing.p95 <= FOREGROUND_BUDGET_MS),
        note: `p95 ≤ ${FOREGROUND_BUDGET_MS}ms`,
        size,
      });
    }
  } finally {
    fixture.dispose();
  }
  return rows;
}

// ─── Scenario 3: one foreground sync round (apply) ──────

/**
 * One inbound song put that WINS against an existing row — the busiest of
 * `applySongPut`'s paths and most of what a real pull is made of
 * (apply.ts:254-300).
 *
 * Statement for statement: observe the remote clock (two reads, then the writes
 * it decides on), is-this-my-own-echo, is-it-buried, the row's key, the
 * before-snapshot conflict detection needs, the update.
 */
function applyOne(sqlite: SqliteLike, index: number, stampMs: number): void {
  const id = fakeUuid(index);
  const wire = JSON.stringify({
    client_change_id: fakeUuid(700_000 + index),
    entity_type: 'song',
    entity_id: id,
    op: 'update',
    payload: {
      name: `歌曲 ${index} (peer)`,
      artist: `艺人 ${index % 97}`,
      source_url: null,
      source_provider: 'bilibili',
      source_key: `key:${id}`,
      lyrics_offset: 0,
      duration: 210,
      created_at_ms: 1_700_000_000_000,
      updated_at_ms: stampMs,
      lww_counter: 0,
    },
    device_id: 'peer-device',
  });
  const change = JSON.parse(wire) as {
    client_change_id: string;
    payload: Record<string, unknown>;
    device_id: string;
  };

  // observeRemoteLww (hlc.ts:94): readInt ×2, then writeInt ×2 when the remote
  // key is newer. Every round here IS newer, on purpose — the write path taken
  // every time is the worst case, and the worst case is what a threshold is for.
  const readInt = (key: string): number | null => {
    const row = sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row === undefined ? null : Number(row.value);
  };
  const writeInt = (key: string, value: number): void => {
    sqlite
      .prepare(
        `INSERT INTO local_metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, String(value));
  };
  const lastMs = readInt('sync_hlc_last_ms') ?? 0;
  readInt('sync_hlc_last_counter');
  if (stampMs > lastMs) {
    writeInt('sync_hlc_last_ms', stampMs);
    writeInt('sync_hlc_last_counter', 0);
  }

  sqlite
    .prepare('SELECT 1 FROM sync_changes WHERE client_change_id = ? AND synced_at IS NOT NULL')
    .get(change.client_change_id);
  sqlite
    .prepare(
      `SELECT updated_at, lww_counter, device_id, deleted_at FROM sync_tombstones
       WHERE entity_type = ? AND entity_id = ?`,
    )
    .get('song', id);
  sqlite.prepare('SELECT updated_at, lww_counter, device_id FROM songs WHERE id = ?').get(id);
  sqlite
    .prepare(
      `SELECT name, artist, source_url, source_provider, source_key, file_origin,
              lyrics_offset, duration, created_at, updated_at, lww_counter, device_id
       FROM songs WHERE id = ?`,
    )
    .get(id);

  const payload = change.payload;
  sqlite
    .prepare(
      `UPDATE songs SET name = ?, artist = ?, source_url = ?, source_provider = ?,
         source_key = ?, lyrics_offset = ?, duration = ?, updated_at = ?,
         lww_counter = ?, device_id = ?
       WHERE id = ?`,
    )
    .run(
      payload.name,
      payload.artist,
      payload.source_url,
      payload.source_provider,
      payload.source_key,
      payload.lyrics_offset,
      payload.duration,
      payload.updated_at_ms,
      payload.lww_counter,
      change.device_id,
      id,
    );
}

/**
 * A pull batch applied, at the production size and smaller.
 *
 * No restore between rounds: each round updates the same songs with a newer
 * stamp, which is what a device that has been away actually receives.
 */
export function measureApply(): WorkloadRow[] {
  const rows: WorkloadRow[] = [];
  const fixture = openFixture('workload-apply.db', true);
  try {
    const { sqlite } = fixture;
    let stamp = 1_800_000_000_000;

    const runBatch = (size: number): void => {
      stamp += 1_000;
      const at = stamp;
      sqlite
        .transaction(() => {
          for (let i = 0; i < size; i += 1) applyOne(sqlite, i, at + i);
          // The round's cursor advance — once per batch, not per change
          // (engine.ts:100-128: a read, then the upsert).
          sqlite
            .prepare(
              'SELECT pulled_seq, pushed_seq FROM sync_cursor WHERE server_id = ? AND workspace_id = ?',
            )
            .get(SERVER_ID, WORKSPACE_ID);
          sqlite
            .prepare(
              `INSERT INTO sync_cursor (server_id, workspace_id, pulled_seq, pushed_seq, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(server_id, workspace_id) DO UPDATE SET
                 pulled_seq = excluded.pulled_seq,
                 pushed_seq = excluded.pushed_seq,
                 updated_at = excluded.updated_at`,
            )
            .run(SERVER_ID, WORKSPACE_ID, at, 0, at);
        })
        .immediate();
    };

    for (const size of APPLY_BATCHES) {
      const timing = measure(
        size === SYNC_PULL_LIMIT
          ? `batch of ${size} changes (SYNC_PULL_LIMIT — production)`
          : `batch of ${size} changes`,
        () => runBatch(size),
      );
      rows.push({
        scenario: 'foreground sync round',
        timing,
        ok: judge(timing.p95 <= FOREGROUND_BUDGET_MS),
        note: `p95 ≤ ${FOREGROUND_BUDGET_MS}ms`,
        size,
      });
    }

    const stress = measure(
      `batch of ${APPLY_STRESS_BATCH} changes (STRESS — above the production cap)`,
      () => runBatch(APPLY_STRESS_BATCH),
      { warmup: 1, rounds: 5 },
    );
    rows.push({
      scenario: 'foreground sync round',
      timing: stress,
      ok: null,
      note: 'stress only — the server caps a pull at 1000 and lark asks for 500',
      size: APPLY_STRESS_BATCH,
    });
  } finally {
    fixture.dispose();
  }
  return rows;
}

/**
 * The largest batch whose p95 fits the foreground budget — the number criterion
 * 18 exists to produce when the production size does not fit.
 */
export function derivedBatchSize(rows: readonly WorkloadRow[], scenario: string): number | null {
  const fitting = rows
    .filter((r) => r.scenario === scenario && r.ok === true && r.size !== null)
    .map((r) => r.size as number);
  return fitting.length === 0 ? null : Math.max(...fitting);
}
