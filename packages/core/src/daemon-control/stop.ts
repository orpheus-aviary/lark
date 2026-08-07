// Probing a daemon, and stopping one with proof (M6-9).
//
// This is M2-3's five-step stop protocol, moved down from the daemon's own CLI
// so the user-facing `lark` can run it without depending on `@lark/daemon`
// (which would drag better-sqlite3 into a command that never opens a database).
// Each step is preserved verbatim:
//
//   1. read the pid file — corruption is fatal, not a shrug;
//   2. no pid file → nothing to stop, and that is a success;
//   3. the target must prove itself over `/status` before ANY signal — the pid
//      file is not proof of identity: pids are recycled, and the archived Go
//      daemon used this very path;
//   4. `/status.pid` must equal the pid on disk, or the two disagree about who
//      is being asked to stop;
//   5. wait for the process to actually be gone, rather than reporting success
//      the moment SIGTERM was delivered (owl printed "stopped" while its
//      daemon was still flushing).
//
// Nothing here prints: outcomes are values, so the daemon CLI, the user CLI
// and a test can each render them their own way.

import { existsSync } from 'node:fs';
import { DEFAULT_DAEMON_PORT, defaultDaemonBaseUrl } from '@lark/shared';
import { pidPath as defaultPidPath } from '../paths.js';
import { isProcessAlive, readPid } from './pid.js';

export interface ProbeOptions {
  /** Defaults to `http://127.0.0.1:47100`. */
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * The outcome of a `GET /status` probe.
 *
 * `answered` carries the envelope's `data` UNVALIDATED on purpose: identity
 * resolution has to tell a well-formed M6 answer from a pre-M6 one and from
 * an outright malformed one (M6-19), and a parser that returned `null` for all
 * three would erase exactly the distinction it needs.
 */
export type StatusProbe = { kind: 'unreachable' } | { kind: 'answered'; data: unknown };

const PROBE_TIMEOUT_MS = 1000;
const STOP_POLL_MS = 200;
const STOP_TIMEOUT_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `GET /status`. Anything short of a 200 JSON envelope is "unreachable". */
export async function probeStatus(options: ProbeOptions = {}): Promise<StatusProbe> {
  const {
    baseUrl = defaultDaemonBaseUrl(DEFAULT_DAEMON_PORT),
    timeoutMs = PROBE_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options;
  try {
    const res = await fetchImpl(`${baseUrl}/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { kind: 'unreachable' };
    const body = (await res.json()) as { success?: boolean; data?: unknown };
    if (body?.success !== true || body.data === undefined) return { kind: 'unreachable' };
    return { kind: 'answered', data: body.data };
  } catch {
    return { kind: 'unreachable' };
  }
}

/** The `pid` of a `/status` payload, or null when it does not look like one. */
export function statusPid(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const pid = (data as { pid?: unknown }).pid;
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

export type StopOutcome =
  /** No pid file: nothing to stop. Idempotent success. */
  | { kind: 'not-running' }
  /** Signalled, and observed to be gone. */
  | { kind: 'stopped'; pid: number }
  /** A pid file we refuse to act on. NOTHING was signalled. */
  | { kind: 'refused'; pid: number; reason: 'unverifiable' | 'pid-mismatch'; detail: string }
  /** Signalled, but still alive when the budget ran out. */
  | { kind: 'timeout'; pid: number; waitedMs: number };

export interface StopDaemonOptions extends ProbeOptions {
  pidPath?: string;
  pollMs?: number;
  stopTimeoutMs?: number;
  /** Seam for tests; defaults to `process.kill`. */
  killImpl?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Stop a running daemon — with proof, then patience. See the header for the
 * five steps; every refusal leaves the process and its pid file untouched.
 *
 * @throws PidFileCorruptError when the pid file content is not a plausible pid.
 */
export async function stopDaemonVerified(options: StopDaemonOptions = {}): Promise<StopOutcome> {
  const {
    pidPath = defaultPidPath(),
    pollMs = STOP_POLL_MS,
    stopTimeoutMs = STOP_TIMEOUT_MS,
    killImpl = (pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
    },
    ...probeOptions
  } = options;

  const filePid = readPid(pidPath); // throws on corruption, clears a stale file
  if (filePid === null) return { kind: 'not-running' };

  const probe = await probeStatus(probeOptions);
  if (probe.kind === 'unreachable') {
    return {
      kind: 'refused',
      pid: filePid,
      reason: 'unverifiable',
      detail: `pid ${filePid} is alive but ${probeOptions.baseUrl ?? defaultDaemonBaseUrl()}/status does not answer`,
    };
  }
  const livePid = statusPid(probe.data);
  if (livePid !== filePid) {
    return {
      kind: 'refused',
      pid: filePid,
      reason: 'pid-mismatch',
      detail: `pid file says ${filePid}, /status reports ${livePid ?? 'nothing usable'}`,
    };
  }

  killImpl(filePid, 'SIGTERM');

  const deadline = Date.now() + stopTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (await hasStopped(filePid, pidPath, probeOptions)) {
      return { kind: 'stopped', pid: filePid };
    }
  }
  return { kind: 'timeout', pid: filePid, waitedMs: stopTimeoutMs };
}

/**
 * Gone = the pid file is released, or OUR target is dead and the port is
 * silent. Liveness is asked about the pid we signalled, not about whatever the
 * file holds now — a successor daemon writing its own pid there does not make
 * our target any less stopped.
 */
async function hasStopped(
  pid: number,
  pidPath: string,
  probeOptions: ProbeOptions,
): Promise<boolean> {
  if (!existsSync(pidPath)) return true;
  if (isProcessAlive(pid)) return false;
  return (await probeStatus(probeOptions)).kind === 'unreachable';
}
