// One place where a command gets everything it needs (M6-1).
//
// `withContext(need, opts, body)` resolves the identity ONCE, decides a mode
// from it, hands the command a backend, and is the only place that knows about
// `--direct`. Commands therefore never probe, never branch on identity, and
// never see the flag: they declare what they need and receive it.

import { inspectPidReadonly } from '@lark/core/daemon-control';
import { pidPath } from '@lark/core/paths';
import { createHttpBackend } from './backend/http.js';
import { type BackendNeed, type ModeDecision, decideMode } from './backend/resolve.js';
import type { Backend } from './backend/types.js';
import { CliError } from './lib/errors.js';
import { IdentityHandle } from './lib/identity.js';
import { type Streams, processStreams } from './lib/output.js';

export interface GlobalFlags {
  json: boolean;
  direct: boolean;
  yes: boolean;
}

export interface CommandContext {
  backend: Backend;
  streams: Streams;
  flags: GlobalFlags;
  identity: IdentityHandle;
  /** How the backend was chosen. Commands rarely care; `status` does. */
  mode: ModeDecision;
}

export interface ContextOptions {
  flags: GlobalFlags;
  streams?: Streams;
  identity?: IdentityHandle;
  /** Whether this command may start a daemon (play / gui only). */
  canLaunch?: boolean;
}

export async function withContext<T>(
  need: BackendNeed,
  options: ContextOptions,
  body: (ctx: CommandContext) => Promise<T>,
): Promise<T> {
  const streams = options.streams ?? processStreams;
  const identity = options.identity ?? new IdentityHandle();

  const mode = decideMode({
    need,
    direct: options.flags.direct,
    identity: await identity.resolve(),
    localPid: inspectPidReadonly(pidPath()),
    ...(options.canLaunch === undefined ? {} : { canLaunch: options.canLaunch }),
  });

  const backend = await backendFor(mode, streams);
  return await body({ backend, streams, flags: options.flags, identity, mode });
}

async function backendFor(mode: ModeDecision, streams: Streams): Promise<Backend> {
  switch (mode.kind) {
    case 'error':
      throw new CliError(mode.code, mode.message);
    case 'http':
      return createHttpBackend();
    case 'direct-read':
    case 'direct-write':
      if (mode.kind === 'direct-read' && mode.note !== undefined) streams.err(mode.note);
      // SEAM (removed in T3): the mode matrix already decided correctly — what
      // is missing is the backend that would serve it. Reported as "no daemon"
      // rather than as a usage error, because that is the situation the user
      // is actually in.
      throw new CliError(
        'DAEMON_UNAVAILABLE',
        '本地直连（--direct）后端尚未落地——先启动 daemon：`lark daemon`。',
      );
    case 'launch':
      // SEAM (removed in T5): `ensureDaemon` is what fills this in.
      throw new CliError('DAEMON_UNAVAILABLE', 'daemon 未在运行——先跑 `lark daemon`。');
  }
}
