#!/usr/bin/env node

// The daemon's OWN command line: start / stop / inspect this process. The
// user-facing `lark` CLI (apps/cli) is a separate binary that talks HTTP —
// nothing here duplicates it (M0-8).

import { existsSync } from 'node:fs';
import { paths } from '@lark/core';
import { API_PATHS, type ApiResponse, type StatusData, defaultDaemonBaseUrl } from '@lark/shared';
import { Command } from 'commander';
import { boot } from './boot.js';
import { DAEMON_VERSION } from './context.js';
import { PidFileCorruptError, readPid } from './pid.js';

const STATUS_TIMEOUT_MS = 1000;
const STOP_POLL_MS = 200;
const STOP_TIMEOUT_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `GET /status`, or null when the daemon does not answer. */
async function probeStatus(): Promise<StatusData | null> {
  try {
    const res = await fetch(`${defaultDaemonBaseUrl()}${API_PATHS.status}`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ApiResponse<StatusData>;
    return body.success && body.data ? body.data : null;
  } catch {
    return null;
  }
}

/** Read the pid file, turning corruption into a terminal error. */
function readPidOrExit(): number | null {
  try {
    return readPid();
  } catch (err) {
    if (err instanceof PidFileCorruptError) {
      console.error(err.message); // log-hygiene: console-ok
      process.exit(1);
    }
    throw err;
  }
}

/** Has the daemon really gone? (pid file removed, or process + port both gone) */
async function hasStopped(pid: number): Promise<boolean> {
  if (!existsSync(paths.pidPath())) return true;
  try {
    process.kill(pid, 0);
    return false; // still alive
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') return false;
  }
  return (await probeStatus()) === null;
}

/**
 * Stop a running daemon — with proof, then patience (M2-3).
 *
 * The pid file is NOT proof of identity: pids are recycled, and this exact
 * path is also used by the archived Go daemon. So the target must confirm
 * itself over `/status` before any signal is sent, and the command waits for
 * the process to actually be gone instead of reporting success the moment
 * SIGTERM was delivered (owl's bug: "stopped" printed while the daemon was
 * still flushing).
 */
async function stopDaemon(): Promise<void> {
  const filePid = readPidOrExit();
  if (filePid === null) {
    console.log('lark daemon 未在运行'); // log-hygiene: console-ok
    return;
  }

  const status = await probeStatus();
  if (status === null) {
    console.error(
      `pid 文件记录 PID ${filePid}，但 ${defaultDaemonBaseUrl()}${API_PATHS.status} 无响应——无法确认它是 lark TS daemon（可能是 Go 版或已失效的其他进程），拒绝发送信号。`, // log-hygiene: console-ok
    );
    console.error(`确认无用后可手动删除：${paths.pidPath()}`); // log-hygiene: console-ok
    process.exit(1);
  }
  if (status.pid !== filePid) {
    console.error(
      `不一致：pid 文件记录 ${filePid}，/status 回报 ${status.pid}——拒绝发送信号。`, // log-hygiene: console-ok
    );
    process.exit(1);
  }

  process.kill(filePid, 'SIGTERM');
  console.log(`已向 lark daemon (PID ${filePid}) 发送 SIGTERM，等待退出…`); // log-hygiene: console-ok

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(STOP_POLL_MS);
    if (await hasStopped(filePid)) {
      console.log('lark daemon 已停止'); // log-hygiene: console-ok
      return;
    }
  }
  console.error(
    `信号已发送，但 daemon (PID ${filePid}) 在 ${STOP_TIMEOUT_MS / 1000} 秒内尚未退出`, // log-hygiene: console-ok
  );
  process.exit(1);
}

/** Report liveness. `/status` is the source of truth; the pid file is a hint. */
async function daemonStatus(): Promise<void> {
  const status = await probeStatus();
  if (status !== null) {
    console.log(
      `lark daemon 运行中：PID ${status.pid}，已运行 ${status.uptime.toFixed(1)}s，版本 ${status.version}`, // log-hygiene: console-ok
    );
    return;
  }
  const filePid = readPidOrExit();
  if (filePid !== null) {
    console.error(`pid 文件存在（PID ${filePid}）但 daemon 无响应`); // log-hygiene: console-ok
    process.exit(1);
  }
  console.error('lark daemon 未在运行'); // log-hygiene: console-ok
  process.exit(1);
}

const program = new Command();

program.name('lark-daemon').description('lark music daemon').version(DAEMON_VERSION);

program
  .command('daemon')
  .description('Start the daemon HTTP server on 127.0.0.1:47100')
  .action(() => boot());

program
  .command('stop-daemon')
  .description('Stop the running daemon (verifies identity, waits for exit)')
  .action(() => stopDaemon());

program
  .command('daemon-status')
  .description('Report whether the daemon is running')
  .action(() => daemonStatus());

// `from: 'node'` is explicit so the CLI works both from plain node and from
// Electron-as-Node (ELECTRON_RUN_AS_NODE=1). Without it commander detects
// `process.versions.electron` and only strips argv[0], misreading the script
// path as the first subcommand.
program.parse(process.argv, { from: 'node' });
