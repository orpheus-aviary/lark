// Lifecycle integration tests. These MUST run in a child process: the things
// under test are `process.exit` codes, signal delivery, PID contention and
// what survives on disk afterwards — none of which can be observed from inside
// the process that owns them.
//
// The child is the built `dist/testing/boot-child.js` (hence the build
// prerequisite on `just test-daemon`), pointed at a throwaway `LARK_NEST_DIR`
// and an ephemeral port.

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type WriterLock, WriterLockBusyError, acquireWriterLock } from '@lark/core';
import { readToneMp3, seedGoLegacyDb } from '@lark/core/testing';
import { SYNC_FILE_OP_MAX_ATTEMPTS, type StatusData } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CHILD_ENTRY = fileURLToPath(new URL('../dist/testing/boot-child.js', import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface DaemonChild {
  readonly proc: ChildProcess;
  stdout(): string;
  stderr(): string;
  waitForPort(): Promise<number>;
  waitForExit(): Promise<ExitInfo>;
}

let nest: string;
const children: DaemonChild[] = [];

const larkDir = (): string => join(nest, 'lark');
const pidPath = (): string => join(larkDir(), 'daemon.pid');
const tokenPath = (): string => join(larkDir(), 'daemon-token');
const configPath = (): string => join(larkDir(), 'lark_config.toml');
const dbPath = (): string => join(larkDir(), 'songs.db');

function spawnDaemon(env: Record<string, string> = {}): DaemonChild {
  const proc = spawn(process.execPath, [CHILD_ENTRY], {
    env: { ...process.env, LARK_NEST_DIR: nest, LARK_DAEMON_TEST_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout?.on('data', (d) => {
    out += String(d);
  });
  proc.stderr?.on('data', (d) => {
    err += String(d);
  });
  const exited = new Promise<ExitInfo>((resolve) => {
    proc.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const child: DaemonChild = {
    proc,
    stdout: () => out,
    stderr: () => err,
    async waitForPort() {
      let port = 0;
      await vi.waitFor(
        () => {
          const match = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
          expect(match, `daemon did not report a port. stderr: ${err}`).not.toBeNull();
          port = Number((match as RegExpMatchArray)[1]);
        },
        { timeout: 15_000, interval: 25 },
      );
      return port;
    },
    waitForExit: () => exited,
  };
  children.push(child);
  return child;
}

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-boot-'));
  mkdirSync(larkDir(), { recursive: true });
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.proc.exitCode === null && child.proc.signalCode === null) {
      child.proc.kill('SIGKILL');
      await child.waitForExit();
    }
  }
  rmSync(nest, { recursive: true, force: true });
});

describe('boot', () => {
  it('rotates the token, answers /status, and shuts down cleanly on SIGTERM', async () => {
    writeFileSync(tokenPath(), 'token-from-a-previous-boot', { mode: 0o600 });

    const child = spawnDaemon();
    const port = await child.waitForPort();

    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { pid: number } };
    expect(body.data.pid).toBe(child.proc.pid);

    // Token ROTATION (M2-2): the observation point is after the listen line, so
    // this proves every boot mints a fresh token — it deliberately does not
    // claim to cover the "/status reachable ⇒ token published" ordering, which
    // holds by the execution model (a synchronous publish in listen's
    // continuation) and is documented in boot.ts, not asserted here.
    const published = readFileSync(tokenPath(), 'utf-8');
    expect(published).not.toBe('token-from-a-previous-boot');
    expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(pidPath(), 'utf-8')).toBe(String(child.proc.pid));

    child.proc.kill('SIGTERM');
    expect(await child.waitForExit()).toMatchObject({ code: 0 });

    expect(existsSync(pidPath())).toBe(false);
    // Shutdown deliberately keeps the token file (M2-3).
    expect(readFileSync(tokenPath(), 'utf-8')).toBe(published);
  });

  it('refuses a second instance and leaves the running daemon untouched', async () => {
    const first = spawnDaemon();
    await first.waitForPort();
    const tokenBefore = readFileSync(tokenPath(), 'utf-8');

    const second = spawnDaemon();
    const exit = await second.waitForExit();
    expect(exit.code).toBe(1);
    expect(second.stderr()).toContain('already running');

    expect(readFileSync(tokenPath(), 'utf-8')).toBe(tokenBefore);
    expect(readFileSync(pidPath(), 'utf-8')).toBe(String(first.proc.pid));
  });

  it('ends an open SSE stream on SIGTERM instead of hanging on it', async () => {
    const child = spawnDaemon();
    const port = await child.waitForPort();
    const token = readFileSync(tokenPath(), 'utf-8');

    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);

    const started = Date.now();
    child.proc.kill('SIGTERM');
    expect(await child.waitForExit()).toMatchObject({ code: 0 });
    expect(Date.now() - started).toBeLessThan(2000);
    controller.abort();
    expect(existsSync(pidPath())).toBe(false);
  });

  it('refuses to start on a Go-era library and cleans up its lock', async () => {
    seedGoLegacyDb(join(larkDir(), 'songs.db'));

    const child = spawnDaemon();
    const exit = await child.waitForExit();

    expect(exit.code).toBe(1);
    // 0.3 deleted the importer but kept the recognition, so the refusal has to
    // send the user somewhere: the 0.2.x that can still do it.
    expect(child.stderr()).toContain('migrate-go');
    expect(child.stderr()).toContain('0.2.x');
    expect(existsSync(pidPath())).toBe(false);
    expect(existsSync(tokenPath())).toBe(false);
  });

  it('honours a signal that lands BEFORE listen: exit 0, no token published', async () => {
    const child = spawnDaemon({ LARK_TEST_STALL_BEFORE_LISTEN_MS: '2000' });

    // The lock exists ⇒ boot is past `acquireDaemonLock`; the signal handlers
    // go up on the very next statement, so a short pause makes the delivery
    // point deterministic.
    await vi.waitFor(() => expect(existsSync(pidPath())).toBe(true), { timeout: 10_000 });
    await sleep(150);
    child.proc.kill('SIGTERM');

    expect(await child.waitForExit()).toMatchObject({ code: 0 });
    expect(existsSync(tokenPath())).toBe(false);
    expect(existsSync(pidPath())).toBe(false);
  });

  it('exits 1 through requestFatal, releasing the lock', async () => {
    const child = spawnDaemon({ LARK_TEST_FATAL_AFTER_MS: '150' });
    await child.waitForPort();

    expect(await child.waitForExit()).toMatchObject({ code: 1 });
    expect(existsSync(pidPath())).toBe(false);
    expect(existsSync(tokenPath())).toBe(true); // published before the fatal
  });
});

// The whole 0.3.0 boot, end to end (§3.2-3; 判据 15, 18): a library that still
// owes the mp3 → m4a conversion comes up REACHABLE, refuses the library, runs
// the pass, and only then serves. Only a child process can show this — the
// phases are ordered around `listen()`, and from inside the process they are
// just function calls in the order the source already claims.
describe('boot — the audio migration', () => {
  /**
   * Build the state 0003 leaves behind: schema v3, flag set, and a song.
   *
   * `audio: 'file'` writes the mp3 where 0.2.x kept it. `audio: 'crashed'`
   * writes what a landing that died mid-replace left instead — a v1 manifest
   * (no `version` key) and its backup, with NO audio file at all. Only boot's
   * legacy recovery can turn the second one back into an mp3, which is the
   * whole point of it running before the scan (§3.2-11).
   */
  async function seedPendingLibrary(audio: 'file' | 'crashed' = 'file'): Promise<string> {
    const core = await import('@lark/core');
    vi.stubEnv('LARK_NEST_DIR', nest);
    const { sqlite, portable: store } = core.createDatabase({ dbPath: dbPath() });
    const id = randomUUID();
    try {
      sqlite
        .transaction(() => {
          core.createFileBackedSongInTx(store, {
            id,
            name: '迁移前的歌',
            file_origin: 'downloaded',
            source_provider: 'bilibili',
            source_key: `BV1x${id.slice(0, 4)}:9`,
          });
        })
        .immediate();
      sqlite
        .prepare("UPDATE local_metadata SET value = '1' WHERE key = 'audio_migration_pending'")
        .run();
    } finally {
      sqlite.close();
      vi.unstubAllEnvs();
    }
    const dir = join(larkDir(), 'songs', id);
    mkdirSync(dir, { recursive: true });
    const mp3 = await readToneMp3();
    if (audio === 'file') {
      writeFileSync(join(dir, 'song.mp3'), mp3);
      return id;
    }
    const task = randomUUID();
    writeFileSync(join(dir, `.replace.${task}.bak`), mp3);
    writeFileSync(
      join(dir, `.pending.${task}`),
      JSON.stringify({ task_id: task, song_id: id, mode: 'replace', had_old: true }),
    );
    return id;
  }

  it('converts the library, then opens the business routes', async () => {
    const id = await seedPendingLibrary();

    const child = spawnDaemon();
    const port = await child.waitForPort();
    const base = `http://127.0.0.1:${port}`;
    const token = readFileSync(tokenPath(), 'utf-8');
    const auth = { authorization: `Bearer ${token}` };

    // The pass ends by activating, so the observation point is the phase
    // `/status` reports — reachable the whole time, which is the point.
    await vi.waitFor(
      async () => {
        const res = await fetch(`${base}/status`);
        const body = (await res.json()) as { data: StatusData };
        expect(body.data.audio_migration?.phase).toBe('normal');
        expect(body.data.audio_migration?.done).toBe(1);
      },
      { timeout: 60_000, interval: 100 },
    );

    expect(existsSync(join(larkDir(), 'songs', id, 'song.m4a'))).toBe(true);
    expect(existsSync(join(larkDir(), 'songs', id, 'song.mp3'))).toBe(false);

    const songs = await fetch(`${base}/songs`, { headers: auth });
    expect(songs.status).toBe(200);

    child.proc.kill('SIGTERM');
    expect(await child.waitForExit()).toMatchObject({ code: 0 });
  }, 90_000);

  it('migrates an mp3 that only legacy recovery could produce (判据 15)', async () => {
    const id = await seedPendingLibrary('crashed');
    expect(existsSync(join(larkDir(), 'songs', id, 'song.mp3'))).toBe(false);

    const child = spawnDaemon();
    const port = await child.waitForPort();

    await vi.waitFor(
      async () => {
        const res = await fetch(`http://127.0.0.1:${port}/status`);
        const body = (await res.json()) as { data: StatusData };
        expect(body.data.audio_migration?.phase).toBe('normal');
      },
      { timeout: 60_000, interval: 100 },
    );

    // Recovery restored the backup as `song.mp3` — under the v1 name, because
    // the manifest had no version — and the scan that followed picked it up.
    expect(existsSync(join(larkDir(), 'songs', id, 'song.m4a'))).toBe(true);
    expect(existsSync(join(larkDir(), 'songs', id, 'song.mp3'))).toBe(false);

    child.proc.kill('SIGTERM');
    expect(await child.waitForExit()).toMatchObject({ code: 0 });
  }, 90_000);

  it('serves nothing but the whitelist while a stuck file op holds the pass', async () => {
    const id = await seedPendingLibrary();
    // A file op that has given up owning the directory. It has to be a FAILED
    // one: boot drains the journal before the pass, so a merely queued op
    // would run — and take the song with it — instead of blocking anything.
    const core = await import('@lark/core');
    vi.stubEnv('LARK_NEST_DIR', nest);
    const { sqlite } = core.createDatabase({ dbPath: dbPath() });
    core.enqueueLocalDelete(sqlite, id);
    sqlite
      .prepare('UPDATE sync_file_ops SET attempts = ?, last_error = ?')
      .run(SYNC_FILE_OP_MAX_ATTEMPTS, 'seeded as permanently failed');
    sqlite.close();
    vi.unstubAllEnvs();

    const child = spawnDaemon();
    const port = await child.waitForPort();
    const base = `http://127.0.0.1:${port}`;
    const token = readFileSync(tokenPath(), 'utf-8');

    await vi.waitFor(
      async () => {
        const res = await fetch(`${base}/status`);
        const body = (await res.json()) as { data: StatusData };
        expect(body.data.audio_migration?.state).toBe('needs_attention');
      },
      { timeout: 60_000, interval: 100 },
    );

    const status = (await (await fetch(`${base}/status`)).json()) as { data: StatusData };
    expect(status.data.audio_migration?.phase).toBe('pending');
    expect(status.data.audio_migration?.blocked_file_op).toBe(1);

    const auth = { authorization: `Bearer ${token}` };
    const songs = await fetch(`${base}/songs`, { headers: auth });
    expect(songs.status).toBe(503);
    expect(((await songs.json()) as { error_code: string }).error_code).toBe(
      'AUDIO_MIGRATION_PENDING',
    );
    // The mp3 the op owns is exactly where it was.
    expect(existsSync(join(larkDir(), 'songs', id, 'song.mp3'))).toBe(true);

    // ── the way out (判据 16) ──
    //
    // The file-op trio is whitelisted precisely so this is possible without a
    // database editor: list the dead op, discard it, and the pass picks the
    // directory up on its own.
    const list = await fetch(`${base}/sync/file-ops?state=failed`, { headers: auth });
    const ops = ((await list.json()) as { data: { file_ops: { id: number }[] } }).data.file_ops;
    expect(ops).toHaveLength(1);

    const discarded = await fetch(`${base}/sync/file-ops/discard`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: ops[0]?.id }),
    });
    expect(discarded.status).toBe(200);

    await vi.waitFor(
      async () => {
        const res = await fetch(`${base}/status`);
        const body = (await res.json()) as { data: StatusData };
        expect(body.data.audio_migration?.phase).toBe('normal');
      },
      { timeout: 60_000, interval: 100 },
    );
    expect(existsSync(join(larkDir(), 'songs', id, 'song.m4a'))).toBe(true);
    expect((await fetch(`${base}/songs`, { headers: auth })).status).toBe(200);

    child.proc.kill('SIGTERM');
    expect(await child.waitForExit()).toMatchObject({ code: 0 });
  }, 90_000);
});

// The acquisition order is only observable from outside: what exists on disk
// at the moment the boot is blocked, and what the process does with a signal
// while it sits in a synchronous SQLite call (M6-18 ①).
describe('boot — writer lock', () => {
  let blocker: WriterLock | null = null;

  afterEach(() => {
    blocker?.release();
    blocker = null;
  });

  it('holds the lock for its whole life and releases it on exit', async () => {
    const child = spawnDaemon();
    await child.waitForPort();

    expect(() => acquireWriterLock({ dbPath: dbPath() })).toThrow(WriterLockBusyError);

    child.proc.kill('SIGTERM');
    expect(await child.waitForExit()).toMatchObject({ code: 0 });

    const afterExit = acquireWriterLock({ dbPath: dbPath() });
    afterExit.release();
  });

  it('takes the pid lock first and writes no config while it waits', async () => {
    // Exactly the backup-vs-boot interleaving (M6-18 ④): a backup holds the
    // writer lock, a daemon starts midway, and `loadConfig()` — which
    // CREATES a default file when none exists — must not run behind the
    // backup's back.
    blocker = acquireWriterLock({ dbPath: dbPath() });
    const child = spawnDaemon();

    // The pid lock is taken before the writer lock, so it appears even
    // though this boot is never going to finish.
    await vi.waitFor(() => expect(existsSync(pidPath())).toBe(true), { timeout: 10_000 });
    expect(existsSync(configPath())).toBe(false);

    const exit = await child.waitForExit();
    expect(exit.code).toBe(1);
    expect(child.stderr()).toContain('另一个写者持有写锁');
    // Still nothing written, and the pid lock was handed back.
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(tokenPath())).toBe(false);
    expect(existsSync(pidPath())).toBe(false);
  }, 20_000);

  it('does not tighten an existing config while it waits', async () => {
    // `loadConfig()` chmods a world-readable config to 0600 — a write, on
    // the far side of the lock like every other.
    writeFileSync(configPath(), '[log]\nlevel = "info"\n');
    chmodSync(configPath(), 0o644);
    blocker = acquireWriterLock({ dbPath: dbPath() });

    const child = spawnDaemon();
    expect(await child.waitForExit()).toMatchObject({ code: 1 });

    expect(statSync(configPath()).mode & 0o777).toBe(0o644);
  }, 20_000);

  it('honours a SIGTERM delivered while it is blocked on the lock', async () => {
    // The checkpoint protocol (sixth review ③): `process.on` callbacks do
    // not run while SQLite waits inside its busy handler, so the signal is
    // only observable after the call returns. Boot must still exit 0 —
    // first-wins says a signal beats the lock timeout that follows it.
    blocker = acquireWriterLock({ dbPath: dbPath() });
    const child = spawnDaemon();

    await vi.waitFor(() => expect(existsSync(pidPath())).toBe(true), { timeout: 10_000 });
    await sleep(150); // comfortably inside the 5s wait
    child.proc.kill('SIGTERM');

    expect(await child.waitForExit()).toMatchObject({ code: 0 });
    expect(existsSync(pidPath())).toBe(false);
    expect(existsSync(configPath())).toBe(false);
  }, 20_000);
});

describe('stop-daemon', () => {
  it('refuses to signal a live pid that cannot prove it is the daemon', async () => {
    // The test runner itself: alive, and definitely not a lark daemon.
    writeFileSync(pidPath(), String(process.pid));

    const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [CLI_ENTRY, 'stop-daemon'],
        { env: { ...process.env, LARK_NEST_DIR: nest } },
        (err, _stdout, stderr) => {
          const code = err && typeof err.code === 'number' ? err.code : 0;
          resolve({ code, stderr });
        },
      );
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('拒绝发送信号');
    expect(existsSync(pidPath())).toBe(true);
  });
});
