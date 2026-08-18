// Criterion 23 (bilibili platform/network probe) and the STREAM half of
// criterion 19 (can `expo/fetch` pull bilibili's audio at all).
//
// The boundary rules the shape of this file. The spike may not sign a WBI
// request — signing it here would verify this file's copy of the algorithm, not
// core's — so the desktop hands over three things (§1.3, criterion 23 as
// rewritten in v4):
//
//   ① the canonical string core hashed, ② the digest core got, ③ a complete
//   signed URL.
//
// The phone answers two questions about them: does the md5 PORT reproduce ②
// from ①, and does ③ still work from a phone on a Chinese mobile network. The
// real algorithm is re-verified at N1's exit (R1), with core's own code.
//
// The stream probe follows E-1.3: reproduce `openAudio()`'s FULL header set
// first (User-Agent + Referer + buvid Cookie, captured from a real call), and
// only then delete headers one at a time. Backwards — starting from Referer
// alone, the way the plan's earlier draft had it — a failure cannot distinguish
// "React Native cannot do this" from "the probe sent the wrong thing".
//
// It runs the matrix TWICE, against two URLs, and the reason is a measurement:
// bilibili's playurl hands out a CDN node picked for the CALLER's address, so
// the desktop's URL points at a Beijing node the phone's carrier cannot reach
// (see `mintStreamUrl`). The desktop-minted URL still says something worth
// having — it is the same bytes core would have fetched — but only the
// device-minted one can answer "can this radio pull audio".
//
// NOT a §3.2a measurement: nothing here is a percentile, so a debug build is
// allowed to judge it. Which network the phone was on when it ran is recorded
// on the HOST side (`adb shell dumpsys connectivity`), because an app's own
// guess about that is one more thing that can be wrong.

import { md5 } from '@noble/hashes/legacy.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { type NetworkFixture, fixtureAge, loadFixtures } from '../fixtures';

export interface NetProbeRow {
  group: string;
  name: string;
  /** null = evidence, not a verdict (a discovery row, or an input we could not get). */
  ok: boolean | null;
  detail: string;
}

const REQUEST_TIMEOUT_MS = 20_000;

/** What a bilibili JSON endpoint answered, or why we cannot say. */
async function readEnvelope(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    if (!type.includes('json')) {
      // core reads this exact shape as risk control (bilibili.ts:355-360): an
      // HTML page with HTTP 200 is the failure that matters on a phone IP.
      return {
        ok: false,
        detail: `HTTP ${res.status}, content-type ${type || 'none'} — risk control page? ${text.slice(0, 60)}`,
      };
    }
    const body = JSON.parse(text) as { code?: number; message?: string };
    return {
      ok: body.code === 0,
      detail: `HTTP ${res.status} · envelope code ${body.code}${body.message ? ` (${body.message})` : ''}`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** One range request against the audio stream with a given header set. */
async function probeStream(
  streamUrl: string,
  headers: Record<string, string>,
  bytes: number,
): Promise<{ status: number | null; detail: string; got: number }> {
  try {
    const res = await fetch(streamUrl, {
      headers: { ...headers, Range: `bytes=0-${bytes - 1}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok) return { status: res.status, detail: `HTTP ${res.status} ${type}`, got: 0 };
    const buffer = await res.arrayBuffer();
    return {
      status: res.status,
      detail: `HTTP ${res.status} · ${type || 'no content-type'} · ${buffer.byteLength}B`,
      got: buffer.byteLength,
    };
  } catch (err) {
    return {
      status: null,
      detail: `request failed: ${err instanceof Error ? err.message : String(err)}`,
      got: 0,
    };
  }
}

function wbiRows(network: NetworkFixture): NetProbeRow[] {
  const actual = bytesToHex(md5(utf8ToBytes(network.wbi.canonical)));
  return [
    {
      group: 'WBI',
      name: "the md5 port reproduces core's w_rid",
      ok: actual === network.wbi.expectedMd5,
      detail:
        actual === network.wbi.expectedMd5
          ? `${actual} over ${network.wbi.canonical.length} chars — same as the desktop`
          : `got ${actual}, core got ${network.wbi.expectedMd5}`,
    },
  ];
}

async function signedUrlRow(network: NetworkFixture): Promise<NetProbeRow> {
  const result = await readEnvelope(network.wbi.signedUrl, network.identity);
  if (!network.wbi.desktopVerified) {
    // The desktop could not use this URL either, so the phone's answer says
    // nothing about the phone.
    return {
      group: 'WBI',
      name: "core's signed search URL works from the phone",
      ok: null,
      detail: `INPUT NOT VALID — the desktop got: ${network.wbi.desktopNote}. Phone got: ${result.detail}`,
    };
  }
  return {
    group: 'WBI',
    name: "core's signed search URL works from the phone",
    ok: result.ok,
    detail: result.detail,
  };
}

async function unsignedRows(network: NetworkFixture): Promise<NetProbeRow[]> {
  const endpoints: [string, string | null][] = [
    ['view', network.unsigned.view],
    ['pagelist', network.unsigned.pagelist],
    ['playurl', network.unsigned.playurl],
  ];
  const rows: NetProbeRow[] = [];
  for (const [name, url] of endpoints) {
    if (url === null) {
      rows.push({
        group: 'unsigned endpoints',
        name,
        ok: null,
        detail: 'the fixture carries no URL for this endpoint',
      });
      continue;
    }
    const result = await readEnvelope(url, network.identity);
    rows.push({ group: 'unsigned endpoints', name, ok: result.ok, detail: result.detail });
  }
  return rows;
}

/**
 * A stream URL minted for THIS network, by asking playurl from the phone.
 *
 * MEASURED on 2026-08-18 (N0b-4a): the desktop-signed URL named
 * `cn-bj-cc-03-02.bilivideo.com`, and over China Telecom 5G that host resolves
 * (124.205.198.67) but never answers — 25s and no connection, from the app and
 * from `adb shell curl` alike, while api.bilibili.com was fine from the same
 * radio. playurl hands out a CDN node chosen for the CLIENT's address, so a URL
 * minted on the desktop's Wi-Fi is not portable to a phone's carrier.
 *
 * This deliberately does NOT reproduce core's stream CHOICE — codec first, then
 * bandwidth (`bilibili.ts:269-276`) is a business rule and belongs to R1. It
 * takes the first audio entry, because the question here is only "can this
 * radio reach a CDN node it was given".
 */
async function mintStreamUrl(
  playurlUrl: string,
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const res = await fetch(playurlUrl, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json()) as {
      data?: { dash?: { audio?: { baseUrl?: string; base_url?: string }[] } };
    };
    const first = body.data?.dash?.audio?.[0];
    return first?.baseUrl ?? first?.base_url ?? null;
  } catch {
    return null;
  }
}

const hostOf = (url: string): string => url.split('/')[2] ?? 'unknown host';

/**
 * The header matrix (criterion 19's probe, E-1.3).
 *
 * Full set first and judged; the deletions are evidence — they say what the
 * minimum is, and the answer is allowed to be "all three".
 */
async function matrixFor(
  label: string,
  streamUrl: string,
  identity: Record<string, string>,
  bytes: number,
): Promise<NetProbeRow[]> {
  const group = `audio stream (${label})`;
  const full = await probeStream(streamUrl, identity, bytes);
  const rows: NetProbeRow[] = [
    {
      group,
      name: `full header set (${Object.keys(identity).join(' + ')}) + Range`,
      ok: full.status === 206 && full.got === bytes,
      detail: `${hostOf(streamUrl)} · ${full.detail}${full.status === 200 ? ' — 200, not 206: the server ignored Range' : ''}`,
    },
  ];

  if (full.status !== 206) {
    rows.push({
      group,
      name: 'header deletion matrix',
      ok: null,
      detail: 'skipped — the full set did not work, so removing headers proves nothing',
    });
    return rows;
  }

  for (const omitted of Object.keys(identity)) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(identity)) {
      if (k !== omitted) headers[k] = v;
    }
    const result = await probeStream(streamUrl, headers, bytes);
    rows.push({
      group,
      name: `without ${omitted}`,
      ok: null,
      detail: `${result.status === 206 ? 'still works' : 'REFUSED'} · ${result.detail}`,
    });
  }

  const bare = await probeStream(streamUrl, {}, bytes);
  rows.push({
    group,
    name: 'no headers at all',
    ok: null,
    detail: `${bare.status === 206 ? 'still works' : 'REFUSED'} · ${bare.detail}`,
  });
  return rows;
}

async function streamRows(network: NetworkFixture): Promise<NetProbeRow[]> {
  const { streamUrl, bytes } = network.rangeProbe;
  const rows = await matrixFor('desktop-minted URL', streamUrl, network.identity, bytes);

  // The one that decides criterion 19's stream half on whatever network this
  // is: a URL this device was handed itself.
  const playurl = network.unsigned.playurl;
  if (playurl === null) {
    rows.push({
      group: 'audio stream (device-minted URL)',
      name: 'mint a URL from this device',
      ok: null,
      detail: 'the fixture carries no playurl endpoint',
    });
    return rows;
  }
  const mine = await mintStreamUrl(playurl, network.identity);
  if (mine === null) {
    rows.push({
      group: 'audio stream (device-minted URL)',
      name: 'mint a URL from this device',
      ok: false,
      detail: 'playurl did not hand out a dash audio baseUrl',
    });
    return rows;
  }
  rows.push(...(await matrixFor('device-minted URL', mine, network.identity, bytes)));
  return rows;
}

export async function runBilibiliPanel(): Promise<NetProbeRow[]> {
  const { network, error } = await loadFixtures();
  if (network === null) {
    return [
      {
        group: 'fixtures',
        name: 'desktop fixtures',
        ok: null,
        detail:
          error ??
          'the probe host has no network fixtures — run `just spike-mobile-fixtures-network`',
      },
    ];
  }

  const rows: NetProbeRow[] = [
    {
      group: 'fixtures',
      name: `from the desktop's core ${network.generatedAtIso.slice(0, 19)}Z`,
      ok: null,
      detail: `${fixtureAge(network)} · identity ${network.identityFrom}`,
    },
    ...wbiRows(network),
    await signedUrlRow(network),
    ...(await unsignedRows(network)),
    ...(await streamRows(network)),
  ];
  return rows;
}
