// `lark gui` — open the app, or say it is already open (M6-8).
//
// The daemon half is already handled before this command runs: `withContext`
// resolved the mode, and its `launch` branch put `ensureDaemon` in front of
// the backend. So what is left here is the GUI itself, and two rules:
//
//   IDEMPOTENT. A GUI that is already registered is a success with
//     `launched: false`, not a second window.
//   SPAWN AND LET GO. The GUI is a long-lived app; the CLI starts it detached
//     with `stdio: 'ignore'` (so the parent's event loop is free), waits only
//     for it to register, and exits. `lark gui` is not a supervisor.
//
// Online-ness is asked of the DAEMON (`gui_online` on `GET /player/status`),
// never of the process table: a running Electron process that has not
// registered its SSE channel cannot be sent a command, so it is not online in
// the only sense that matters.

import type { PlayerStatusResponse } from '@lark/shared';
import type { CommandContext } from '../context.js';
import { CliError } from '../lib/errors.js';
import {
  type LaunchCommand,
  type SpawnImpl,
  guiLaunchCommand,
  launchDetached,
} from '../lib/launch.js';
import { emitEnvelope, successEnvelope } from '../lib/output.js';

/** Injected by tests so nothing is really spawned and nothing really waits. */
export interface GuiDeps {
  spawnImpl?: SpawnImpl;
  command?: () => LaunchCommand;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
  pollMs?: number;
}

const WAIT_MS = 15_000;
const POLL_MS = 500;

export interface GuiResult {
  launched: boolean;
  gui_online: boolean;
}

export async function guiIsOnline(ctx: CommandContext): Promise<boolean> {
  const envelope = await ctx.backend.playerStatus();
  return (envelope.data as PlayerStatusResponse | undefined)?.gui_online === true;
}

/**
 * Make sure a GUI is registered, starting one if there is none.
 *
 * Shared with the `play` chain, which needs exactly this and nothing else.
 */
export async function ensureGui(ctx: CommandContext, deps: GuiDeps = {}): Promise<GuiResult> {
  if (await guiIsOnline(ctx)) return { launched: false, gui_online: true };

  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const waitMs = deps.waitMs ?? WAIT_MS;
  const pollMs = deps.pollMs ?? POLL_MS;

  // Spawned and released in the same breath: no handle is kept, because there
  // is nothing this command would do with it. A GUI that fails to start is
  // reported by the timeout below, and the user has a window to look at.
  const launched = launchDetached(deps.command?.() ?? guiLaunchCommand(), deps.spawnImpl);

  const deadline = now() + waitMs;
  while (now() < deadline) {
    await sleep(pollMs);
    if (launched.state.error !== null) {
      throw new CliError('GUI_ERROR', `启动 GUI 失败：${launched.state.error.message}`);
    }
    if (launched.state.exited) {
      throw new CliError(
        'GUI_ERROR',
        'GUI 进程启动后立刻退出了——用 `just dev` 跑一次看它说了什么。',
      );
    }
    if (await guiIsOnline(ctx)) return { launched: true, gui_online: true };
  }

  throw new CliError(
    'GUI_TIMEOUT',
    `GUI 在 ${Math.round(waitMs / 1000)}s 内没有连上 daemon——窗口可能还在启动，稍后重试。`,
  );
}

export async function runGui(ctx: CommandContext, deps: GuiDeps = {}): Promise<void> {
  const result = await ensureGui(ctx, deps);
  if (ctx.flags.json) {
    return emitEnvelope(
      ctx.streams,
      successEnvelope(result, {
        message: result.launched ? 'gui launched' : 'gui already running',
      }),
    );
  }
  ctx.streams.out(result.launched ? '✓ GUI 已启动' : '✓ GUI 已经在运行');
}
