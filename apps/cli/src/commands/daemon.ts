// `lark daemon` / `lark stop-daemon` (M6-9).
//
// Neither takes a backend: they are about the PROCESS, not the library, and
// wiring them through a backend would mean refusing to stop a daemon whose
// database is broken — exactly when stopping it matters most.
//
// Both are idempotent in the direction they push. Starting one that is already
// running is `{started: false}` and exit 0; stopping one that is not running is
// `{stopped: false, pid: null}` and exit 0. A script should be able to say
// "make sure it is (not) running" without first asking whether it is.
//
// Stopping is the five-step protocol from M2-3, unchanged and living in core:
// prove identity over `/status`, match the pid against the file, THEN signal,
// then wait for the process to actually be gone. Every refusal leaves the
// process and its pid file untouched.

import { type StopOutcome, stopDaemonVerified } from '@lark/core/daemon-control';
import { type EnsureDaemonDeps, ensureDaemon } from '../lib/ensure-daemon.js';
import { CliError } from '../lib/errors.js';
import { type IdentityResolver, describeIdentity, identityDetails } from '../lib/identity.js';
import { type Streams, emitEnvelope, successEnvelope } from '../lib/output.js';

export interface DaemonCommandDeps {
  identity: IdentityResolver;
  streams: Streams;
  json: boolean;
}

/** Overrides for the spawn machinery; production passes none. */
export type StartOverrides = Omit<EnsureDaemonDeps, 'identity'>;

export async function runDaemonStart(
  deps: DaemonCommandDeps,
  overrides: StartOverrides = {},
): Promise<void> {
  const result = await ensureDaemon({ ...overrides, identity: deps.identity });
  const data = { started: result.started, pid: result.pid };

  if (deps.json) {
    const message = result.note ?? (result.started ? 'daemon started' : 'daemon already running');
    return emitEnvelope(deps.streams, successEnvelope(data, { message }));
  }
  deps.streams.out(
    result.started
      ? `✓ daemon 已启动（pid ${result.pid}）`
      : `✓ daemon 已经在运行（pid ${result.pid}）`,
  );
  if (result.note !== undefined) deps.streams.err(result.note);
}

export interface StopOverrides {
  stop?: typeof stopDaemonVerified;
}

export async function runStopDaemon(
  deps: DaemonCommandDeps,
  overrides: StopOverrides = {},
): Promise<void> {
  const identity = await deps.identity.resolve();

  switch (identity.state) {
    case 'absent':
      // Nothing to stop. Reporting that as an error would make "ensure it is
      // stopped" a two-branch script for no reason.
      return finish(deps, { stopped: false, pid: null }, 'daemon 本来就没在运行');
    case 'other-nest':
      throw new CliError('DAEMON_OTHER_NEST', `${describeIdentity(identity)}——不停别人的进程。`, {
        identity: identityDetails(identity),
      });
    case 'occupied-unverifiable':
      throw new CliError(
        'DAEMON_UNVERIFIED',
        `${describeIdentity(identity)}——无法确认对方是本数据目录的 lark daemon，拒绝发信号。`,
        { identity: identityDetails(identity) },
      );
    // `current` and `same-nest-incompatible` both get stopped: the five-step
    // protocol never looks at the protocol version, and "stop the old
    // instance" is the whole way out of an incompatible one (M6-9).
    default:
      break;
  }

  const stop = overrides.stop ?? stopDaemonVerified;
  let outcome: StopOutcome;
  try {
    outcome = await stop();
  } catch (err) {
    if (err instanceof Error && err.name === 'PidFileCorruptError') {
      throw new CliError('DAEMON_UNVERIFIED', err.message);
    }
    throw err;
  }

  switch (outcome.kind) {
    case 'not-running':
      return finish(deps, { stopped: false, pid: null }, 'daemon 本来就没在运行');
    case 'stopped':
      return finish(
        deps,
        { stopped: true, pid: outcome.pid },
        `daemon 已停止（pid ${outcome.pid}）`,
      );
    case 'refused':
      throw new CliError('DAEMON_UNVERIFIED', `拒绝发信号：${outcome.detail}`, {
        pid: outcome.pid,
        reason: outcome.reason,
      });
    case 'timeout':
      throw new CliError(
        'SHUTTING_DOWN',
        `已经发了 SIGTERM，但 pid ${outcome.pid} 在 ${Math.round(outcome.waitedMs / 1000)}s 内还没退出——它可能正在收尾，稍后再看一次。`,
        { pid: outcome.pid },
      );
  }
}

function finish(
  deps: DaemonCommandDeps,
  data: { stopped: boolean; pid: number | null },
  line: string,
): void {
  if (deps.json) {
    emitEnvelope(deps.streams, successEnvelope(data, { message: line }));
    return;
  }
  deps.streams.out(`✓ ${line}`);
}
