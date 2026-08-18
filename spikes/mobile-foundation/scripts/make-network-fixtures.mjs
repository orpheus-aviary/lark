// HOST script (Node, desktop) — produces everything the phone is not allowed to
// compute for itself.
//
// The spike may not import core's business modules (guard + subplan §0), and it
// may not reimplement them either: a probe that signs its own WBI request is
// verifying the reimplementation. So the desktop runs the REAL core client and
// hands the device three kinds of fact:
//
//   1. the WBI three-piece (criterion 23) — the canonical string core hashes,
//      the digest core got, and a complete signed URL. The phone checks that its
//      md5 port reproduces the digest, and that the URL still works from there.
//      The signing ALGORITHM is core's business and is re-verified for real at
//      N1's exit (R1).
//   2. `openAudio()`'s actual header set (criterion 19, E-1.3) — User-Agent +
//      Referer + buvid Cookie, captured from a real call rather than retyped,
//      so a failed stream probe cannot be blamed on the probe's own input.
//   3. the audio fixtures themselves (criterion 19) — bilibili's raw AAC-in-MP4
//      bytes, saved with no remux whatsoever, because "can Android play what
//      bilibili sends" is the whole question D17 asks.
//
// Output goes to `.runtime/network-fixtures.json` (untracked) and is served to
// the device by `probe-host.mjs`, NOT bundled: the stream URLs carry a
// `deadline` a couple of hours out, and a fixture that expired would otherwise
// need a rebuild to replace.
//
//   node scripts/make-network-fixtures.mjs            # metadata only (fast)
//   node scripts/make-network-fixtures.mjs --audio    # + download and push the two tracks
//
// This file is the reason the import guard lets `scripts/*.mjs` reach `@lark/core`:
// it is host-side, never in Metro's graph, and using anything BUT the real core
// here would defeat the fixture's purpose.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DEFAULT_TIMEOUTS,
  createBilibiliClient,
  fetchWbiKeys,
  getMixinKey,
  probeAudio,
  resolveMediaTools,
  signWbiParams,
} from '@lark/core';

const execFileAsync = promisify(execFile);

const RUNTIME_DIR = fileURLToPath(new URL('../.runtime/', import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
const OUT = `${RUNTIME_DIR}network-fixtures.json`;

/** Where the device reads pushed files: its own external files dir, no permission needed. */
const DEVICE_DIR = '/sdcard/Android/data/com.orpheusaviary.lark.spike/files';
const ADB = `${process.env.ANDROID_HOME ?? '/opt/homebrew/share/android-commandlinetools'}/platform-tools/adb`;

// The two tracks, and where they come from — provenance matters here, because
// criterion 19's numbers are about these exact files.
//
// SHORT is from the user's own favlist (fid 3975154248, "测试收藏夹"), which is
// where this spike's audio is supposed to come from. That list's shortest entry
// is 2:17: there is no ~1min track in it, and picking one from elsewhere would
// have traded a real library item for a rounder number.
//
// LONG is NOT from the favlist — nothing in it reaches 35 minutes, and the plan
// wants a long file because seek deviation and duration error are only
// meaningful over one (§3.2's ≥35min, and the PSS peak protocol assumes a
// 30-minute track). Part 1 of this one is 37:07.
const TRACKS = {
  short: { bvid: 'BV176M3zPEZu', part: 1, from: "the user's favlist 3975154248" },
  long: {
    bvid: 'BV1LtgV6ZE2U',
    part: 1,
    from: 'searched for a ≥35min track; the favlist has none',
  },
};

const wantsAudio = process.argv.includes('--audio');

// ─── a fetch that remembers ────────────────────────────
//
// The header set is captured from a real call instead of being written down
// here on purpose: a hand-copied header set that drifts from core turns
// "criterion 19 failed" into a question nobody can answer.

/** @type {{url: string, headers: Record<string, string>}[]} */
const seen = [];

const recordingFetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k] = String(v);
  seen.push({ url, headers });
  return fetch(input, init);
};

/** The last recorded request whose URL matches, or null. */
const lastMatching = (fragment) => {
  for (let i = seen.length - 1; i >= 0; i -= 1) {
    if (seen[i].url.includes(fragment)) return seen[i];
  }
  return null;
};

const client = createBilibiliClient({
  fetchImpl: recordingFetch,
  // Fixture generation, not production: a 54MB track over a home connection
  // legitimately takes longer than the 5 minutes production allows one song.
  timeouts: { ...DEFAULT_TIMEOUTS, audioStream: 20 * 60_000 },
});

// ─── audio ─────────────────────────────────────────────

async function resolveTrack(key) {
  const spec = TRACKS[key];
  const view = await client.view(spec.bvid);
  // Called for its URL: `view()` already carries the parts, but criterion 23
  // probes all three unsigned endpoints and the URL has to come from core.
  await client.pagelist(spec.bvid);
  const page = view.pages[spec.part - 1];
  if (page === undefined) throw new Error(`${spec.bvid} has no part ${spec.part}`);
  const stream = await client.audioStream(spec.bvid, page.cid);
  const url = new URL(stream.url);
  console.log(
    `${key}: ${view.title.slice(0, 40)} · p${spec.part} cid=${page.cid} ${page.duration}s · ` +
      `${stream.codecs} ${stream.bandwidth}bps · host ${url.host}`,
  );
  return {
    key,
    provenance: spec.from,
    bvid: spec.bvid,
    cid: page.cid,
    title: view.title,
    part: spec.part,
    partTitle: page.part,
    /** bilibili's own answer, in seconds — the truth criterion 19's ±1s is measured against. */
    apiDurationSec: page.duration,
    streamUrl: stream.url,
    streamHost: url.host,
    /** The stream URL stops working at this epoch second; the fixture is not durable. */
    deadline: Number(url.searchParams.get('deadline') ?? 0),
    bandwidth: stream.bandwidth,
    codecs: stream.codecs,
    isAac: stream.isAac,
    qualityId: stream.id,
    file: null,
  };
}

/**
 * Download the stream EXACTLY as it arrives.
 *
 * No ffmpeg, no rewrap, no container fix-up: criterion 19 asks whether the
 * bytes bilibili sends are playable as they are, and a fixture that had been
 * through a remux would answer a different question (and answer it yes).
 */
async function downloadTrack(track, ffprobePath) {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const name = `${track.key}-${track.bvid}.m4a`;
  const path = `${FIXTURE_DIR}${name}`;

  const started = Date.now();
  const response = await client.openAudio(track.streamUrl);
  if (response.body === null) throw new Error(`${track.key}: stream had no body`);
  const hash = createHash('sha256');
  await pipeline(
    Readable.fromWeb(response.body).map((chunk) => {
      hash.update(chunk);
      return chunk;
    }),
    createWriteStream(path),
  );
  const { size } = await stat(path);
  const seconds = (Date.now() - started) / 1000;
  console.log(
    `  → ${name} ${(size / 1024 / 1024).toFixed(1)}MB in ${seconds.toFixed(1)}s ` +
      `(${(size / 1024 / seconds).toFixed(0)}KB/s)`,
  );

  const probe = await probeAudio(ffprobePath, path);
  console.log(
    `  → ffprobe: ${probe.container} · ${probe.duration}s · ${probe.codec} ` +
      `${probe.sample_rate}Hz ${probe.channels}ch · ${probe.audio_stream_count} audio stream(s)` +
      `${probe.has_attached_pic ? ' + cover art' : ''}`,
  );

  return {
    ...track,
    file: {
      name,
      hostPath: path,
      devicePath: `${DEVICE_DIR}/${name}`,
      bytes: size,
      sha256: hash.digest('hex'),
      probe: {
        container: probe.container,
        /** ffprobe's duration, which is what the player is compared against (±1s). */
        durationSec: probe.duration,
        codec: probe.codec,
        sampleRate: probe.sample_rate,
        channels: probe.channels,
        audioStreamCount: probe.audio_stream_count,
        hasAttachedPic: probe.has_attached_pic,
      },
    },
  };
}

async function pushToDevice(tracks) {
  await execFileAsync(ADB, ['shell', 'mkdir', '-p', DEVICE_DIR]);
  for (const track of tracks) {
    if (track.file === null) continue;
    const { stdout } = await execFileAsync(ADB, [
      'push',
      track.file.hostPath,
      track.file.devicePath,
    ]);
    console.log(`  adb push ${track.file.name}: ${stdout.trim().split('\n').pop()}`);
  }
}

// ─── WBI three-piece ───────────────────────────────────

/**
 * What the phone gets: the string core hashed, the digest core got, and a URL
 * that is signed and complete.
 *
 * `signWbiParams` is called here rather than reproduced there, and the query is
 * split back apart afterwards — so the canonical string is core's own bytes,
 * not a second implementation that happens to agree today.
 */
async function makeWbiFixture(headers) {
  const keys = await fetchWbiKeys(recordingFetch, headers, AbortSignal.timeout(15_000));
  const params = { search_type: 'video', keyword: '洛天依', page: 1, page_size: 20 };
  const wts = Math.floor(Date.now() / 1000);
  const query = signWbiParams(params, keys, wts);

  const marker = '&w_rid=';
  const at = query.lastIndexOf(marker);
  const sortedQuery = query.slice(0, at);
  const expectedMd5 = query.slice(at + marker.length);
  const canonical = sortedQuery + getMixinKey(keys.imgKey, keys.subKey);
  const signedUrl = `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`;

  // Does it actually work from HERE? A URL that the desktop cannot use either
  // would make the device's failure meaningless.
  let desktopVerified = false;
  let desktopNote = '';
  try {
    const res = await fetch(signedUrl, { headers, signal: AbortSignal.timeout(15_000) });
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('json')) {
      const body = await res.json();
      desktopVerified = body.code === 0;
      desktopNote = `HTTP ${res.status}, envelope code ${body.code}`;
    } else {
      desktopNote = `HTTP ${res.status}, content-type ${type || 'none'} — risk control?`;
    }
  } catch (err) {
    desktopNote = `desktop request failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  console.log(`wbi: ${desktopVerified ? '✓' : '✗'} ${desktopNote}`);

  return { canonical, expectedMd5, signedUrl, wts, desktopVerified, desktopNote };
}

// ─── main ──────────────────────────────────────────────

await mkdir(RUNTIME_DIR, { recursive: true });

const tools = resolveMediaTools();
if (wantsAudio && !tools.ok) {
  throw new Error(`media tools are ${tools.state}: ${tools.detail} — cannot probe the fixtures`);
}

let tracks = [await resolveTrack('short'), await resolveTrack('long')];

if (lastMatching('api.bilibili.com') === null) {
  throw new Error('no request was recorded — cannot capture the header set');
}

if (wantsAudio && tools.ok) {
  const ffprobePath = tools.tools.ffprobe.path;
  console.log(`downloading; ffprobe comes from ${tools.tools.ffprobe.source}`);
  tracks = [
    await downloadTrack(tracks[0], ffprobePath),
    await downloadTrack(tracks[1], ffprobePath),
  ];
  await pushToDevice(tracks);
}

// `openAudio` is what criterion 19's probe has to reproduce, so the headers come
// from the openAudio call itself whenever this run made one. Without `--audio`
// they come from an API call — the same three headers, from the same `headers()`
// helper (bilibili.ts:151-158), but say so rather than imply otherwise.
const streamRequest = lastMatching('bilivideo.com') ?? lastMatching('api.bilibili.com');
const identity = streamRequest.headers;

const wbi = await makeWbiFixture(identity);

const short = tracks[0];
const fixture = {
  generatedAt: Date.now(),
  generatedAtIso: new Date().toISOString(),
  // Every stream URL dies at its own `deadline`; the earliest one is when this
  // whole fixture stops meaning anything.
  expiresAt: Math.min(...tracks.map((t) => t.deadline)) * 1000,
  identity,
  identityFrom: streamRequest.url.includes('bilivideo.com')
    ? "openAudio() — the real stream request's headers"
    : 'an API request (no stream was opened this run; --audio captures openAudio itself)',
  wbi,
  // The unsigned endpoints, as core builds them (bilibili.ts:213,225,246). The
  // device sends these verbatim: constructing them there would be one more
  // thing that could disagree with core.
  unsigned: {
    view: lastMatching('/x/web-interface/view')?.url ?? null,
    pagelist: lastMatching('/x/player/pagelist')?.url ?? null,
    playurl: lastMatching('/x/player/playurl')?.url ?? null,
  },
  /** A byte range the stream probe can ask for without pulling the whole track. */
  rangeProbe: { streamUrl: short.streamUrl, bytes: 65_536 },
  tracks,
};

await writeFile(OUT, JSON.stringify(fixture, null, 2), 'utf-8');
console.log(`\nwrote ${OUT}`);
console.log(
  `  valid until ${new Date(fixture.expiresAt).toISOString()} ` +
    `(${Math.round((fixture.expiresAt - Date.now()) / 60_000)} min from now)`,
);
if (!wantsAudio) console.log('  metadata only — pass --audio to download and push the tracks');
