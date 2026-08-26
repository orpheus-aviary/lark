// Sync's FILE half, across a real process boundary (v0.2 T6, §6).
//
// The dual suite proves the metadata converges; this one proves the things a
// single process cannot show:
//
//   a peer's lyrics land as a real file in THIS nest,
//   a remote delete moves irreplaceable audio into `recovered-songs/` instead
//     of removing it, and the count survives a restart,
//   a journal row that outlived a crash is drained at BOOT, before recovery,
//   a permanently failed row can be retried, and given up on, from outside.
//
// The shape: device A is this process (core, in memory, its own nest), device
// B is a REAL daemon child on its own nest, and one in-process skybridge
// server sits between them. `LARK_NEST_DIR` is process-global, which is
// exactly why B has to be a child — and why writes into B's database (to plant
// crash residue) go through raw sqlite on its file rather than through core.
//
// Gating is the same as the dual suite's: filename, plus a server that is
// resolved at run time and skipped when absent.

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FileEffectRuntime,
  type LarkDatabase,
  type PortableDb,
  createDatabase,
  createSong,
  deleteSong,
  ensureDeviceUuid,
  listSongs,
  markBackfillDone,
  paths,
  readLocalDeviceUuid,
  readSkybridgeDeviceId,
  rebaseLocalKeys,
  runFullBackfillInTx,
  runSync,
  setServerTimeOffset,
  setSkybridgeDeviceId,
  stampDeviceIdInTx,
  writeBindingInTx,
} from '@lark/core';
import { fixturePath } from '@lark/core/testing';
import { SYNC_WORKSPACE_NAME, SYNC_WORKSPACE_TOOL } from '@lark/shared';
import { CLIENT_VERSION, createSkybridgeClient, login } from '@orpheus-aviary/skybridge-client';
import BetterSqlite3 from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type RunningSkybridgeServer,
  type SkybridgeServerModule,
  resolveSkybridgeServer,
  startSkybridgeServer,
} from '../testing/skybridge-server.js';

const serverModule = await resolveSkybridgeServer();

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOT_CHILD = join(HERE, '../../dist/testing/boot-child.js');
// A TRACKED fixture: the spike's 30-minute file this used to point at is
// gitignored, and since T6 it is m4a — an import fixture that only exists after
// someone ran a spike recipe is a suite that fails for the wrong reason.
const FIXTURE_AUDIO = fixturePath('tone-1s.m4a');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Device B: a real daemon on its own nest ───────────

interface Daemon {
  nest: string;
  larkDir: string;
  baseUrl: string;
  token: string;
  child: ChildProcess;
  logs: () => string;
}

/**
 * Start `boot-child` on `nest` and wait for the line it prints when listening.
 *
 * Port 0 — the child picks one and says which, so two suites can run at once.
 */
async function startDaemon(nest: string): Promise<Daemon> {
  const child = spawn(process.execPath, [BOOT_CHILD], {
    env: { ...process.env, LARK_NEST_DIR: nest },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const deadline = Date.now() + 30_000;
  let port: number | null = null;
  while (port === null && Date.now() < deadline) {
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match) port = Number(match[1]);
    else await sleep(100);
  }
  if (port === null) throw new Error(`daemon never listened:\n${output}`);

  const larkDir = join(nest, 'lark');
  const token = readFileSync(join(larkDir, 'daemon-token'), 'utf-8').trim();
  return {
    nest,
    larkDir,
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    child,
    logs: () => output,
  };
}

async function stopDaemon(daemon: Daemon): Promise<void> {
  if (daemon.child.exitCode !== null) return;
  daemon.child.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (daemon.child.exitCode === null && Date.now() < deadline) await sleep(100);
  if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
}

interface ApiResult<T> {
  status: number;
  data: T | undefined;
  error_code?: string;
}

async function api<T>(
  daemon: Daemon,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { data?: T; error_code?: string };
  return {
    status: res.status,
    data: json.data,
    ...(json.error_code === undefined ? {} : { error_code: json.error_code }),
  };
}

/** Everything the daemon logged, across pino-roll's numbered files. */
function readLogs(daemon: Daemon): string {
  const dir = join(daemon.larkDir, 'logs');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((name) => name.startsWith('lark.log'))
    .sort()
    .map((name) => readFileSync(join(dir, name), 'utf-8'))
    .join('\n');
}

/**
 * Where B's library actually is (N7c).
 *
 * B logs in, which BINDS its library — and a bound library moves under
 * `libraries/<id>/` at the next boot, which this suite performs. Asking the
 * nest rather than assuming the root is the difference between opening the
 * library and creating an empty one beside it.
 *
 * `activeWorkspaceIn` and not `resolveActiveWorkspace`: this process is device
 * A and has a nest of its own.
 */
function libraryDirOf(daemon: Daemon): string {
  return paths.activeWorkspaceRootIn(daemon.larkDir);
}

/** B's own database, opened directly — only ever while its daemon is stopped. */
function openBDatabase(daemon: Daemon): BetterSqlite3.Database {
  return new BetterSqlite3(join(libraryDirOf(daemon), 'songs.db'));
}

// ─── Device A: core, in this process ───────────────────

interface LocalDevice {
  db: LarkDatabase;
  store: PortableDb;
  sqlite: BetterSqlite3.Database;
  client: ReturnType<typeof createSkybridgeClient>;
  serverId: string;
  workspaceId: string;
  deviceId: string;
  localUuid: string;
}

async function createLocalDevice(
  server: RunningSkybridgeServer,
  email: string,
  password: string,
): Promise<LocalDevice> {
  const auth = await login(server.baseUrl, email, password);
  const { db, sqlite, portable: store } = createDatabase({ dbPath: ':memory:' });
  ensureDeviceUuid(sqlite);
  const localUuid = readLocalDeviceUuid(sqlite);

  const device = await createSkybridgeClient({ authContext: auth }).registerDevice({
    name: 'e2e-files-A',
    appVersion: 'lark 0.2.0',
    clientVersion: CLIENT_VERSION,
  });
  const client = createSkybridgeClient({ authContext: auth, deviceId: device.id });
  const workspace = await client.ensureWorkspace(SYNC_WORKSPACE_TOOL, SYNC_WORKSPACE_NAME);

  sqlite
    .transaction(() => {
      writeBindingInTx(sqlite, {
        server_id: server.baseUrl,
        user_id: auth.user.id,
        workspace_id: workspace.id,
        schema_version: workspace.schemaVersion,
      });
      setServerTimeOffset(sqlite, 0);
      runFullBackfillInTx(sqlite, new Map());
      rebaseLocalKeys(sqlite, Date.now());
      stampDeviceIdInTx(sqlite, {
        deviceId: device.id,
        previousId: readSkybridgeDeviceId(sqlite),
        localUuid,
      });
      setSkybridgeDeviceId(sqlite, device.id);
      markBackfillDone(sqlite);
    })
    .immediate();

  return {
    db,
    store,
    sqlite,
    client,
    serverId: server.baseUrl,
    workspaceId: workspace.id,
    deviceId: device.id,
    localUuid,
  };
}

const syncA = (a: LocalDevice) =>
  runSync({
    sqlite: a.sqlite,
    client: a.client,
    serverId: a.serverId,
    workspaceId: a.workspaceId,
  });

/** Emit a metadata op the way a lyrics write would, without a download. */
function emitSetLyrics(a: LocalDevice, songId: string, lrc: string): void {
  a.sqlite
    .prepare(
      `INSERT INTO sync_changes (client_change_id, entity_type, entity_id, op, payload, local_seq, created_at, device_id)
       VALUES (?, 'song', ?, 'set_lyrics', ?, (SELECT COALESCE(MAX(local_seq), 0) + 1 FROM sync_changes), ?, ?)`,
    )
    .run(randomUUID(), songId, JSON.stringify({ lrc }), Date.now(), a.localUuid);
}

// ─── The suite ─────────────────────────────────────────

describe.skipIf(serverModule === null)('sync across a real process boundary', () => {
  let server: RunningSkybridgeServer;
  let a: LocalDevice;
  let b: Daemon;
  let nestA: string;
  let nestB: string;

  const email = 'files@lark.test';
  const password = 'correct-horse-battery';

  beforeAll(async () => {
    const sb = serverModule as SkybridgeServerModule;
    server = await startSkybridgeServer(sb);
    await sb.createUser(server.db, { email, password });

    // A's nest exists only so core's path helpers have somewhere to point;
    // its library itself is in memory.
    nestA = mkdtempSync(join(tmpdir(), 'lark-e2e-a-'));
    mkdirSync(join(nestA, 'lark'), { recursive: true });
    process.env.LARK_NEST_DIR = nestA;

    nestB = mkdtempSync(join(tmpdir(), 'lark-e2e-b-'));
    b = await startDaemon(nestB);
    const loggedIn = await api(b, 'POST', '/sync/login', {
      server_url: server.baseUrl,
      email,
      password,
    });
    expect(loggedIn.status, `B could not log in: ${loggedIn.error_code ?? ''}`).toBe(200);

    a = await createLocalDevice(server, email, password);
  }, 120_000);

  afterAll(async () => {
    a?.sqlite.close();
    if (b) await stopDaemon(b);
    await server?.close();
    for (const dir of [nestA, nestB]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** One round on B, through the same coalescer the background triggers use. */
  const syncB = () => api(b, 'POST', '/sync/run');

  it("writes a peer's lyrics to disk as a real file", async () => {
    const song = createSong(a.store, { name: '有词的歌', artist: '甲' });
    emitSetLyrics(a, song.id, '[00:01.00]跨设备的歌词');
    await syncA(a);

    await syncB();

    const lyrics = join(libraryDirOf(b), 'songs', song.id, 'lyrics.lrc');
    expect(existsSync(lyrics), `${lyrics} should exist`).toBe(true);
    expect(readFileSync(lyrics, 'utf-8')).toContain('跨设备的歌词');
    // Drained, not merely queued: nothing is left owing after the round.
    const status = await api<{ pending_file_ops: number }>(b, 'GET', '/sync/status');
    expect(status.data?.pending_file_ops).toBe(0);
  });

  // §3.6 / R4-3: audio this device cannot fetch again is irreplaceable, so a
  // peer's delete moves it aside instead of removing it — and the fact has to
  // survive a restart, or nobody would ever look in that directory.
  it('quarantines an imported song a peer deleted, and still says so after a restart', async () => {
    const imported = await api<{ imported: { song_id: string }[] }>(b, 'POST', '/songs/import', {
      file_paths: [FIXTURE_AUDIO],
    });
    const songId = imported.data?.imported[0]?.song_id as string;
    expect(songId, 'the fixture should import').toBeDefined();

    await syncB();
    await syncA(a);
    expect(
      listSongs(a.db, a.sqlite).songs.find((song) => song.id === songId),
      'A should have received the imported song',
    ).toBeDefined();

    await deleteSong(a.store, songId, {
      fileOps: new FileEffectRuntime({ sqlite: a.sqlite }),
    });
    await syncA(a);
    await syncB();

    const quarantine = join(libraryDirOf(b), 'recovered-songs');
    const moved = readdirSync(quarantine).filter((name) => name.startsWith(songId));
    expect(moved, 'the audio should have been moved aside').toHaveLength(1);
    expect(existsSync(join(quarantine, moved[0] as string, 'song.m4a'))).toBe(true);
    expect(existsSync(join(libraryDirOf(b), 'songs', songId, 'song.m4a'))).toBe(false);

    const before = await api<{ quarantined_count: number }>(b, 'GET', '/sync/status');
    expect(before.data?.quarantined_count).toBeGreaterThan(0);

    await stopDaemon(b);
    b = await startDaemon(nestB);
    const after = await api<{ quarantined_count: number }>(b, 'GET', '/sync/status');
    expect(after.data?.quarantined_count).toBe(before.data?.quarantined_count);
  });

  // ⑪: the journal exists because the database commit and the file change are
  // not one operation. A row that outlived the process is drained at boot —
  // and before recovery, which must not judge a directory the journal owns.
  it('drains a journal row left by a crash at the next boot, before recovery', async () => {
    const song = createSong(a.store, { name: '崩溃前写好的', artist: '甲' });
    await syncA(a);
    await syncB();
    await stopDaemon(b);

    const db = openBDatabase(b);
    db.prepare(
      `INSERT INTO sync_file_ops (kind, song_id, arg, created_at, attempts)
       VALUES ('write_lyrics', ?, ?, ?, 0)`,
    ).run(
      song.id,
      JSON.stringify({ op_uuid: randomUUID(), inline: '[00:02.00]崩溃残留' }),
      Date.now(),
    );
    db.close();

    b = await startDaemon(nestB);

    const lyrics = join(libraryDirOf(b), 'songs', song.id, 'lyrics.lrc');
    expect(readFileSync(lyrics, 'utf-8')).toContain('崩溃残留');
    // The ORDER is the invariant, not just the outcome (§3.6). It is read from
    // the log FILE: the daemon prints only its listen line to stdout, and
    // pino-roll writes `lark.log.1`, never a bare `lark.log` (M4 lesson).
    const logs = readLogs(b);
    const drained = logs.indexOf('sync file journal drained');
    const recovered = logs.indexOf('songs store recovered');
    expect(drained).toBeGreaterThanOrEqual(0);
    expect(recovered).toBeGreaterThan(drained);
  });

  // R5-P1-1: a file effect that gave up needs a way out that is not a database
  // editor — and discard, which destroys the effect for good, is only offered
  // for a row that has actually given up.
  it('lists a failed file op, gives one up, and refuses to give up one that is trying again', async () => {
    await stopDaemon(b);
    // A failure the executor really produces: the song's directory is a plain
    // FILE, so the lyrics write cannot create it. (Planting a `staging` arg
    // would not do — v0.2 has no producer for that branch and ignores it.)
    const blocked = [randomUUID(), randomUUID()];
    mkdirSync(join(libraryDirOf(b), 'songs'), { recursive: true });
    for (const id of blocked) writeFileSync(join(libraryDirOf(b), 'songs', id), 'not a directory');

    const db = openBDatabase(b);
    for (const id of blocked) {
      db.prepare(
        `INSERT INTO sync_file_ops (kind, song_id, arg, created_at, attempts, last_error)
         VALUES ('write_lyrics', ?, ?, ?, 5, 'ENOTDIR: the song directory is a file')`,
      ).run(
        id,
        JSON.stringify({ op_uuid: randomUUID(), inline: '[00:03.00]写不进去' }),
        Date.now(),
      );
    }
    db.close();
    b = await startDaemon(nestB);

    const listed = await api<{ file_ops: { id: number; kind: string; song_id: string }[] }>(
      b,
      'GET',
      '/sync/file-ops?state=failed',
    );
    expect(listed.data?.file_ops).toHaveLength(2);
    const rows = listed.data?.file_ops ?? [];
    expect(rows[0]?.kind).toBe('write_lyrics');
    const first = rows.find((row) => row.song_id === blocked[0])?.id as number;
    const second = rows.find((row) => row.song_id === blocked[1])?.id as number;

    // ① give up on one: the row goes, and the decision stays on the record.
    const deadBefore = await api<{ dead_letters: { out: number } }>(b, 'GET', '/sync/status');
    const discarded = await api(b, 'POST', '/sync/file-ops/discard', { id: first });
    expect(discarded.status).toBe(200);
    const deadAfter = await api<{ dead_letters: { out: number } }>(b, 'GET', '/sync/status');
    expect(deadAfter.data?.dead_letters.out).toBe((deadBefore.data?.dead_letters.out ?? 0) + 1);

    // ② retry the other: it fails again (the directory is still a file), and
    // that resets its attempt count — so it is no longer a row that has given
    // up, and discard refuses it rather than racing the executor.
    const retried = await api<{ executed: number; failed: number }>(
      b,
      'POST',
      '/sync/file-ops/retry',
      { id: second },
    );
    expect(retried.data?.failed).toBe(1);

    const refused = await api(b, 'POST', '/sync/file-ops/discard', { id: second });
    expect(refused.status).toBe(409);
    expect(refused.error_code).toBe('FILE_OP_BUSY');

    const remaining = await api<{ file_ops: { id: number }[] }>(
      b,
      'GET',
      '/sync/file-ops?state=pending',
    );
    expect(remaining.data?.file_ops.map((row) => row.id)).toContain(second);
  });
});
