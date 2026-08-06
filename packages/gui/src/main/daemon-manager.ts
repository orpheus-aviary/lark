// Daemon probe / identity verification / spawn / ownership / stop — the whole
// M4-2 contract in one electron-free class. `index.ts` wires the real fetch,
// child_process and fs; tests inject fakes and cover every refusal branch.
//
// Ownership model (owl's, tightened): the GUI owns EXACTLY the daemon child it
// spawned and confirmed via `status.pid === child.pid`. A reused daemon is
// never owned; a foreign daemon is never signalled, let alone stopped.

import { LOCAL_API_VERSION } from '@lark/daemon/version';
import type { ApiResponse, InstanceData, StatusData } from '@lark/shared';
import { API_PATHS } from '@lark/shared';

/** Why the GUI refuses to start. `userMessage` is the dialog text, verbatim. */
export type DaemonStartFailure =
  | 'nest-mismatch'
  | 'api-version-mismatch'
  | 'auth-failed'
  | 'token-unreadable'
  | 'unverifiable'
  | 'spawn-failed'
  | 'confirm-timeout';

export class DaemonStartError extends Error {
  readonly failure: DaemonStartFailure;
  readonly userMessage: string;

  constructor(failure: DaemonStartFailure, userMessage: string) {
    super(`${failure}: ${userMessage}`);
    this.name = 'DaemonStartError';
    this.failure = failure;
    this.userMessage = userMessage;
  }
}

const FAILURE_MESSAGES: Record<DaemonStartFailure, string> = {
  'nest-mismatch':
    '端口 47100 被另一数据目录的 lark daemon 占用。请先停止那个实例（just stop-daemon），再启动本 GUI。',
  'api-version-mismatch':
    '端口上的 lark daemon 版本与本 GUI 不兼容。请手动停止旧实例（just stop-daemon）后重启 GUI。',
  'auth-failed': '无法通过本数据目录的 token 连接已运行的 daemon。请停止该实例后重启 GUI。',
  'token-unreadable':
    '检测到运行中的 daemon，但本数据目录下没有可读的 daemon-token 文件，无法确认其身份。',
  unverifiable: '端口 47100 已被占用，且无法确认对方是本数据目录的 lark daemon。',
  'spawn-failed': 'daemon 启动失败。请查看 logs/lark.log。',
  'confirm-timeout': 'daemon 启动超时。请查看 logs/lark.log。',
};

function startError(failure: DaemonStartFailure): DaemonStartError {
  return new DaemonStartError(failure, FAILURE_MESSAGES[failure]);
}

/** The slice of ChildProcess the manager needs — what test fakes implement. */
export interface DaemonChild {
  readonly pid?: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
  unref(): void;
  once(event: 'exit', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export interface SpawnDaemonOptions {
  env: NodeJS.ProcessEnv;
  detached: boolean;
  stdio: 'ignore';
}

export type DaemonAttachment = { kind: 'reused'; pid: number } | { kind: 'owned'; pid: number };

export interface DaemonManagerDeps {
  /** `http://127.0.0.1:47100` */
  baseUrl: string;
  /** realpath of the local lark data dir (from `ensureNestIdentity`). */
  realLarkDir: string;
  /** The local nest's `daemon-token` file. */
  tokenPath: string;
  /** Resolved path of `@lark/daemon/cli` (the GUI resolves it, owl-style). */
  daemonCliPath: string;
  /** `process.execPath` — the Electron binary, run as Node. */
  execPath: string;
  /** Environment for the child. Inherited, incl. LARK_NEST_DIR; NEVER a token. */
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  spawnImpl?: (command: string, args: string[], options: SpawnDaemonOptions) => DaemonChild;
  readFileImpl?: (path: string) => string;
  realpathImpl?: (path: string) => string;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  probeTimeoutMs?: number;
  spawnWaitMs?: number;
  spawnPollMs?: number;
  stopTimeoutMs?: number;
  stopPollMs?: number;
}

interface Ownership {
  pid: number;
  child: DaemonChild;
  exited: boolean;
}

export class DaemonManager {
  readonly #deps: DaemonManagerDeps &
    Required<
      Pick<
        DaemonManagerDeps,
        | 'fetchImpl'
        | 'sleep'
        | 'log'
        | 'probeTimeoutMs'
        | 'spawnWaitMs'
        | 'spawnPollMs'
        | 'stopTimeoutMs'
        | 'stopPollMs'
      >
    >;

  #ownership: Ownership | null = null;
  /** An in-flight `start()`, so a quit can wait for it (M5-3). */
  #starting: Promise<DaemonAttachment> | null = null;

  constructor(deps: DaemonManagerDeps) {
    this.#deps = {
      fetchImpl: fetch,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: () => {},
      probeTimeoutMs: 1000,
      spawnWaitMs: 10_000,
      spawnPollMs: 500,
      stopTimeoutMs: 3000,
      stopPollMs: 100,
      ...deps,
    };
  }

  /** The confirmed-owned daemon pid, or null. Exposed for assertions/logging. */
  get ownedPid(): number | null {
    return this.#ownership?.pid ?? null;
  }

  /**
   * Attach to a daemon: reuse a verified same-nest instance, or spawn and
   * confirm one. Every refusal throws `DaemonStartError` — none of those
   * branches spawns, and none touches the foreign process.
   */
  async start(): Promise<DaemonAttachment> {
    const attempt = this.#attach();
    this.#starting = attempt;
    try {
      return await attempt;
    } finally {
      if (this.#starting === attempt) this.#starting = null;
    }
  }

  /**
   * Resolve once any in-flight `start()` has settled (M5-3). Quitting while a
   * spawn is in flight would otherwise see `ownedPid === null`, skip the stop,
   * and leave the daemon that finished confirming a moment later running with
   * nobody to shut it down.
   */
  async settle(): Promise<void> {
    try {
      await this.#starting;
    } catch {
      // A failed start has nothing to clean up; `start()`'s caller reported it.
    }
  }

  async #attach(): Promise<DaemonAttachment> {
    const status = await this.#probeStatus();
    if (status !== null) return await this.#verifyReusable(status);
    return await this.#spawnAndConfirm();
  }

  /**
   * Stop the owned daemon, if any (M4-2⑤). Before signalling, re-probe that
   * the port still answers with the owned pid — the child may have died and
   * the OS may have recycled its pid onto an unrelated process (never signal
   * on a mismatch). SIGTERM, then SIGKILL after `stopTimeoutMs`.
   */
  async stop(): Promise<void> {
    const owned = this.#ownership;
    if (owned === null) return;
    this.#ownership = null;
    if (owned.exited) return;

    const status = await this.#probeStatus();
    if (status === null || status.pid !== owned.pid) {
      this.#deps.log(`[daemon] not signalling: /status pid ${status?.pid ?? 'gone'} ≠ owned pid`);
      return;
    }

    owned.child.kill('SIGTERM');
    const deadline = Date.now() + this.#deps.stopTimeoutMs;
    while (!owned.exited && Date.now() < deadline) {
      await this.#deps.sleep(this.#deps.stopPollMs);
    }
    if (!owned.exited) {
      this.#deps.log('[daemon] SIGTERM timed out — SIGKILL');
      owned.child.kill('SIGKILL');
    }
  }

  /** `GET /status` (1s timeout). Null = connection-level failure = no daemon. */
  async #probeStatus(): Promise<StatusData | null> {
    let response: Response;
    try {
      response = await this.#deps.fetchImpl(`${this.#deps.baseUrl}${API_PATHS.status}`, {
        signal: AbortSignal.timeout(this.#deps.probeTimeoutMs),
      });
    } catch {
      return null;
    }
    // The port answered HTTP but not as a lark daemon — that is NOT "no
    // daemon": spawning against an occupied port is a guaranteed race.
    try {
      const body = (await response.json()) as ApiResponse<StatusData>;
      const data = body?.data;
      if (response.status !== 200 || typeof data?.pid !== 'number')
        throw startError('unverifiable');
      return data;
    } catch (err) {
      if (err instanceof DaemonStartError) throw err;
      throw startError('unverifiable');
    }
  }

  /**
   * M4-2② — the frozen branch matrix over `GET /api/instance`. A token
   * round-trip alone proves only that both directories hold the same token
   * file copy; `nest_dir` (realpath'd on both sides) is what ties the port to
   * a data directory.
   */
  async #verifyReusable(status: StatusData): Promise<DaemonAttachment> {
    let token: string;
    try {
      token = this.#readToken();
    } catch {
      throw startError('token-unreadable');
    }

    let response: Response;
    try {
      response = await this.#deps.fetchImpl(`${this.#deps.baseUrl}${API_PATHS.instance}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.#deps.probeTimeoutMs),
      });
    } catch {
      throw startError('unverifiable');
    }

    if (response.status === 401) throw startError('auth-failed');
    // An M3-or-earlier daemon has no such route — a version gap, not a 404 to
    // shrug off (and absolutely not a spawn: the port is taken).
    if (response.status === 404) throw startError('api-version-mismatch');
    if (response.status !== 200) throw startError('unverifiable');

    let instance: InstanceData;
    try {
      const body = (await response.json()) as ApiResponse<InstanceData>;
      if (typeof body?.data?.nest_dir !== 'string') throw new Error('malformed');
      instance = body.data;
    } catch {
      throw startError('unverifiable');
    }

    if (!this.#sameDir(instance.nest_dir, this.#deps.realLarkDir)) {
      throw startError('nest-mismatch');
    }
    if (instance.local_api_version !== LOCAL_API_VERSION) {
      throw startError('api-version-mismatch');
    }

    this.#deps.log(`[daemon] reusing daemon pid=${status.pid} (never owned)`);
    return { kind: 'reused', pid: status.pid };
  }

  /** M4-2③④ — spawn, confirm by pid, recycle the child on any failure. */
  async #spawnAndConfirm(): Promise<DaemonAttachment> {
    const spawnImpl = this.#deps.spawnImpl;
    if (!spawnImpl) throw new Error('DaemonManager: spawnImpl is required to spawn');

    let child: DaemonChild;
    let spawnErrored = false;
    try {
      // ELECTRON_RUN_AS_NODE turns the Electron binary into plain Node for the
      // child; the daemon cli's `program.parse(argv, {from:'node'})` is already
      // shaped for it (M2). No token in env — the daemon generates and
      // publishes its own (R29); injecting one is exactly the owl regression
      // this test suite guards against.
      child = spawnImpl(this.#deps.execPath, [this.#deps.daemonCliPath, 'daemon'], {
        env: { ...this.#deps.env, ELECTRON_RUN_AS_NODE: '1' },
        detached: true,
        stdio: 'ignore',
      });
    } catch {
      throw startError('spawn-failed');
    }
    child.on('error', () => {
      spawnErrored = true;
    });
    child.unref();

    const state = { exited: false };
    child.once('exit', () => {
      state.exited = true;
      // Ownership hygiene (M4-2④): a dead child is not owned, whoever asks.
      if (this.#ownership?.child === child) this.#ownership = null;
    });

    const deadline = Date.now() + this.#deps.spawnWaitMs;
    while (Date.now() < deadline) {
      await this.#deps.sleep(this.#deps.spawnPollMs);
      if (spawnErrored) throw startError('spawn-failed');

      let status: StatusData | null;
      try {
        status = await this.#probeStatus();
      } catch {
        // Port answered but unverifiable — keep polling: our child may still
        // be mid-listen, or a racing winner will be verified below on its pid.
        continue;
      }
      if (status === null) {
        // No daemon yet. If our child already died, it never will be.
        if (state.exited) throw startError('spawn-failed');
        continue;
      }

      if (child.pid !== undefined && status.pid === child.pid) {
        const ownership: Ownership = { pid: child.pid, child, exited: false };
        child.once('exit', () => {
          ownership.exited = true;
        });
        this.#ownership = ownership;
        this.#deps.log(`[daemon] spawned and confirmed pid=${child.pid} (owned)`);
        return { kind: 'owned', pid: child.pid };
      }

      // Startup race: someone else's daemon won the port. Our child lost and
      // can only linger — recycle it (it never got ownership), then treat the
      // winner like any pre-existing daemon: verify, reuse or refuse.
      this.#deps.log(`[daemon] lost startup race to pid=${status.pid} — recycling own child`);
      if (!state.exited) child.kill('SIGTERM');
      return await this.#verifyReusable(status);
    }

    // Timeout: never confirmed. Do not leave a late-arriving orphan daemon.
    if (!state.exited) child.kill('SIGTERM');
    throw startError('confirm-timeout');
  }

  #readToken(): string {
    const readFileImpl = this.#deps.readFileImpl;
    if (!readFileImpl) throw new Error('DaemonManager: readFileImpl is required');
    const token = readFileImpl(this.#deps.tokenPath).trim();
    if (token === '') throw new Error('empty token file');
    return token;
  }

  #sameDir(a: string, b: string): boolean {
    const realpathImpl = this.#deps.realpathImpl ?? ((p: string) => p);
    // The daemon already realpaths its side; ours arrives realpath'd from
    // ensureNestIdentity. Re-normalising both is cheap insurance, but a path
    // that no longer resolves must read as "not my nest", never crash.
    const norm = (p: string): string => {
      try {
        return realpathImpl(p);
      } catch {
        return p;
      }
    };
    return norm(a) === norm(b);
  }
}
