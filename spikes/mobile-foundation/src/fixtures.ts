// N0b-4's fixtures arrive over the wire, not in the bundle.
//
// `desktop-fixtures.ts` is compiled in because its expectations (digests, byte
// lengths, base64 decodes) are eternal. These are not: bilibili's stream URLs
// carry a `deadline` roughly two hours out, the buvid cookie belongs to one
// desktop client run, and the skybridge account is created fresh per
// `sync-host.mjs`. Baking those into a release APK would mean rebuilding the
// app every time a URL went stale — twenty minutes to answer a question about
// an hour-old signature.
//
// So the desktop produces them (with the REAL core — subplan §0, and the
// import guard's one exemption) and `probe-host.mjs` serves them at
// /fixtures/network. A panel that cannot reach the host reports `unverified`
// and judges nothing: "the fixture never arrived" and "the platform failed" are
// different answers and must not share a colour.

import { PROBE_HOST } from './report';

export interface TrackFixtureFile {
  name: string;
  /** Where `make-network-fixtures.mjs --audio` pushed it. */
  devicePath: string;
  bytes: number;
  sha256: string;
  probe: {
    container: string;
    /** ffprobe's reading — what criterion 19's ±1s is measured against. */
    durationSec: number;
    codec: string;
    sampleRate: number;
    channels: number;
    audioStreamCount: number;
    hasAttachedPic: boolean;
  };
}

export interface TrackFixture {
  key: 'short' | 'long';
  provenance: string;
  bvid: string;
  cid: number;
  title: string;
  partTitle: string;
  /** bilibili's own duration for the part, in seconds. */
  apiDurationSec: number;
  streamUrl: string;
  streamHost: string;
  deadline: number;
  bandwidth: number;
  codecs: string;
  isAac: boolean;
  qualityId: number;
  file: TrackFixtureFile | null;
}

export interface NetworkFixture {
  generatedAt: number;
  generatedAtIso: string;
  /** The earliest stream `deadline`; past it, a failed stream probe means nothing. */
  expiresAt: number;
  /** `openAudio()`'s real header set: User-Agent + Referer + buvid Cookie. */
  identity: Record<string, string>;
  identityFrom: string;
  wbi: {
    /** The exact string core fed to md5 — sorted query + mixin key. */
    canonical: string;
    /** …and the digest it got. The phone's port has to agree. */
    expectedMd5: string;
    signedUrl: string;
    wts: number;
    /** Whether the desktop could use that URL. A no here disqualifies the device's no. */
    desktopVerified: boolean;
    desktopNote: string;
  };
  unsigned: { view: string | null; pagelist: string | null; playurl: string | null };
  rangeProbe: { streamUrl: string; bytes: number };
  tracks: TrackFixture[];
}

export interface SkybridgeFixture {
  startedAt: number;
  /** Loopback through `adb reverse` — works with Wi-Fi off, which criterion 23 needs. */
  baseUrl: string;
  hostBaseUrl: string;
  email: string;
  password: string;
  workspaceTool: string;
  workspaceName: string;
}

export interface FixtureBundle {
  network: NetworkFixture | null;
  skybridge: SkybridgeFixture | null;
  /** Why nothing arrived, when nothing did. */
  error: string | null;
}

export async function loadFixtures(): Promise<FixtureBundle> {
  try {
    const res = await fetch(`${PROBE_HOST}/fixtures/network`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok)
      return { network: null, skybridge: null, error: `probe host said HTTP ${res.status}` };
    const body = (await res.json()) as Omit<FixtureBundle, 'error'>;
    return { network: body.network, skybridge: body.skybridge, error: null };
  } catch (err) {
    return {
      network: null,
      skybridge: null,
      error: `no probe host at ${PROBE_HOST} (${err instanceof Error ? err.message : String(err)}) — run \`just spike-mobile-probe-host\``,
    };
  }
}

/** Ask the desktop to change the workspace, so an SSE subscription has something to hear. */
export async function nudgeSkybridge(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${PROBE_HOST}/skybridge/nudge`, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json()) as { pushed?: string; error?: string };
    return res.ok
      ? { ok: true, detail: `desktop pushed ${body.pushed}` }
      : { ok: false, detail: body.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function fixtureAge(network: NetworkFixture): string {
  const minutes = Math.round((Date.now() - network.generatedAt) / 60_000);
  const left = Math.round((network.expiresAt - Date.now()) / 60_000);
  return left <= 0
    ? `generated ${minutes}min ago — EXPIRED ${-left}min ago, regenerate before believing a stream failure`
    : `generated ${minutes}min ago · stream URLs valid for ${left}min more`;
}
