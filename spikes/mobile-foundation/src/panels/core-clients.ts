// R1–R3: core's OWN download client, running on the phone.
//
// Criterion 23 (N0b-4a) asked whether the platform could carry bilibili's
// traffic, with the desktop doing core's work and the device replaying it.
// These three ask the question that replaced it once N1d made the client layer
// portable: does CORE'S CODE, unchanged, produce the same answers here?
//
// So nothing in this file reimplements anything. Every call below is an import
// from `@lark/core/portable`, and the desktop's side of each comparison was
// produced by the same functions in the same release
// (`make-network-fixtures.mjs` → `references`).
//
//   R1  the bilibili client end to end: signature parity on a fixed triple,
//       a LIVE signed search, buvid through the Random port, view / pagelist /
//       playurl, the b23 hop, and `openAudio()` streamed and aborted.
//   R2  `parseSongInput` on real share texts, field for field against core.
//   R3  the three lyrics platforms, with the base64 and text ports underneath.
//
// R1 runs TWICE — once on Wi-Fi, once on cellular — because playurl hands out a
// CDN node chosen for the caller's address (N0b-4a: the desktop's Beijing node
// was unreachable from the phone's carrier). Which network was in use is
// recorded host-side by `dumpsys connectivity`; an app's own guess about that
// is one more thing that can be wrong.

import {
  createBilibiliClient,
  fetchBuvid,
  fetchLyrics,
  fetchWbiKeys,
  parseSongInput,
  randomBuvid3,
  signWbiParams,
} from '@lark/core/portable';
import { fixtureAge, loadFixtures } from '../fixtures';
import { installPortableRuntime } from '../portable-runtime';

export interface CoreClientRow {
  group: string;
  name: string;
  /** null = evidence, not a verdict (an input we could not get, or a discovery). */
  ok: boolean | null;
  detail: string;
}

const TIMEOUT_MS = 20_000;

/** core's own client, with core's own defaults. Nothing is overridden here. */
const client = createBilibiliClient();

function fail(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

async function step(
  group: string,
  name: string,
  run: () => Promise<{ ok: boolean; detail: string }>,
): Promise<CoreClientRow> {
  try {
    const { ok, detail } = await run();
    return { group, name, ok, detail };
  } catch (err) {
    return { group, name, ok: false, detail: fail(err) };
  }
}

// ─── R1 ────────────────────────────────────────────────

export async function runR1Panel(): Promise<CoreClientRow[]> {
  installPortableRuntime();
  const rows: CoreClientRow[] = [];
  const { network, error } = await loadFixtures();
  if (network === null || network.references === undefined) {
    return [
      {
        group: 'R1',
        name: 'references from the desktop',
        ok: null,
        detail:
          error ??
          'the fixture has no `references` section — re-run `just spike-mobile-fixtures-network`',
      },
    ];
  }
  const refs = network.references;
  rows.push({
    group: 'R1',
    name: 'fixture freshness',
    ok: null,
    detail: `${fixtureAge(network)} · stream deadline ${new Date(network.expiresAt).toISOString()}`,
  });

  // ① Offline parity: the same triple, core's own signer, on Hermes.
  rows.push(
    await step('R1', 'signWbiParams reproduces the desktop w_rid', async () => {
      const query = signWbiParams(
        refs.signature.params,
        { imgKey: refs.signature.imgKey, subKey: refs.signature.subKey },
        refs.signature.wts,
      );
      const wRid = query.slice(query.lastIndexOf('&w_rid=') + '&w_rid='.length);
      return {
        ok: wRid === refs.signature.expectedWRid,
        detail:
          wRid === refs.signature.expectedWRid
            ? `${wRid} — byte for byte, and the whole query matches: ${query === refs.signature.query}`
            : `got ${wRid}, core got ${refs.signature.expectedWRid}`,
      };
    }),
  );

  // ② The Random port, which React Native cannot satisfy on its own (N0b-3).
  rows.push(
    await step('R1', 'buvid3 through the installed Random source', async () => {
      const local = randomBuvid3();
      const shaped = /^[0-9A-F]{32}infoc$/.test(local);
      return {
        ok: shaped,
        detail: shaped ? `${local.slice(0, 12)}…infoc` : `unexpected: ${local}`,
      };
    }),
  );
  rows.push(
    await step('R1', 'fetchBuvid (spi, or the local fallback)', async () => {
      const buvid = await fetchBuvid(
        fetch,
        { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com' },
        AbortSignal.timeout(TIMEOUT_MS),
      );
      return {
        ok: buvid.buvid3.length > 0,
        detail: `buvid3 ${buvid.buvid3.slice(0, 12)}… · buvid4 ${buvid.buvid4 === '' ? 'absent' : 'present'}`,
      };
    }),
  );

  // ③ A LIVE signature, signed here, from keys fetched here.
  rows.push(
    await step('R1', 'live: fetchWbiKeys + a signed search from this device', async () => {
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      const keys = await fetchWbiKeys(
        fetch,
        { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com' },
        signal,
      );
      const results = await client.search('洛天依', { signal: AbortSignal.timeout(TIMEOUT_MS) });
      return {
        ok: results.length > 0,
        detail: `keys ${keys.imgKey.slice(0, 8)}…/${keys.subKey.slice(0, 8)}… · ${results.length} results · first: ${results[0]?.title.slice(0, 30) ?? 'none'}`,
      };
    }),
  );

  // ④ The three unsigned endpoints, through core's client.
  const track = network.tracks[0];
  rows.push(
    await step('R1', `view(${track?.bvid ?? '—'})`, async () => {
      if (track === undefined) return { ok: false, detail: 'no track in the fixture' };
      const view = await client.view(track.bvid, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      return {
        ok: view.pages.length > 0 && view.title.length > 0,
        detail: `${view.title.slice(0, 32)} · ${view.pages.length} part(s) · owner ${view.ownerName}`,
      };
    }),
  );
  rows.push(
    await step('R1', 'pagelist', async () => {
      if (track === undefined) return { ok: false, detail: 'no track in the fixture' };
      const pages = await client.pagelist(track.bvid, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const cids = pages.map((p) => p.cid);
      return {
        ok: cids.includes(track.cid),
        detail: `${pages.length} part(s); cid ${track.cid} ${cids.includes(track.cid) ? 'present' : `missing (${cids.slice(0, 3).join(',')})`}`,
      };
    }),
  );

  // ⑤ playurl — minted HERE, because the node it names is chosen for this
  //    address. The desktop's URL cannot answer for this radio (N0b-4a).
  let deviceStreamUrl: string | null = null;
  rows.push(
    await step('R1', 'audioStream (playurl minted on this device)', async () => {
      if (track === undefined) return { ok: false, detail: 'no track in the fixture' };
      const stream = await client.audioStream(track.bvid, track.cid, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      deviceStreamUrl = stream.url;
      const host = stream.url.slice(stream.url.indexOf('//') + 2).split('/')[0] ?? '?';
      return {
        ok: stream.url.length > 0,
        detail: `${stream.codecs} ${Math.round(stream.bandwidth / 1000)}kbps · host ${host} (desktop got ${track.streamHost})`,
      };
    }),
  );

  // ⑥ The b23 hop: one manual redirect, exactly as `resolveInput` does it.
  rows.push(
    await step('R1', 'expandShortLink (b23.tv, redirect: manual)', async () => {
      const target = await client.expandShortLink(refs.shortLink.url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const parsed = parseSongInput(target);
      const desktopParsed = refs.shortLink.parsed as { bvid?: string } | null | undefined;
      const desktopBvid = desktopParsed?.bvid ?? null;
      const bvid = 'bvid' in parsed ? parsed.bvid : null;
      return {
        ok: bvid !== null && (desktopBvid === null || bvid === desktopBvid),
        detail: `${target.slice(0, 60)} → ${bvid ?? 'no bvid'}${desktopBvid === null ? ' (desktop could not expand)' : ` (desktop: ${desktopBvid})`}`,
      };
    }),
  );

  // ⑦ openAudio: streamed, bounded, and then aborted mid-flight.
  rows.push(
    await step('R1', 'openAudio streams bytes and stops on abort', async () => {
      if (deviceStreamUrl === null) return { ok: false, detail: 'no stream URL from step ⑤' };
      const controller = new AbortController();
      const response = await client.openAudio(deviceStreamUrl, { signal: controller.signal });
      const body = response.body;
      if (body === null) return { ok: false, detail: `HTTP ${response.status} with no body` };

      const reader = body.getReader();
      let received = 0;
      let chunks = 0;
      while (received < 256 * 1024) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value?.byteLength ?? 0;
        chunks += 1;
      }
      controller.abort();

      let stopped = 'read after abort did not throw';
      try {
        await reader.read();
      } catch (err) {
        stopped = `read after abort threw ${err instanceof Error ? err.name : 'unknown'}`;
      }
      return {
        ok: response.status === 200 || response.status === 206,
        detail: `HTTP ${response.status} · ${received}B in ${chunks} chunk(s) · ${stopped}`,
      };
    }),
  );

  return rows;
}

// ─── R2 ────────────────────────────────────────────────

export async function runR2Panel(): Promise<CoreClientRow[]> {
  installPortableRuntime();
  const { network, error } = await loadFixtures();
  if (network === null || network.references === undefined) {
    return [
      { group: 'R2', name: 'references', ok: null, detail: error ?? 'no references section' },
    ];
  }

  // Offline and deterministic, so this is an equality check and nothing else:
  // the same input through the same function has to produce the same object.
  return network.references.parses.map(({ input, parsed, threw }) => {
    const name = input.length > 44 ? `${input.slice(0, 44)}…` : input;
    let here: unknown = null;
    let hereThrew: string | null = null;
    try {
      here = parseSongInput(input);
    } catch (err) {
      hereThrew = err instanceof Error ? err.name : String(err);
    }
    if (threw !== null || hereThrew !== null) {
      // Both sides must refuse, and refuse with the same class.
      return {
        group: 'R2',
        name,
        ok: hereThrew === threw,
        detail:
          hereThrew === threw
            ? `both refused with ${threw}`
            : `phone ${hereThrew ?? 'accepted it'} vs desktop ${threw ?? 'accepted it'}`,
      };
    }
    const same = JSON.stringify(here) === JSON.stringify(parsed);
    return {
      group: 'R2',
      name,
      ok: same,
      detail: same
        ? JSON.stringify(here)
        : `phone ${JSON.stringify(here)} vs desktop ${JSON.stringify(parsed)}`,
    };
  });
}

// ─── R3 ────────────────────────────────────────────────

export async function runR3Panel(): Promise<CoreClientRow[]> {
  installPortableRuntime();
  const rows: CoreClientRow[] = [];
  const { network, error } = await loadFixtures();
  if (network === null || network.references === undefined) {
    return [
      { group: 'R3', name: 'references', ok: null, detail: error ?? 'no references section' },
    ];
  }
  const ref = network.references.lyrics;

  rows.push({
    group: 'R3',
    name: 'desktop reference',
    ok: null,
    detail:
      ref.error !== null
        ? `desktop failed: ${ref.error}`
        : `${ref.platform ?? 'no pick'} · ${ref.candidateCount} candidate(s) from [${ref.platformsWithCandidates.join(', ')}]${ref.failures.length > 0 ? ` · failures: ${ref.failures.join('; ')}` : ''}`,
  });

  rows.push(
    await step('R3', 'fetchLyrics on this device (no LLM, heuristic pick)', async () => {
      // No `llmConfig`: the heuristic picks, so this measures the three
      // platform clients and the base64 + text ports, not a model.
      const { best, result } = await fetchLyrics(ref.query, {
        signal: AbortSignal.timeout(60_000),
      });
      const platforms = [...new Set(result.candidates.map((c) => c.platform))].sort();
      if (best === null) {
        return {
          ok: false,
          detail: `no candidate; platforms tried [${platforms.join(', ')}] · failures: ${result.failures.map((f) => `${f.platform}: ${f.message}`).join('; ') || 'none'}`,
        };
      }
      // The LRC has to be lyrics, not an empty document that decoded cleanly:
      // both QQ and Kugou answer in base64, which is the port under test here.
      const timestamps = (best.lrc.match(/\[\d{2}:\d{2}/g) ?? []).length;
      return {
        ok: best.lrc.length > 0 && timestamps > 0,
        detail: `${best.platform} · ${best.lrc.length} chars · ${timestamps} timestamps · candidates from [${platforms.join(', ')}] (desktop: [${ref.platformsWithCandidates.join(', ')}])`,
      };
    }),
  );

  return rows;
}
