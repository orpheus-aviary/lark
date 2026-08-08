// Finding the daemon and the GUI, and starting them detached (M6-8 / M6-9).
//
// EVERY path in here is DEV-MODE ONLY and is M7's first job: today `lark` runs
// out of the workspace, so it finds its siblings by walking up to
// `pnpm-workspace.yaml`; in a packaged build the daemon lives inside the app
// bundle and the GUI is started with `open -a Lark`. The locators are kept in
// this one file, and nothing else knows how a process is found, so M7 replaces
// them here and nowhere else.
//
// Spawn hygiene is shared by both children and is not negotiable (M4-2):
//
//   detached + `stdio: 'ignore'`  Node's default is `pipe`, and `unref()` does
//     NOT release a pipe's hold on the parent's event loop — the CLI would
//     hang after a successful spawn, waiting on a stream nobody reads.
//   never inject a token          the daemon generates and publishes its own
//     (R29); handing one down is the owl regression this rule exists for.
//   inherit the environment       `LARK_NEST_DIR` above all: a child that
//     picks a different nest than its parent is the worst possible outcome.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from './errors.js';

/** The subset of a ChildProcess this package uses. Tests supply their own. */
export interface SpawnedChild {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
  // `unknown[]`, not `never[]`: `EventEmitter` declares `(...args: any[])`,
  // and a fake that extends it has to satisfy this shape.
  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): void;
  off(event: 'exit' | 'error', listener: (...args: unknown[]) => void): void;
}

export interface SpawnOptions {
  detached: true;
  stdio: 'ignore';
  env: NodeJS.ProcessEnv;
}

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedChild;

/** `node:child_process`'s spawn, narrowed to what a detached child needs. */
export const nodeSpawn: SpawnImpl = (command, args, options) =>
  spawn(command, [...args], options) as unknown as SpawnedChild;

/** How to start a process: the program, and its arguments. */
export interface LaunchCommand {
  command: string;
  args: string[];
}

/**
 * The workspace root, found by walking up from this module.
 *
 * M7 SEAM: a packaged `lark` has no workspace, and this is where it stops
 * being true.
 */
export function workspaceRoot(from: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new CliError(
        'USAGE_ERROR',
        '找不到 lark 的工作区目录——目前 `lark daemon` / `lark gui` 只能在仓库里跑（打包版归 M7）。',
      );
    }
    dir = parent;
  }
}

/**
 * How to start the daemon: this Node, running the daemon package's own CLI.
 *
 * M7 SEAM: the packaged app ships the daemon inside the bundle.
 */
export function daemonLaunchCommand(root: string = workspaceRoot()): LaunchCommand {
  const cli = join(root, 'packages/daemon/dist/cli.js');
  if (!existsSync(cli)) {
    throw new CliError(
      'USAGE_ERROR',
      `daemon 还没构建：${cli} 不存在——先跑 \`just build-daemon\`。`,
    );
  }
  return { command: process.execPath, args: [cli, 'daemon'] };
}

/**
 * How to start the GUI: the workspace's Electron binary, on the built app.
 *
 * The binary is read from the `electron` package's own `path.txt` rather than
 * by importing it — the CLI is not allowed to depend on electron (M6-21), and
 * a require of it here would trip the module guard for a string it only needs
 * as a path.
 *
 * M7 SEAM: `open -a Lark`.
 */
export function guiLaunchCommand(root: string = workspaceRoot()): LaunchCommand {
  const electronDir = join(root, 'node_modules', 'electron');
  const pathFile = join(electronDir, 'path.txt');
  if (!existsSync(pathFile)) {
    throw new CliError('USAGE_ERROR', `找不到 Electron（${pathFile}）——先跑 \`pnpm install\`。`);
  }
  const binary = join(electronDir, 'dist', readFileSync(pathFile, 'utf-8').trim());

  const app = join(root, 'packages/gui');
  if (!existsSync(join(app, 'out/main/index.js'))) {
    throw new CliError('USAGE_ERROR', 'GUI 还没构建——先跑 `just build-gui`。');
  }
  return { command: binary, args: [app] };
}

/** A child that has been spawned, plus the two facts we keep watching. */
export interface LaunchedChild {
  child: SpawnedChild;
  /** Set by the `exit` listener attached at spawn time. */
  readonly state: { exited: boolean; error: Error | null };
}

/**
 * Start a detached child and hand back its handle.
 *
 * The `exit` listener is attached BEFORE anything else can await: a child that
 * dies immediately must be observable as `exited`, or the recycle protocol
 * would signal a pid that has already been reused by somebody else.
 */
export function launchDetached(
  command: LaunchCommand,
  spawnImpl: SpawnImpl = nodeSpawn,
): LaunchedChild {
  const state = { exited: false, error: null as Error | null };
  let child: SpawnedChild;
  try {
    child = spawnImpl(command.command, command.args, {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
  } catch (err) {
    throw new CliError(
      'DAEMON_UNAVAILABLE',
      `启动失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  child.once('exit', () => {
    state.exited = true;
  });
  child.once('error', (...args: unknown[]) => {
    const [err] = args;
    state.error = err instanceof Error ? err : new Error(String(err));
    // A child that never started is not a child to signal later.
    state.exited = true;
  });
  // Off the parent's event loop: the CLI must be able to exit while the child
  // keeps running.
  child.unref();

  return { child, state };
}
