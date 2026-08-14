// The writer lock, and the three writers that share it (M6-18; the Go
// migration was the fourth until 0.3 deleted it).
//
// Two properties are worth the cost of child processes: cross-PROCESS
// exclusion (the whole point — an in-process test would pass with a plain
// module-level boolean), and release-on-SIGKILL (what makes stale-lock
// handling unnecessary). Everything else is in-process.
//
// (`.exec` below is better-sqlite3's Database#exec — SQL, not child_process;
// subprocesses are spawned via spawn() with argument arrays, no shell.)

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupNest } from '../backup-nest.js';
import { WriterLockBusyError } from '../errors.js';
import { createDatabase } from './index.js';
import { type WriterLock, acquireWriterLock, writerLockPath } from './writer-lock.js';

let dir: string;
const held: WriterLock[] = [];

const dbPath = (): string => join(dir, 'songs.db');

/** Acquire and register for cleanup, so a failing assertion cannot leak a lock. */
function take(options: { busyTimeoutMs?: number } = {}): WriterLock {
  const lock = acquireWriterLock({ dbPath: dbPath(), ...options });
  held.push(lock);
  return lock;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-writer-lock-'));
});

afterEach(() => {
  for (const lock of held.splice(0)) lock.release();
  rmSync(dir, { recursive: true, force: true });
});

/** Child source: hold the writer lock, announce it, stay alive. */
const HOLD_SRC = `
const D = require('better-sqlite3');
const db = new D(process.argv[1]);
db.pragma('busy_timeout = 0');
db.exec('BEGIN EXCLUSIVE');
console.log('locked');
setInterval(() => {}, 1 << 30);
`;

function waitForOutput(stream: Readable, needle: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = '';
    stream.on('data', (chunk: Buffer) => {
      buf += String(chunk);
      if (buf.includes(needle)) resolve();
    });
    stream.on('end', () => reject(new Error(`stream ended without '${needle}': ${buf}`)));
  });
}

async function spawnHolder(path: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', HOLD_SRC, writerLockPath(path)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForOutput(child.stdout as Readable, 'locked');
  return child;
}

function killAndWait(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.on('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

describe('acquireWriterLock', () => {
  it('excludes a second holder and lets go on release', () => {
    const first = take();
    expect(() => take()).toThrow(WriterLockBusyError);

    first.release();
    expect(() => take()).not.toThrow();
  });

  it('is idempotent on release', () => {
    const lock = take();
    lock.release();
    lock.release(); // must not throw, must not free somebody else's lock
    const second = take();
    second.release();
  });

  it('waits up to busyTimeoutMs before giving up', () => {
    const first = take();
    const started = Date.now();
    expect(() => take({ busyTimeoutMs: 300 })).toThrow(WriterLockBusyError);
    // SQLite's busy handler retries for the whole budget before failing.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    first.release();
  });

  it('reports how long it waited', () => {
    const first = take();
    try {
      take({ busyTimeoutMs: 50 });
      expect.unreachable('expected the second acquire to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(WriterLockBusyError);
      expect((err as WriterLockBusyError).waitedMs).toBe(50);
      expect((err as WriterLockBusyError).dbPath).toBe(dbPath());
    }
    first.release();
  });

  it('never deletes the lock file — its presence carries no meaning', () => {
    const lock = take();
    lock.release();
    // Same reasoning as the migration lock (M1): unlinking would reintroduce
    // the create/delete race the fcntl lock exists to avoid.
    expect(existsSync(writerLockPath(dbPath()))).toBe(true);
    // And a leftover file does not lock anything.
    expect(() => take()).not.toThrow();
  });

  it('excludes another PROCESS, and a SIGKILL releases it', async () => {
    const child = await spawnHolder(dbPath());
    expect(() => take()).toThrow(WriterLockBusyError);

    await killAndWait(child);
    // No cleanup step ran anywhere: the kernel dropped the fcntl lock when
    // the process died. That is the whole reason this is not a pid file.
    expect(() => take()).not.toThrow();
  });
});

describe('the three writers exclude each other', () => {
  const quiet = { probeRunning: async (): Promise<string | null> => null };

  function seedNest(root: string): void {
    const lark = join(root, 'lark');
    mkdirSync(join(lark, 'songs'), { recursive: true });
    writeFileSync(join(lark, 'lark_config.toml'), '[log]\nlevel = "info"\n');
    const { sqlite } = createDatabase({ dbPath: join(lark, 'songs.db') });
    sqlite.close();
  }

  it('refuses a nest backup while another writer holds the lock', async () => {
    const nest = join(dir, 'nest');
    seedNest(nest);
    vi.stubEnv('LARK_NEST_DIR', nest);
    const lock = acquireWriterLock({ dbPath: join(nest, 'lark', 'songs.db') });
    try {
      await expect(backupNest({ target: join(dir, 'copy'), ...quiet })).rejects.toBeInstanceOf(
        WriterLockBusyError,
      );
      // The refusal happened before anything was created.
      expect(existsSync(join(dir, 'copy'))).toBe(false);
    } finally {
      lock.release();
      vi.unstubAllEnvs();
    }
  });

  it('releases the lock again after a backup, successful or not', async () => {
    const nest = join(dir, 'nest');
    seedNest(nest);
    vi.stubEnv('LARK_NEST_DIR', nest);
    try {
      await backupNest({ target: join(dir, 'copy'), ...quiet });
      const after = acquireWriterLock({ dbPath: join(nest, 'lark', 'songs.db') });
      after.release();

      // …and on the failure path too (a target that already exists).
      await expect(backupNest({ target: join(dir, 'copy'), ...quiet })).rejects.toThrow();
      const afterFailure = acquireWriterLock({ dbPath: join(nest, 'lark', 'songs.db') });
      afterFailure.release();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
