// Finding the daemon and the GUI, and starting them detached (M6-8 / M6-9,
// M7-7).
//
// TWO WORLDS, one question each locator answers: a `lark` running out of the
// repo finds its siblings by walking up to `pnpm-workspace.yaml`; an installed
// one finds them inside `Lark.app`. Which world we are in is decided ONCE, by
// whether that walk succeeds, and nothing outside this file knows how a
// process is located.
//
// The packaged side has one rule worth stating on its own: every path comes
// from the SAME resolved bundle. The daemon runs the Electron in that bundle,
// on the daemon in that bundle, with the ffmpeg in that bundle; `lark gui`
// opens that exact path rather than asking LaunchServices for "Lark". Two
// installations sharing one nest is a class of bug that reads as haunted.
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
import { homedir } from 'node:os';
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

/** How to start a process: the program, its arguments, and how it behaves. */
export interface LaunchCommand {
  command: string;
  args: string[];
  /** Added to the child's environment. Absent means "inherit unchanged". */
  env?: NodeJS.ProcessEnv;
  /**
   * The command returns as soon as it has handed the work to someone else.
   *
   * True for `/usr/bin/open`, which asks LaunchServices to start the app and
   * exits. Callers that watch a child for "it died immediately" have to know
   * the difference, or the packaged GUI would be reported as crashed every
   * single time (M7-7).
   */
  expectsImmediateExit?: boolean;
}

/**
 * The workspace root, found by walking up from this module.
 *
 * Throws when there is none, which is the normal case for an installed CLI —
 * see `resolveAppBundle`, which is where that case is served.
 */
export function workspaceRoot(from: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new CliError('USAGE_ERROR', '找不到 lark 的工作区目录。');
    }
    dir = parent;
  }
}

/** Is this `lark` running out of the repo, or installed? */
export function isDevCheckout(from?: string): boolean {
  try {
    workspaceRoot(from);
    return true;
  } catch {
    return false;
  }
}

export interface LaunchOptions {
  /**
   * The workspace root. Passing it also FORCES the dev branch — which is what
   * a test wants, since the branch is otherwise decided by where this module
   * happens to live on disk.
   */
  root?: string;
  /**
   * Force the branch. Tests need it because they run FROM the workspace, so
   * "is there a pnpm-workspace.yaml above me" always answers yes and the
   * packaged half would be unreachable.
   */
  packaged?: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
}

/** Dev or packaged, decided once. */
function usesAppBundle(options: LaunchOptions): boolean {
  if (options.packaged !== undefined) return options.packaged;
  if (options.root !== undefined) return false;
  return !isDevCheckout();
}

/** Where a packaged Lark.app is looked for, in order (M7-7). */
export const APP_BUNDLE_NAME = 'Lark.app';

/**
 * The installed app bundle.
 *
 * Deliberately a short, fixed list rather than a search: `mdfind` would
 * happily return a copy in ~/Downloads or a mounted DMG, and starting a daemon
 * out of a disk image the user is about to eject is a worse failure than not
 * finding one at all.
 *
 * `LARK_APP_PATH` overrides, and is FAIL-FAST: set-but-wrong throws instead of
 * falling through, because someone who set it wants that bundle and needs to
 * hear that it is not usable (E16).
 *
 * "Usable" means the bundle carries the daemon — the one thing every caller
 * here is actually after. A Lark.app whose Resources are missing looks exactly
 * like a good one from the outside.
 */
export function resolveAppBundle(options: LaunchOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const exists = options.exists ?? existsSync;

  const override = env.LARK_APP_PATH;
  if (override !== undefined && override !== '') {
    if (!exists(bundledDaemonCli(override))) {
      throw new CliError(
        'USAGE_ERROR',
        `LARK_APP_PATH 指向的不是一个可用的 lark 应用包：${override}（里面找不到 daemon）。`,
      );
    }
    return override;
  }

  const candidates = [
    join('/Applications', APP_BUNDLE_NAME),
    join(home, 'Applications', APP_BUNDLE_NAME),
  ];
  const found = candidates.find((path) => exists(bundledDaemonCli(path)));
  if (found === undefined) {
    throw new CliError(
      'USAGE_ERROR',
      `找不到已安装的 Lark.app（找过 ${candidates.join('、')}）——把它拖进「应用程序」，或用 LARK_APP_PATH 指定位置。`,
    );
  }
  return found;
}

const bundledDaemonCli = (app: string): string =>
  join(app, 'Contents/Resources/app/node_modules/@lark/daemon/dist/cli.js');

const bundledElectron = (app: string): string => join(app, 'Contents/MacOS/Lark');

const bundledMediaTools = (app: string): string => join(app, 'Contents/Resources/ffmpeg');

/**
 * How to start the daemon.
 *
 * Dev: this Node, on the daemon package's CLI. Packaged: the app's OWN
 * Electron running as Node, on the daemon inside the same bundle — using this
 * process's Node would load a better-sqlite3 built for a different runtime,
 * and using another bundle's Electron would mix two installations.
 *
 * A `bundled` app also tells the daemon where its ffmpeg is. The signal is the
 * directory's existence, so a `system` build simply says nothing and the
 * daemon falls through to Homebrew (M7-16).
 */
export function daemonLaunchCommand(options: LaunchOptions = {}): LaunchCommand {
  if (usesAppBundle(options)) {
    const app = resolveAppBundle(options);
    const mediaTools = bundledMediaTools(app);
    const exists = options.exists ?? existsSync;
    return {
      command: bundledElectron(app),
      args: [bundledDaemonCli(app), 'daemon'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ...(exists(mediaTools) ? { LARK_MEDIA_TOOLS_DIR: mediaTools } : {}),
      },
    };
  }

  const cli = join(options.root ?? workspaceRoot(), 'packages/daemon/dist/cli.js');
  if (!existsSync(cli)) {
    throw new CliError(
      'USAGE_ERROR',
      `daemon 还没构建：${cli} 不存在——先跑 \`just build-daemon\`。`,
    );
  }
  return { command: process.execPath, args: [cli, 'daemon'] };
}

/**
 * How to start the GUI.
 *
 * Packaged: `/usr/bin/open` on the SAME path `resolveAppBundle` chose, never
 * `open -a Lark`. `-a` asks LaunchServices to pick, and it will happily pick a
 * different copy than the daemon just came out of — two installations, one
 * nest, and a single-instance check that fires for reasons nobody can see.
 *
 * Dev: the workspace's Electron on the built app. The binary is read from the
 * electron package's `path.txt` rather than imported, because the CLI may not
 * depend on electron (M6-21) and it only needs the string.
 */
export function guiLaunchCommand(options: LaunchOptions = {}): LaunchCommand {
  if (usesAppBundle(options)) {
    return {
      command: '/usr/bin/open',
      args: [resolveAppBundle(options)],
      expectsImmediateExit: true,
    };
  }

  const root = options.root ?? workspaceRoot();
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

/** A child that has been spawned, plus the facts we keep watching. */
export interface LaunchedChild {
  child: SpawnedChild;
  /**
   * Set by the `exit` listener attached at spawn time.
   *
   * `exitCode` and `signal` matter for the commands whose child is SUPPOSED to
   * exit: `/usr/bin/open` returning 0 means "handed to LaunchServices", and
   * returning non-zero means the app could not be started at all. Without them
   * both look identical — an exited child (E9).
   */
  readonly state: {
    exited: boolean;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    error: Error | null;
  };
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
  const state = {
    exited: false,
    exitCode: null as number | null,
    signal: null as NodeJS.Signals | null,
    error: null as Error | null,
  };
  let child: SpawnedChild;
  try {
    child = spawnImpl(command.command, command.args, {
      detached: true,
      stdio: 'ignore',
      env: command.env === undefined ? process.env : { ...process.env, ...command.env },
    });
  } catch (err) {
    throw new CliError(
      'DAEMON_UNAVAILABLE',
      `启动失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  child.once('exit', (...args: unknown[]) => {
    const [code, signal] = args;
    state.exited = true;
    state.exitCode = typeof code === 'number' ? code : null;
    state.signal = typeof signal === 'string' ? (signal as NodeJS.Signals) : null;
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
