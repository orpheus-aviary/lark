// Who, if anyone, is on port 47100 (M6-19).
//
// Five states, because "is a daemon running?" has five useful answers and
// collapsing them costs the user either safety or capability:
//
//   absent                    nothing there — a `--direct` write may proceed
//   current                   OUR daemon, on this nest, speaking our protocol
//   other-nest                a lark daemon for a DIFFERENT data directory:
//                             HTTP would be wrong, but a `--direct` write on
//                             this nest is perfectly safe
//   same-nest-incompatible    our nest, wrong protocol version — "stop the old
//                             instance", not "there is nothing there"
//   occupied-unverifiable     something is on the port, or holds the pid file,
//                             and cannot be identified. Fail closed.
//
// What makes the middle three reachable at all is the public fingerprint on
// `/status` (M6-19): before it, `/api/instance` was the only thing tying a
// port to a directory, and reading it needs the token of the nest that
// published it — so another nest's daemon was indistinguishable from an
// unreachable one, and every ambiguous case had to be refused.
//
// LINE FORMAT IS AN EXPLICIT UNION. Both fields present and well-formed is the
// M6 shape; both ABSENT is the pre-M6 shape; anything in between — one field,
// an empty string, a bad hash, a non-integer version — is not something to
// guess about, and lands in unverifiable.

import { type PidInspection, inspectPidReadonly } from '@lark/core/daemon-control';
import {
  isNestFingerprint,
  nestFingerprint,
  probeStatus,
  realpathMissingOk,
} from '@lark/core/daemon-control';
import { larkDir, pidPath } from '@lark/core/paths';
import { API_PATHS, LOCAL_API_VERSION, type StatusData } from '@lark/shared';
import { daemonAuthHeaders } from './auth.js';

export type UnverifiableReason =
  | 'pid-file-live'
  | 'pid-file-corrupt'
  | 'malformed-status'
  | 'auth-failed'
  | 'instance-unreachable'
  | 'pid-unstable'
  | 'token-unreadable';

export type DaemonIdentity =
  | { state: 'absent' }
  | { state: 'current'; status: StatusData; pid: number }
  | { state: 'other-nest'; pid: number | null; fingerprint: string | null }
  | { state: 'same-nest-incompatible'; pid: number | null; remoteApiVersion: number | null }
  | { state: 'occupied-unverifiable'; reason: UnverifiableReason; pid: number | null };

/** The `/status` body, classified before anything is believed about it. */
export type StatusShape =
  | { kind: 'current'; status: StatusData }
  | { kind: 'legacy'; pid: number | null }
  | { kind: 'invalid' };

/**
 * Classify a `/status` payload into the wire-format union.
 *
 * `nest_fingerprint` and `local_api_version` are REQUIRED from M6 on, so a
 * response carrying neither is a pre-M6 daemon (legacy) — while one carrying a
 * half-set or malformed pair is a daemon that cannot be reasoned about at all.
 */
export function classifyStatus(data: unknown): StatusShape {
  if (typeof data !== 'object' || data === null) return { kind: 'invalid' };
  const body = data as Record<string, unknown>;

  const pid = typeof body.pid === 'number' && Number.isSafeInteger(body.pid) ? body.pid : null;
  const hasFingerprint = 'nest_fingerprint' in body;
  const hasVersion = 'local_api_version' in body;

  if (!hasFingerprint && !hasVersion) return { kind: 'legacy', pid };

  const fingerprintOk = isNestFingerprint(body.nest_fingerprint);
  const versionOk =
    typeof body.local_api_version === 'number' &&
    Number.isSafeInteger(body.local_api_version) &&
    body.local_api_version > 0;
  if (!hasFingerprint || !hasVersion || !fingerprintOk || !versionOk) return { kind: 'invalid' };

  if (body.status !== 'ok' || pid === null || typeof body.version !== 'string') {
    return { kind: 'invalid' };
  }
  return { kind: 'current', status: body as unknown as StatusData };
}

export interface IdentityDeps {
  /** `GET /status` — injected so tests never touch a socket. */
  probe?: typeof probeStatus;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Reads the pid file WITHOUT side effects. */
  inspectPid?: (path?: string) => PidInspection;
  /** Authorization header for `/api/instance`; `{}` when there is no token. */
  authHeaders?: () => Record<string, string>;
  /** This nest's fingerprint. Defaults to the real local one. */
  localFingerprint?: () => string;
  larkDirPath?: () => string;
  pidFilePath?: () => string;
}

interface InstanceReply {
  status: number;
  nestDir: string | null;
  pid: number | null;
  apiVersion: number | null;
}

/** How many times a pid disagreement is worth re-resolving before refusing. */
const PID_RETRIES = 2;

function localNestFingerprint(larkDirPath: () => string = larkDir): string {
  // `realpathMissingOk`, not `realpath`: a fresh nest has no directory yet, and
  // the fingerprint of a path that does not exist must equal the one the
  // daemon will publish after creating it (M6-19).
  return nestFingerprint(realpathMissingOk(larkDirPath()));
}

/**
 * Resolve the identity of whatever is on the port, once.
 *
 * Prefer {@link IdentityHandle} — this is the uncached primitive, and the
 * three places allowed to bypass the cache call it directly.
 */
export async function resolveIdentity(deps: IdentityDeps = {}): Promise<DaemonIdentity> {
  const {
    probe = probeStatus,
    inspectPid = inspectPidReadonly,
    authHeaders = daemonAuthHeaders,
    larkDirPath = larkDir,
    pidFilePath = pidPath,
    localFingerprint = () => localNestFingerprint(larkDirPath),
  } = deps;

  const probeArgs = {
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl }),
  };

  for (let attempt = 0; ; attempt++) {
    const answer = await probe(probeArgs);

    if (answer.kind === 'unreachable') {
      // Nothing answers. The pid file decides between "nobody is here" and
      // "something is here that cannot talk" — and is only ever READ: a CLI
      // must not tidy up a nest it may not own (M6-9).
      const inspection = inspectPid(pidFilePath());
      if (inspection.state === 'absent' || inspection.state === 'stale') return { state: 'absent' };
      return {
        state: 'occupied-unverifiable',
        reason: inspection.state === 'live' ? 'pid-file-live' : 'pid-file-corrupt',
        pid: inspection.pid,
      };
    }

    const shape = classifyStatus(answer.data);
    if (shape.kind === 'invalid') {
      return { state: 'occupied-unverifiable', reason: 'malformed-status', pid: null };
    }

    if (shape.kind === 'legacy') {
      // A pre-M6 daemon publishes no fingerprint, so the only evidence left is
      // whether it accepts OUR token. That proves same-nest; it cannot prove
      // the opposite, so a foreign old daemon stays unverifiable — an accepted
      // boundary (M6-19).
      const instance = await fetchInstance(deps, authHeaders());
      if (instance === null || instance.status === 401 || instance.status !== 200) {
        return {
          state: 'occupied-unverifiable',
          reason: instance?.status === 401 ? 'auth-failed' : 'instance-unreachable',
          pid: shape.pid,
        };
      }
      if (!sameNestDir(instance.nestDir, larkDirPath())) {
        return { state: 'other-nest', pid: shape.pid, fingerprint: null };
      }
      return {
        state: 'same-nest-incompatible',
        pid: shape.pid,
        remoteApiVersion: instance.apiVersion,
      };
    }

    const status = shape.status;
    if (status.nest_fingerprint !== localFingerprint()) {
      return { state: 'other-nest', pid: status.pid, fingerprint: status.nest_fingerprint };
    }
    if (status.local_api_version !== LOCAL_API_VERSION) {
      return {
        state: 'same-nest-incompatible',
        pid: status.pid,
        remoteApiVersion: status.local_api_version,
      };
    }

    // Same nest, same protocol. One authenticated round-trip left: it proves
    // we hold a token this daemon accepts, and — via the pid — that the daemon
    // that answered `/status` is the one answering now.
    const headers = authHeaders();
    if (headers.Authorization === undefined) {
      return { state: 'occupied-unverifiable', reason: 'token-unreadable', pid: status.pid };
    }
    const instance = await fetchInstance(deps, headers);
    if (instance === null || instance.status !== 200) {
      return {
        state: 'occupied-unverifiable',
        reason: instance?.status === 401 ? 'auth-failed' : 'instance-unreachable',
        pid: status.pid,
      };
    }
    if (!sameNestDir(instance.nestDir, larkDirPath())) {
      // Fingerprint said one thing and the authenticated answer another. That
      // is not a state to pick a winner in.
      return { state: 'occupied-unverifiable', reason: 'malformed-status', pid: status.pid };
    }
    if (instance.pid !== status.pid) {
      // A daemon restarted between the two calls. Re-resolve from scratch —
      // the whole picture may have changed — and refuse if it keeps moving.
      if (attempt < PID_RETRIES) continue;
      return { state: 'occupied-unverifiable', reason: 'pid-unstable', pid: status.pid };
    }

    return { state: 'current', status, pid: status.pid };
  }
}

async function fetchInstance(
  deps: IdentityDeps,
  headers: Record<string, string>,
): Promise<InstanceReply | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = deps.baseUrl ?? 'http://127.0.0.1:47100';
  try {
    const res = await fetchImpl(`${baseUrl}${API_PATHS.instance}`, {
      headers,
      signal: AbortSignal.timeout(1000),
    });
    if (res.status !== 200) {
      return { status: res.status, nestDir: null, pid: null, apiVersion: null };
    }
    const body = (await res.json()) as { data?: Record<string, unknown> };
    const data = body?.data ?? {};
    return {
      status: 200,
      nestDir: typeof data.nest_dir === 'string' ? data.nest_dir : null,
      pid: typeof data.pid === 'number' ? data.pid : null,
      apiVersion: typeof data.local_api_version === 'number' ? data.local_api_version : null,
    };
  } catch {
    return null;
  }
}

function sameNestDir(reported: string | null, localLarkDir: string): boolean {
  if (reported === null) return false;
  return realpathMissingOk(reported) === realpathMissingOk(localLarkDir);
}

/**
 * What a consumer needs from an identity — resolve it, or (in the three
 * sanctioned places) re-resolve it.
 *
 * An interface rather than the class, because `IdentityHandle` has private
 * state and is therefore nominal: a test that wants to script "absent, then
 * current" would otherwise have to drive it through fake sockets.
 */
export interface IdentityResolver {
  resolve(): Promise<DaemonIdentity>;
  resolveFresh(): Promise<DaemonIdentity>;
}

/**
 * A lazily resolved, cached identity.
 *
 * Cached because a single command may consult it several times (pick a
 * backend, decide whether to launch, report why it refused) and three probes
 * for one decision is both slow and — worse — capable of disagreeing with
 * itself mid-command.
 *
 * `resolveFresh()` is the deliberate escape hatch, and has exactly three
 * callers by design (M6-19): the pid-binding retry above, the limited re-probe
 * of a live-but-silent pid, and rebuilding identity after spawning a daemon.
 */
export class IdentityHandle implements IdentityResolver {
  #deps: IdentityDeps;
  #cached: Promise<DaemonIdentity> | null = null;

  constructor(deps: IdentityDeps = {}) {
    this.#deps = deps;
  }

  resolve(): Promise<DaemonIdentity> {
    this.#cached ??= resolveIdentity(this.#deps);
    return this.#cached;
  }

  /** Re-resolve and replace the cache. See the class note for who may call it. */
  resolveFresh(): Promise<DaemonIdentity> {
    this.#cached = resolveIdentity(this.#deps);
    return this.#cached;
  }
}

/** One-line diagnosis, for `status` and for every refusal message. */
export function describeIdentity(identity: DaemonIdentity): string {
  switch (identity.state) {
    case 'absent':
      return 'daemon 未在运行';
    case 'current':
      return `daemon 运行中（PID ${identity.pid}）`;
    case 'other-nest':
      return `端口 47100 上的 daemon 属于另一个数据目录${identity.pid === null ? '' : `（PID ${identity.pid}）`}`;
    case 'same-nest-incompatible':
      return `端口 47100 上的 daemon 是本数据目录的，但协议版本不兼容（对方 ${identity.remoteApiVersion ?? '未知'}，本地 ${LOCAL_API_VERSION}）`;
    case 'occupied-unverifiable':
      return `端口 47100 或 pid 文件被占用，且无法确认对方身份（${identity.reason}）`;
  }
}

/** The machine-readable half of the same diagnosis (`details.identity`). */
export function identityDetails(identity: DaemonIdentity): Record<string, unknown> {
  switch (identity.state) {
    case 'absent':
      return { state: 'absent' };
    case 'current':
      return {
        state: 'current',
        pid: identity.pid,
        local_api_version: identity.status.local_api_version,
      };
    case 'other-nest':
      return {
        state: 'other-nest',
        pid: identity.pid,
        fingerprint_match: false,
        remote_fingerprint: identity.fingerprint,
      };
    case 'same-nest-incompatible':
      return {
        state: 'same-nest-incompatible',
        pid: identity.pid,
        fingerprint_match: true,
        remote_api_version: identity.remoteApiVersion,
        local_api_version: LOCAL_API_VERSION,
      };
    case 'occupied-unverifiable':
      return { state: 'occupied-unverifiable', reason: identity.reason, pid: identity.pid };
  }
}
