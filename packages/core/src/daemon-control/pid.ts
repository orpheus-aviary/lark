// The pid file, read two different ways (M6-9).
//
// `readPid` is the DAEMON's reader: it removes a file whose process is gone,
// because the very next thing its caller does is take the lock. That side
// effect is correct there and wrong everywhere else — a CLI asking "is a
// daemon running?" must not delete state as a side effect of looking, least of
// all in a nest it may not own.
//
// So `inspectPidReadonly` is the reader for everybody else: it reports what is
// on disk (absent / live / stale / corrupt) and NEVER writes. The two share
// the parsing rules below, which are the M2-3 rules verbatim:
//
//   1. Content validation. An empty file parses as 0 and a negative number
//      parses fine — and `kill(0, sig)` / `kill(-n, sig)` address the PROCESS
//      GROUP. So the content must be `^\d+$`, a safe integer, and > 1.
//   2. Liveness. Only ESRCH means stale. EPERM means the pid is alive and
//      owned by someone else, which is the opposite of stale.

import { readFileSync, unlinkSync } from 'node:fs';
import { pidPath as defaultPidPath } from '../paths.js';

/** The pid file exists but holds something that is not a plausible pid. */
export class PidFileCorruptError extends Error {
  constructor(
    readonly path: string,
    readonly raw: string,
  ) {
    super(
      `pid file ${path} contains ${JSON.stringify(raw)}, which is not a valid pid — refusing to start. Check for a running daemon, then delete the file by hand.`,
    );
    this.name = 'PidFileCorruptError';
  }
}

export type PidState =
  /** No pid file at all. */
  | 'absent'
  /** A pid file naming a process that exists right now. */
  | 'live'
  /** A pid file naming a process that is gone (ESRCH). */
  | 'stale'
  /** A pid file whose content is not a plausible pid. */
  | 'corrupt';

export interface PidInspection {
  state: PidState;
  /** The pid on disk when it parsed, `null` for absent / corrupt. */
  pid: number | null;
  /** The raw file content, present only when it failed to parse. */
  raw?: string;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Is this process alive? Only ESRCH counts as "gone" (see the header). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * What the pid file says, with NO side effects — never unlinks, never throws
 * on corruption (corruption is a state, and callers of this one have to be
 * able to describe it rather than fail on it).
 */
export function inspectPidReadonly(path: string = defaultPidPath()): PidInspection {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return { state: 'absent', pid: null };
    throw err;
  }

  const text = raw.trim();
  if (!/^\d+$/.test(text)) return { state: 'corrupt', pid: null, raw: text };
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 1) return { state: 'corrupt', pid: null, raw: text };

  return { state: isProcessAlive(pid) ? 'live' : 'stale', pid };
}

/**
 * The pid of the live daemon, or `null` when nothing holds the lock.
 *
 * Side effect, and the reason this is not a pure read: a stale file is removed
 * here so the caller's next exclusive create can win. Only `acquireDaemonLock`
 * and the explicit lifecycle commands may use it — everything else wants
 * {@link inspectPidReadonly}.
 *
 * @throws PidFileCorruptError when the file content is not a plausible pid.
 */
export function readPid(path: string = defaultPidPath()): number | null {
  const inspected = inspectPidReadonly(path);
  switch (inspected.state) {
    case 'absent':
      return null;
    case 'corrupt':
      throw new PidFileCorruptError(path, inspected.raw as string);
    case 'live':
      return inspected.pid;
    case 'stale':
      try {
        unlinkSync(path);
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
      return null;
  }
}
