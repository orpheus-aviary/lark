// "Make sure a daemon is running" — the one entry point (M6-9).
//
// Three commands need it (`lark daemon`, the `play` chain, `lark gui`), and
// they must agree on every branch, because the branches are where the damage
// lives: starting a second daemon for a nest that already has one, adopting a
// process nobody can identify, or leaving an orphaned child behind after
// losing a race.
//
// The rules, in the order they matter:
//
//   ONLY `absent` MAY SPAWN. Every other identity state is an answer, not an
//     obstacle: another nest's daemon holds the port (stop that one), our own
//     daemon speaks another protocol (stop the old instance), something
//     unidentifiable is there (refuse — fail closed).
//   A LIVE PID THAT DOES NOT ANSWER IS NOT A REFUSAL YET. The daemon writes
//     its pid file before it listens, so "pid alive, /status silent" is what a
//     daemon still booting looks like. It gets a bounded, read-only re-probe.
//   OWNERSHIP IS PROVEN, NEVER ASSUMED. A spawn counts as ours only when
//     `/status.pid` equals the child's pid AND the full five-state resolution
//     says `current`. Losing the race is normal — someone else's daemon may be
//     perfectly good — but then OUR child must go.
//   THE CHILD IS RECYCLED IN TWO STAGES, BOTH BOUNDED. SIGTERM, wait, SIGKILL,
//     wait, and if it is still not gone, say so with the pid instead of
//     claiming a clean exit.

import { probeNativeAbi } from '@lark/core/native-probe';
import { CliError } from './errors.js';
import {
  type DaemonIdentity,
  type IdentityResolver,
  describeIdentity,
  identityDetails,
} from './identity.js';
import {
  type LaunchCommand,
  type LaunchedChild,
  type SpawnImpl,
  type SpawnedChild,
  daemonLaunchCommand,
  launchDetached,
} from './launch.js';
import { abiError } from './native-abi.js';

export interface EnsureDaemonResult {
  /** True when THIS command started the daemon that is now running. */
  started: boolean;
  pid: number;
  /** Set only when a child could not be recycled — surfaced, never swallowed. */
  note?: string;
}

export interface EnsureDaemonDeps {
  identity: IdentityResolver;
  spawnImpl?: SpawnImpl;
  probeAbi?: typeof probeNativeAbi;
  command?: () => LaunchCommand;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long a spawned daemon has to come up, and how often we look. */
  spawnWaitMs?: number;
  pollMs?: number;
  /** The two halves of the recycle deadline. */
  termWaitMs?: number;
  killWaitMs?: number;
}

const SPAWN_WAIT_MS = 10_000;
const POLL_MS = 500;
const TERM_WAIT_MS = 3_000;
const KILL_WAIT_MS = 2_000;

interface Settings {
  identity: IdentityResolver;
  spawnImpl: SpawnImpl | undefined;
  probeAbi: typeof probeNativeAbi;
  command: () => LaunchCommand;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  spawnWaitMs: number;
  pollMs: number;
  termWaitMs: number;
  killWaitMs: number;
}

function settle(deps: EnsureDaemonDeps): Settings {
  return {
    identity: deps.identity,
    spawnImpl: deps.spawnImpl,
    probeAbi: deps.probeAbi ?? probeNativeAbi,
    command: deps.command ?? (() => daemonLaunchCommand()),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? (() => Date.now()),
    spawnWaitMs: deps.spawnWaitMs ?? SPAWN_WAIT_MS,
    pollMs: deps.pollMs ?? POLL_MS,
    termWaitMs: deps.termWaitMs ?? TERM_WAIT_MS,
    killWaitMs: deps.killWaitMs ?? KILL_WAIT_MS,
  };
}

export async function ensureDaemon(deps: EnsureDaemonDeps): Promise<EnsureDaemonResult> {
  const config = settle(deps);
  let identity = await config.identity.resolve();

  // A pid file that is alive but silent may be a daemon mid-boot. Give it the
  // same budget a spawn gets, re-reading only (M6-9).
  if (isBooting(identity)) identity = await awaitBoot(config, identity);

  switch (identity.state) {
    case 'current':
      return { started: false, pid: identity.pid };
    case 'absent':
      return await spawnDaemon(config);
    default:
      throw refuse(identity);
  }
}

const isBooting = (identity: DaemonIdentity): boolean =>
  identity.state === 'occupied-unverifiable' && identity.reason === 'pid-file-live';

/** Re-resolve until the live pid says something, or the budget runs out. */
async function awaitBoot(config: Settings, from: DaemonIdentity): Promise<DaemonIdentity> {
  const deadline = config.now() + config.spawnWaitMs;
  let identity = from;
  while (config.now() < deadline) {
    await config.sleep(config.pollMs);
    identity = await config.identity.resolveFresh();
    if (!isBooting(identity)) return identity;
  }
  return identity;
}

async function spawnDaemon(config: Settings): Promise<EnsureDaemonResult> {
  // Spawning a daemon that will die on its first database call is worse than
  // not spawning it: the failure would surface as a timeout with no cause.
  const abi = await config.probeAbi();
  if (!abi.ok) throw abiError(abi);

  const launched = launchDetached(config.command(), config.spawnImpl);
  const { child, state } = launched;

  const deadline = config.now() + config.spawnWaitMs;
  while (config.now() < deadline) {
    await config.sleep(config.pollMs);

    if (state.error !== null) {
      throw new CliError('DAEMON_UNAVAILABLE', `启动 daemon 失败：${state.error.message}`);
    }
    if (state.exited) {
      throw new CliError(
        'DAEMON_UNAVAILABLE',
        'daemon 子进程启动后立刻退出了——用 `just dev-daemon` 在前台跑一次看它说了什么。',
      );
    }

    const identity = await config.identity.resolveFresh();

    // Still coming up: no pid file yet, or one that has not started listening.
    if (identity.state === 'absent' || isBooting(identity)) continue;

    if (identity.state === 'current') {
      // Proven ours only when the pid matches the child we started.
      if (identity.pid === child.pid) return { started: true, pid: identity.pid };
      // Somebody else won. Their daemon has already passed the full five-state
      // check, so it is usable — but our child is not, and must go.
      const cleanup = await recycle(launched, config);
      return { started: false, pid: identity.pid, ...(cleanup === null ? {} : { note: cleanup }) };
    }

    throw withNote(refuse(identity), await recycle(launched, config));
  }

  throw withNote(
    new CliError(
      'DAEMON_UNAVAILABLE',
      `daemon 在 ${Math.round(config.spawnWaitMs / 1000)}s 内没有起来——用 \`just dev-daemon\` 在前台跑一次看它说了什么。`,
    ),
    await recycle(launched, config),
  );
}

/**
 * Get rid of a child we started and cannot use.
 *
 * Returns `null` when the child is gone, or a diagnostic when it is not.
 * The promise is deliberately narrow: this does not hang forever, and it does
 * not claim a process is dead when SIGKILL did not visibly land.
 */
async function recycle(launched: LaunchedChild, config: Settings): Promise<string | null> {
  const { child, state } = launched;
  if (state.exited) return null;

  if (!signal(child, 'SIGTERM')) return null; // ESRCH — already gone
  if (await exited(launched, config.termWaitMs)) return null;

  if (!signal(child, 'SIGKILL')) return null;
  if (await exited(launched, config.killWaitMs)) return null;

  return `子进程 ${child.pid ?? '?'} 在 SIGKILL 之后仍未退出，可能有残留进程，请手动检查。`;
}

/** Deliver a signal. `false` means "already dead", which is a success. */
function signal(child: SpawnedChild, sig: NodeJS.Signals): boolean {
  try {
    return child.kill(sig);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

function exited(launched: LaunchedChild, waitMs: number): Promise<boolean> {
  const { child, state } = launched;
  if (state.exited) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, waitMs);
    child.once('exit', onExit);
  });
}

/** Fold a failed cleanup into the error that is already on its way out. */
function withNote(error: CliError, note: string | null): CliError {
  if (note === null) return error;
  return new CliError(error.code, `${error.message}\n${note}`, {
    ...error.details,
    cleanup_failed: true,
  });
}

const CODE_BY_STATE = {
  absent: 'DAEMON_UNAVAILABLE',
  'other-nest': 'DAEMON_OTHER_NEST',
  'same-nest-incompatible': 'DAEMON_INCOMPATIBLE',
  'occupied-unverifiable': 'DAEMON_UNVERIFIED',
} as const;

const HINT: Record<keyof typeof CODE_BY_STATE, string> = {
  absent: '',
  'other-nest': '——先停掉那个实例，或者切到它的数据目录。',
  'same-nest-incompatible': '——先 `lark stop-daemon` 停掉旧实例。',
  'occupied-unverifiable': '——拒绝启动第二个（fail-closed）。',
};

/** Why we will not start one, in the same shape `status` reports. */
function refuse(identity: DaemonIdentity): CliError {
  if (identity.state === 'current') {
    throw new Error('refuse() called on a running daemon'); // unreachable
  }
  return new CliError(
    CODE_BY_STATE[identity.state],
    `${describeIdentity(identity)}${HINT[identity.state]}`,
    { identity: identityDetails(identity) },
  );
}
