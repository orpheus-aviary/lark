// A skybridge server that lives in a variable (v0.2 T3b).
//
// The login sequence has seven places it can fail and a compensation order
// that only matters when it does, so the tests need a server they can break on
// purpose — and, just as importantly, one that RECORDS what was called. Half
// the contract is about calls that must NOT happen: no revoke of a device we
// merely reused, no second registration on an ordinary re-login.

import { randomUUID } from 'node:crypto';
import { ApiError, type SubscribeHandlers } from '@orpheus-aviary/skybridge-client';
import type {
  ApiDevice,
  ApiRefreshResult,
  ApiWorkspace,
  LocalChange,
  ServerChange,
} from '@orpheus-aviary/skybridge-proto';
import type { AuthContext, SkybridgeApi, SkybridgeClient } from '../sync/client.js';

/** Every call the daemon makes, in the order it makes them. */
export type FakeSkybridgeCall =
  | 'login'
  | 'refresh'
  | 'serverTime'
  | 'createClient'
  | 'listDevices'
  | 'registerDevice'
  | 'ensureWorkspace'
  | 'revokeDevice'
  | 'logout'
  | 'push'
  | 'pull';

export interface FakeSkybridgeOptions {
  serverId?: string;
  userId?: string;
  email?: string;
  workspaceId?: string;
  schemaVersion?: number;
  /** Devices the account already has. */
  devices?: ApiDevice[];
  serverTimeMs?: number;
}

export interface FakeSkybridge {
  api: SkybridgeApi;
  /** Ordered call log, with the argument that matters where there is one. */
  readonly calls: string[];
  readonly devices: Map<string, ApiDevice>;
  workspace: ApiWorkspace;
  serverTimeMs: number;
  /** Make the next (and every later) call to this stage throw. */
  failAt(call: FakeSkybridgeCall, error?: unknown): void;
  /**
   * Make the Nth `createClient` FROM NOW throw — the seam for "the SDK broke
   * after the transaction committed and the new toml was written". Counted
   * from the call to this method, not from the fake's birth, so a test that
   * already logged in once does not have to add up the earlier rounds.
   */
  failCreateClientOnCall(n: number): void;
  clearFailures(): void;
  /** How many times a stage was called. */
  count(call: FakeSkybridgeCall): number;
  /** Hand the next pull (and only that one) this batch. */
  queuePull(changes: ServerChange[]): void;
  /** Everything the daemon has pushed, in order. */
  readonly pushed: LocalChange[];
  /** The last handler set installed by `subscribeEvents`, if any. */
  readonly stream: { handlers: SubscribeHandlers; closed: boolean } | null;
  /** Pretend the server pushed: fires the stream's `onChange`. */
  emitRemoteChange(latestSeq: number): void;
}

export function makeDevice(id: string, overrides: Partial<ApiDevice> = {}): ApiDevice {
  return {
    id,
    name: `device ${id}`,
    platform: 'darwin',
    appVersion: 'lark 0.1.0',
    clientVersion: '0.1.4',
    createdAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    revokedAt: null,
    ...overrides,
  };
}

export function createFakeSkybridge(options: FakeSkybridgeOptions = {}): FakeSkybridge {
  const calls: string[] = [];
  const devices = new Map<string, ApiDevice>(
    (options.devices ?? []).map((device) => [device.id, device]),
  );
  const failures = new Map<FakeSkybridgeCall, unknown>();
  const pushed: LocalChange[] = [];
  const pullQueue: ServerChange[][] = [];
  let stream: { handlers: SubscribeHandlers; closed: boolean } | null = null;
  let createClientCalls = 0;
  let failCreateClientAt: number | null = null;
  let nextDeviceId = 1;

  const state = {
    serverId: options.serverId ?? 'server-1',
    userId: options.userId ?? 'user-1',
    email: options.email ?? 'someone@example.test',
    workspace: {
      id: options.workspaceId ?? 'workspace-1',
      tool: 'lark',
      name: 'default',
      schemaVersion: options.schemaVersion ?? 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    } satisfies ApiWorkspace,
    serverTimeMs: options.serverTimeMs ?? 1_700_000_000_000,
    latestSeq: 0,
  };

  function record(call: FakeSkybridgeCall, detail?: string): void {
    calls.push(detail === undefined ? call : `${call}:${detail}`);
    const failure = failures.get(call);
    if (failure !== undefined) throw failure;
  }

  const client = (deviceId?: string): SkybridgeClient => ({
    async registerDevice(input) {
      record('registerDevice');
      const device = makeDevice(`device-${nextDeviceId++}`, { name: input.name });
      devices.set(device.id, device);
      return device;
    },
    async listDevices() {
      record('listDevices');
      return [...devices.values()];
    },
    async ensureWorkspace(tool, name) {
      record('ensureWorkspace', `${tool}/${name}`);
      return state.workspace;
    },
    async revokeDevice(id) {
      record('revokeDevice', id);
      const device = devices.get(id);
      if (device !== undefined) devices.set(id, { ...device, revokedAt: state.serverTimeMs });
    },
    async logout() {
      record('logout');
    },
    async pushChanges(_workspaceId, changes) {
      record('push', deviceId ?? '');
      const accepted = changes.map((change) => {
        pushed.push(change);
        state.latestSeq += 1;
        return { clientChangeId: change.clientChangeId, serverSeq: state.latestSeq };
      });
      return {
        accepted,
        duplicates: [],
        latestSeq: state.latestSeq,
        serverTime: state.serverTimeMs,
      };
    },
    async pullChanges() {
      record('pull', deviceId ?? '');
      const batch = pullQueue.shift() ?? [];
      for (const change of batch) state.latestSeq = Math.max(state.latestSeq, change.serverSeq);
      return {
        changes: batch,
        hasMore: pullQueue.length > 0,
        latestSeq: state.latestSeq,
        serverTime: state.serverTimeMs,
      };
    },
    subscribeEvents(_workspaceId, handlers) {
      stream = { handlers, closed: false };
      return () => {
        if (stream !== null) stream.closed = true;
      };
    },
  });

  const api: SkybridgeApi = {
    async login(serverUrl, email, password) {
      record('login', serverUrl);
      if (password === 'wrong') {
        throw new ApiError('INVALID_CREDENTIALS', 401, 'email or password is wrong');
      }
      const auth: AuthContext = {
        serverUrl,
        token: `token-for-${email}`,
        user: { id: state.userId, email, displayName: null },
        refreshToken: 'refresh-token',
        expiresAt: state.serverTimeMs + 3_600_000,
        serverId: state.serverId,
      };
      return auth;
    },
    async refresh(_serverUrl, _refreshToken): Promise<ApiRefreshResult> {
      record('refresh');
      return {
        token: 'token-refreshed',
        refreshToken: 'refresh-token-2',
        expiresAt: state.serverTimeMs + 3_600_000,
      };
    },
    async serverTime() {
      record('serverTime');
      return state.serverTimeMs;
    },
    createClient(opts) {
      createClientCalls += 1;
      record('createClient', opts.deviceId ?? 'bootstrap');
      if (failCreateClientAt === createClientCalls) {
        throw new Error('the SDK fell over while building the session');
      }
      return client(opts.deviceId);
    },
  };

  return {
    api,
    calls,
    devices,
    get workspace() {
      return state.workspace;
    },
    set workspace(next: ApiWorkspace) {
      state.workspace = next;
    },
    get serverTimeMs() {
      return state.serverTimeMs;
    },
    set serverTimeMs(next: number) {
      state.serverTimeMs = next;
    },
    failAt(call, error) {
      failures.set(call, error ?? new ApiError('SERVER_ERROR', 500, `${call} failed`));
    },
    failCreateClientOnCall(n) {
      failCreateClientAt = createClientCalls + n;
    },
    clearFailures() {
      failures.clear();
      failCreateClientAt = null;
    },
    count(call) {
      return calls.filter((entry) => entry === call || entry.startsWith(`${call}:`)).length;
    },
    queuePull(changes) {
      pullQueue.push(changes);
    },
    pushed,
    get stream() {
      return stream;
    },
    emitRemoteChange(latestSeq) {
      stream?.handlers.onChange(latestSeq);
    },
  };
}

/** A minimal inbound song `create`, ready to hand to `queuePull`. */
export function remoteSongCreate(options: {
  serverSeq: number;
  songId: string;
  deviceId?: string;
  name?: string;
  updatedAtMs?: number;
}): ServerChange {
  const updatedAt = options.updatedAtMs ?? 1_700_000_000_000;
  return {
    serverSeq: options.serverSeq,
    deviceId: options.deviceId ?? 'device-peer',
    clientChangeId: randomUUID(),
    entityType: 'song',
    entityId: options.songId,
    op: 'create',
    payload: {
      name: options.name ?? '远端的歌',
      artist: '远端',
      source_url: null,
      source_provider: null,
      source_key: null,
      lyrics_offset: 0,
      duration: 0,
      created_at_ms: updatedAt,
      updated_at_ms: updatedAt,
      lww_counter: 0,
    },
    clientLocalSeq: 1,
    clientCreatedAt: updatedAt,
    serverReceivedAt: updatedAt,
    attachmentRefs: null,
  };
}
