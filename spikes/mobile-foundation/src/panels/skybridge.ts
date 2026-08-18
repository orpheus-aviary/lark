// Criterion 22 — does the skybridge SDK work from React Native.
//
// Hard gate: `login` / `refresh` / `pullChanges` / `pushChanges` against a real
// server. Soft: `subscribeEvents`, whose transport is a streaming fetch
// (`sse.ts:43-47` needs `res.body`) — N0b-3 showed the platform has that, but
// having `res.body` and holding a long-lived stream open are different claims.
//
// What this does NOT test: lark's sync semantics. No HLC, no LWW, no tombstones
// — the changes pushed here are synthetic (`entity_type: 'spike_probe'`), and
// the server takes any string. core's engine reaches `node:crypto` and
// `node:fs/promises` and cannot be imported here at all; it arrives at N1 and is
// re-verified with the real thing then.
//
// The server is `sync-host.mjs` on the desktop, reached over `adb reverse` —
// loopback over USB, so this panel keeps working while Wi-Fi is off for
// criterion 23's cellular pass. Plaintext HTTP is spike-only (decision f); the
// product line is https-only with a TLS deadline at N4 (D15).

import {
  type ApiWorkspace,
  type AuthContext,
  type LocalChange,
  type SkybridgeClient,
  createSkybridgeClient,
  login,
  refresh,
} from '@orpheus-aviary/skybridge-client';
import { randomUUID } from 'expo-crypto';
import { type SkybridgeFixture, loadFixtures, nudgeSkybridge } from '../fixtures';

export interface SyncProbeRow {
  name: string;
  /** null = evidence or "could not run", never a silent pass. */
  ok: boolean | null;
  /** The four hard gates of criterion 22 are marked; the rest are supporting. */
  gate: boolean;
  detail: string;
  ms: number;
}

const step = async <T>(
  rows: SyncProbeRow[],
  name: string,
  gate: boolean,
  body: () => Promise<[T, string]>,
): Promise<T | null> => {
  const started = Date.now();
  try {
    const [value, detail] = await body();
    rows.push({ name, ok: true, gate, detail, ms: Date.now() - started });
    return value;
  } catch (err) {
    rows.push({
      name,
      ok: false,
      gate,
      // The error class matters: ApiError carries the server's own code, and a
      // NetworkError means the phone never got an answer at all.
      detail: `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      ms: Date.now() - started,
    });
    return null;
  }
};

/** One synthetic change. `randomUUID` is the port core uses for client_change_id. */
function makeChange(seq: number): LocalChange {
  return {
    clientChangeId: randomUUID(),
    entityType: 'spike_probe',
    entityId: `probe-${seq}`,
    op: 'update',
    payload: { from: 'android', seq, at: Date.now() },
    clientLocalSeq: seq,
    clientCreatedAt: Date.now(),
    attachmentRefs: null,
  };
}

/**
 * The SSE half, which is soft.
 *
 * The event has to come from the DESKTOP (`probe-host.mjs`'s nudge): a device
 * that hears its own push has learnt something about the server's echo policy,
 * not about whether this stream carries other devices' work.
 */
async function sseRows(client: SkybridgeClient, workspace: ApiWorkspace): Promise<SyncProbeRow[]> {
  const rows: SyncProbeRow[] = [];
  const started = Date.now();

  const frames: string[] = [];
  let opened = false;
  let changeSeq: number | null = null;
  let streamError: string | null = null;

  const unsubscribe = client.subscribeEvents(workspace.id, {
    onOpen: () => {
      opened = true;
    },
    onChange: (latestSeq) => {
      changeSeq = latestSeq;
    },
    onFrame: (frame) => {
      frames.push(frame.event ?? 'comment');
    },
    onError: (err) => {
      streamError = err.message;
    },
  });

  const nudge = await nudgeSkybridge();
  const deadline = Date.now() + 15_000;
  while (changeSeq === null && Date.now() < deadline && streamError === null) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  unsubscribe();

  rows.push({
    name: 'subscribeEvents — stream opens (SOFT)',
    ok: opened,
    gate: false,
    detail: opened
      ? `open after ${Date.now() - started}ms · frames: ${frames.slice(0, 6).join(', ') || 'none yet'}`
      : `never opened${streamError === null ? '' : ` · ${streamError}`}`,
    ms: Date.now() - started,
  });

  rows.push({
    name: "subscribeEvents — the desktop's change arrives (SOFT)",
    ok: nudge.ok ? changeSeq !== null : null,
    gate: false,
    detail: nudge.ok
      ? changeSeq === null
        ? `${nudge.detail}, but no change event in 15s (frames seen: ${frames.length})`
        : `${nudge.detail} → onChange(latestSeq ${changeSeq}) after ${Date.now() - started}ms`
      : `could not make the desktop push: ${nudge.detail}`,
    ms: Date.now() - started,
  });

  // Unsubscribe has to actually stop it; a subscription that outlives its
  // handle is a leak that only shows up as duplicate work much later.
  const framesAtStop = frames.length;
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  rows.push({
    name: 'unsubscribe stops the stream (SOFT)',
    ok: frames.length === framesAtStop,
    gate: false,
    detail:
      frames.length === framesAtStop
        ? `no frames in the 3s after unsubscribe (${framesAtStop} total)`
        : `${frames.length - framesAtStop} frames arrived AFTER unsubscribe`,
    ms: 3_000,
  });

  return rows;
}

export async function runSkybridgePanel(): Promise<SyncProbeRow[]> {
  const { skybridge, error } = await loadFixtures();
  if (skybridge === null) {
    return [
      {
        name: 'skybridge server coordinates',
        ok: null,
        gate: false,
        detail: error ?? 'no .runtime/skybridge-host.json — run `just spike-mobile-sync-host`',
        ms: 0,
      },
    ];
  }
  return runAgainst(skybridge);
}

async function runAgainst(fixture: SkybridgeFixture): Promise<SyncProbeRow[]> {
  const rows: SyncProbeRow[] = [];

  const auth = await step<AuthContext>(rows, 'login (GATE)', true, async () => {
    const context = await login(fixture.baseUrl, fixture.email, fixture.password);
    if (context.serverId === undefined || context.serverId === '') {
      throw new Error('the server reported no server_id — older than 0.1.4');
    }
    return [
      context,
      `user ${context.user.email} · server ${context.serverId.slice(0, 8)}… · token ${context.token.length}B · refresh ${context.refreshToken === undefined ? 'ABSENT' : 'present'}`,
    ];
  });
  if (auth === null) return rows;

  const device = await step(rows, 'registerDevice', false, async () => {
    const bootstrap = createSkybridgeClient({ authContext: auth });
    const registered = await bootstrap.registerDevice({
      name: 'lark spike (android)',
      appVersion: 'lark spike N0b-4',
      clientVersion: '0.1.4',
    });
    return [registered, `device ${registered.id}`];
  });
  if (device === null) return rows;

  const client = createSkybridgeClient({ authContext: auth, deviceId: device.id });

  const workspace = await step<ApiWorkspace>(rows, 'ensureWorkspace', false, async () => {
    const ws = await client.ensureWorkspace(fixture.workspaceTool, fixture.workspaceName);
    return [ws, `${ws.tool}/${ws.name} → ${ws.id} (schema v${ws.schemaVersion})`];
  });
  if (workspace === null) return rows;

  const change = makeChange(1);
  const pushed = await step(rows, 'pushChanges (GATE)', true, async () => {
    const result = await client.pushChanges(workspace.id, [change]);
    if (result.accepted.length !== 1) {
      throw new Error(`server accepted ${result.accepted.length} of 1`);
    }
    return [
      result,
      `accepted 1 · latestSeq ${result.latestSeq} · serverTime skew ${result.serverTime - Date.now()}ms`,
    ];
  });
  if (pushed === null) return rows;

  await step(rows, 'pullChanges (GATE)', true, async () => {
    const result = await client.pullChanges(workspace.id, 0, 100);
    const mine = result.changes.find((c) => c.clientChangeId === change.clientChangeId);
    if (mine === undefined) {
      throw new Error(
        `the pushed change did not come back (${result.changes.length} changes, latestSeq ${result.latestSeq})`,
      );
    }
    // The payload is what a sync engine would apply; a round trip that loses it
    // would pass a shape check and fail everything after.
    const payload = mine.payload as { seq?: number } | null;
    if (payload?.seq !== 1) throw new Error(`payload came back as ${JSON.stringify(mine.payload)}`);
    return [
      result,
      `${result.changes.length} change(s) · mine at serverSeq ${mine.serverSeq} with its payload intact`,
    ];
  });

  await step(rows, 'refresh (GATE)', true, async () => {
    const token = auth.refreshToken;
    if (token === undefined) throw new Error('login returned no refresh token');
    const rotated = await refresh(fixture.baseUrl, token);
    // A rotated token that cannot be used is not a refresh. Prove it by making
    // a call with it — the old one is still valid, so only the new one can pass.
    const rotatedClient = createSkybridgeClient({
      authContext: { ...auth, token: rotated.token, refreshToken: rotated.refreshToken },
      deviceId: device.id,
    });
    const devices = await rotatedClient.listDevices();
    return [
      rotated,
      `new access token ${rotated.token.length}B (≠ old: ${rotated.token !== auth.token}) · ` +
        `expires in ${Math.round((rotated.expiresAt - Date.now()) / 1000)}s · ` +
        `used it to list ${devices.length} device(s)`,
    ];
  });

  rows.push(...(await sseRows(client, workspace)));
  return rows;
}
