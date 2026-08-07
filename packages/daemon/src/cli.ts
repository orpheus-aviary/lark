#!/usr/bin/env node

// The daemon's OWN command line: start / stop / inspect this process. The
// user-facing `lark` CLI (apps/cli) is a separate binary that talks HTTP —
// nothing here duplicates it (M0-8).
//
// Since M6 the protocols themselves live in `@lark/core/daemon-control`, so
// both CLIs run the SAME five-step stop rather than two implementations that
// agree until one is edited. What stays here is the rendering.

import {
  PidFileCorruptError,
  inspectPidReadonly,
  paths,
  probeStatus,
  statusPid,
  stopDaemonVerified,
} from '@lark/core';
import { API_PATHS, defaultDaemonBaseUrl } from '@lark/shared';
import { Command } from 'commander';
import { boot } from './boot.js';
import { DAEMON_VERSION } from './version.js';

/** Terminal error + exit 1, in one place so every path reads the same. */
function die(...lines: string[]): never {
  for (const line of lines) console.error(line); // log-hygiene: console-ok
  process.exit(1);
}

/**
 * Stop a running daemon (M2-3, protocol in `@lark/core/daemon-control`).
 *
 * The refusals are the point: a pid file is not proof of identity — pids are
 * recycled, and this exact path was also used by the archived Go daemon — so
 * an unverifiable or mismatched target is reported, never signalled.
 */
async function stopDaemon(): Promise<void> {
  let outcome: Awaited<ReturnType<typeof stopDaemonVerified>>;
  try {
    outcome = await stopDaemonVerified();
  } catch (err) {
    if (err instanceof PidFileCorruptError) die(err.message);
    throw err;
  }

  switch (outcome.kind) {
    case 'not-running':
      console.log('lark daemon 未在运行'); // log-hygiene: console-ok
      return;
    case 'stopped':
      console.log('lark daemon 已停止'); // log-hygiene: console-ok
      return;
    case 'refused': {
      const reason =
        outcome.reason === 'unverifiable'
          ? `pid 文件记录 PID ${outcome.pid}，但 ${defaultDaemonBaseUrl()}${API_PATHS.status} 无响应——无法确认它是 lark TS daemon（可能是 Go 版或已失效的其他进程），拒绝发送信号。`
          : `不一致：${outcome.detail}——拒绝发送信号。`;
      die(reason, `确认无用后可手动删除：${paths.pidPath()}`);
      break;
    }
    case 'timeout':
      die(`信号已发送，但 daemon (PID ${outcome.pid}) 在 ${outcome.waitedMs / 1000} 秒内尚未退出`);
  }
}

/** Report liveness. `/status` is the source of truth; the pid file is a hint. */
async function daemonStatus(): Promise<void> {
  const probe = await probeStatus();
  if (probe.kind === 'answered') {
    const data = probe.data as { uptime?: number; version?: string };
    const pid = statusPid(probe.data);
    const running = `lark daemon 运行中：PID ${pid}，已运行 ${(data.uptime ?? 0).toFixed(1)}s，版本 ${data.version}`;
    console.log(running); // log-hygiene: console-ok
    return;
  }

  // A read command inspects, it does not tidy: `readPid` would delete a stale
  // file as a side effect of being asked a question (M6-9).
  const inspection = inspectPidReadonly();
  if (inspection.state === 'live') {
    die(`pid 文件存在（PID ${inspection.pid}）但 daemon 无响应`);
  }
  if (inspection.state === 'corrupt') {
    die(new PidFileCorruptError(paths.pidPath(), inspection.raw as string).message);
  }
  die('lark daemon 未在运行');
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
