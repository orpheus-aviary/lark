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

  const opened = await backendFor(mode, streams);
  try {
    return await body({ backend: opened.backend, streams, flags: options.flags, identity });
  } finally {
    // A direct backend holds a database handle — and, for a write, the writer
    // lock. Both are released here whether the command succeeded or threw:
    // the lock is a cross-process resource, and leaking it would block the
    // next daemon boot for its whole 5s budget.
    opened.close();
  }
}

interface OpenedBackend {
  backend: Backend;
  close(): void;
}

async function backendFor(mode: ModeDecision, streams: Streams): Promise<OpenedBackend> {
  switch (mode.kind) {
    case 'error':
      throw new CliError(mode.code, mode.message);
    case 'http':
      return { backend: createHttpBackend(), close: () => {} };
    case 'direct-read':
    case 'direct-write': {
      if (mode.kind === 'direct-read' && mode.note !== undefined) streams.err(mode.note);
      // The ONE dynamic import of `@lark/core`'s barrel (M6-21): everything
      // above this line runs without loading better-sqlite3.
      const { createDirectBackend } = await import('./backend/direct.js');
      return await createDirectBackend({
        mode: mode.kind === 'direct-read' ? 'read' : 'write',
      });
    }
    case 'launch':
      // SEAM (removed in T5): `ensureDaemon` is what fills this in.
      throw new CliError('DAEMON_UNAVAILABLE', 'daemon 未在运行——先跑 `lark daemon`。');
  }
}
