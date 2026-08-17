// Criterion 21 — the Web-standard surface core assumes, checked on the phone.
//
// The list is §1.3-A's, item for item, plus one addition noted where it appears.
// The output is the three-column table the criterion asks for: NATIVE (Hermes
// itself), POLYFILL (RN/Expo hand it to us in JS — nothing to do), PORT (absent,
// or present and behaving differently enough that N1 has to route it).
//
// Two things make a row mean something:
//
//   1. Presence is not the question. `atob` exists and is NOT what
//      `Buffer.from(x,'base64')` does, so a row that stopped at `typeof` would
//      classify the one API most likely to silently corrupt lyrics as "fine".
//      Every row that has a desktop-side answer is compared against it
//      (`desktop-fixtures.ts`, produced by node:crypto/Buffer).
//   2. Where it comes from is observable: a Hermes builtin stringifies as
//      `[native code]`, a JS polyfill stringifies as its source. That is the
//      evidence behind the native/polyfill split rather than a guess.
//
// The fetch rows need a peer, so they talk to the desktop probe server over
// `adb reverse` (`just spike-mobile-probe-host`). LAN plaintext HTTP is allowed
// in the spike and only in the spike (decision f). With no server reachable the
// rows report UNVERIFIED — never green.

import { fetch as expoFetch } from 'expo/fetch';
import { BASE64_FIXTURES, UTF8_FIXTURES } from '../desktop-fixtures';
import { PROBE_HOST } from '../report';

export type Verdict = 'native' | 'polyfill' | 'port' | 'unverified';

export interface GlobalRow {
  api: string;
  /** Where core depends on it (subplan §1.3-A). */
  usedBy: string;
  verdict: Verdict;
  detail: string;
}

/** `[native code]` means Hermes; anything else is JS somebody shipped. */
function sourceOf(fn: (...args: never[]) => unknown): 'native' | 'polyfill' {
  return Function.prototype.toString.call(fn).includes('[native code]') ? 'native' : 'polyfill';
}

function provenance(fn: unknown): 'native' | 'polyfill' | 'absent' {
  return typeof fn === 'function' ? sourceOf(fn as (...args: never[]) => unknown) : 'absent';
}

function row(
  api: string,
  usedBy: string,
  impl: unknown,
  check: () => { ok: boolean; detail: string },
): GlobalRow {
  const where = provenance(impl);
  if (where === 'absent') {
    return { api, usedBy, verdict: 'port', detail: 'absent — N1 must route this through a port' };
  }
  let result: { ok: boolean; detail: string };
  try {
    result = check();
  } catch (err) {
    result = { ok: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  return {
    api,
    usedBy,
    verdict: result.ok ? where : 'port',
    detail: result.ok ? `${where} · ${result.detail}` : `${where} but DIVERGES · ${result.detail}`,
  };
}

// ─── synchronous surface ────────────────────────────────

function syncRows(): GlobalRow[] {
  const rows: GlobalRow[] = [];

  rows.push(
    row(
      'new URL + searchParams',
      'download/link.ts:179,226,258 · sync/server-url.ts:44',
      URL,
      () => {
        const url = new URL('https://api.bilibili.com/x/player/playurl');
        url.searchParams.set('bvid', 'BV1xx411c7mD');
        url.searchParams.set('cid', '123');
        const built = url.toString();
        const parsed = new URL('https://b23.tv/AbCdEf?p=2');
        let rejected = false;
        try {
          // link.ts leans on the throw to tell a link from a keyword.
          new URL('not a link at all');
        } catch {
          rejected = true;
        }
        return {
          ok:
            built === 'https://api.bilibili.com/x/player/playurl?bvid=BV1xx411c7mD&cid=123' &&
            parsed.hostname === 'b23.tv' &&
            parsed.pathname === '/AbCdEf' &&
            parsed.searchParams.get('p') === '2' &&
            rejected,
          detail: `${built} · b23 path ${parsed.pathname} · rejects a non-URL: ${rejected}`,
        };
      },
    ),
  );

  rows.push(
    row(
      'URLSearchParams',
      'lyrics netease.ts:25 · qq.ts:26,47 · kugou.ts:29,52,68',
      URLSearchParams,
      () => {
        const params = new URLSearchParams({ hash: 'abc', duration: '215000' });
        params.append('keyword', '床前明月光');
        return {
          ok:
            params.get('duration') === '215000' &&
            params.toString() ===
              'hash=abc&duration=215000&keyword=%E5%BA%8A%E5%89%8D%E6%98%8E%E6%9C%88%E5%85%89',
          detail: params.toString(),
        };
      },
    ),
  );

  rows.push(
    row('TextDecoder', 'skybridge sse.ts:93', TextDecoder, () => {
      // SSE arrives in chunks, and a chunk can split a character in half. The
      // streaming decode is the one that matters.
      const bytes = new TextEncoder().encode('数据: 歌单已更新 🎵');
      const decoder = new TextDecoder();
      const half = Math.floor(bytes.length / 2);
      const streamed =
        decoder.decode(bytes.slice(0, half), { stream: true }) + decoder.decode(bytes.slice(half));
      return {
        ok: streamed === '数据: 歌单已更新 🎵',
        detail: `split at ${half}/${bytes.length} bytes rejoins intact: ${streamed === '数据: 歌单已更新 🎵'}`,
      };
    }),
  );

  rows.push(
    row(
      'TextEncoder (the Buffer.byteLength port)',
      'sync/changes.ts:87 · engine.ts:362 · backfill.ts:281 · file-ops.ts:341 · library/lyrics.ts:137',
      TextEncoder,
      () => {
        const encoder = new TextEncoder();
        const wrong = UTF8_FIXTURES.filter((f) => encoder.encode(f.text).length !== f.bytes);
        return {
          ok: wrong.length === 0,
          detail:
            wrong.length === 0
              ? `${UTF8_FIXTURES.length}/${UTF8_FIXTURES.length} byte lengths match Buffer.byteLength, incl. a lone surrogate`
              : `differs on: ${wrong.map((w) => w.name).join(', ')}`,
        };
      },
    ),
  );

  rows.push(
    row('structuredClone', 'config/index.ts:71,80,104,113', globalThis.structuredClone, () => {
      const original = { llm: { api_format: '', keys: ['a', 'b'] }, cache: { max_mb: 0 } };
      const copy = structuredClone(original);
      copy.llm.keys.push('c');
      copy.cache.max_mb = 900;
      return {
        ok:
          original.llm.keys.length === 2 &&
          original.cache.max_mb === 0 &&
          copy.llm.keys.length === 3,
        detail: 'deep copy, original untouched',
      };
    }),
  );

  // The base64 port. Its verdict is the interesting one: core feeds whatever QQ
  // and Kugou answered straight into `Buffer.from(v,'base64')`, which skips
  // illegal characters and tolerates missing padding. `atob` refuses. Both are
  // defensible; they are not the same function, and `decodeBase64` swallows the
  // difference into `null` at one call site while returning different STRINGS
  // at another.
  const atobFn = (globalThis as { atob?: (s: string) => string }).atob;
  rows.push(
    row('atob (the Buffer.from(…,"base64") port)', 'download/lyrics/shared.ts:93', atobFn, () => {
      const decode = (input: string): string => {
        const binary = (atobFn as (s: string) => string)(input);
        return Array.from(binary, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
      };
      const diffs: string[] = [];
      for (const fixture of BASE64_FIXTURES) {
        let actual: string;
        try {
          actual = decode(fixture.input);
        } catch (err) {
          actual = `threw ${err instanceof Error ? err.name : 'Error'}`;
        }
        if (actual !== fixture.bytesHex)
          diffs.push(`${fixture.name}: ${actual} vs ${fixture.bytesHex}`);
      }
      return {
        ok: diffs.length === 0,
        detail:
          diffs.length === 0
            ? `all ${BASE64_FIXTURES.length} cases byte-identical to Buffer.from`
            : `${diffs.length}/${BASE64_FIXTURES.length} differ — ${diffs.join(' | ')}`,
      };
    }),
  );

  const bufferGlobal = (globalThis as { Buffer?: unknown }).Buffer;
  rows.push({
    api: 'Buffer (global)',
    usedBy: 'every Buffer.byteLength / Buffer.from call site above',
    verdict: bufferGlobal === undefined ? 'port' : 'polyfill',
    detail:
      bufferGlobal === undefined
        ? 'absent, as expected — the two rows above are what replaces it'
        : 'present: something in the graph shipped a Buffer polyfill, which N1 should not depend on by accident',
  });

  // NOT in §1.3-A. Added because `listSongs` sorts through `Intl.Collator('zh-CN')`
  // (library/songs.ts:75,314) and Hermes ships Intl conditionally — a missing
  // collator is a crash on the library screen, not a slow sort.
  rows.push(
    row(
      'Intl.Collator("zh-CN")  [beyond §1.3-A]',
      'library/songs.ts:75,314',
      Intl?.Collator,
      () => {
        const collator = new Intl.Collator('zh-CN');
        const sorted = ['西游记', '安静', '不了情'].sort((a, b) => collator.compare(a, b));
        return {
          ok: sorted.length === 3 && collator.compare('a', 'b') < 0,
          detail: `zh order: ${sorted.join(' < ')}`,
        };
      },
    ),
  );

  rows.push(
    row(
      'performance.now',
      'the measurement protocol itself (§3.2a)',
      globalThis.performance?.now,
      () => {
        const a = performance.now();
        const b = performance.now();
        return { ok: b >= a, detail: `resolution sample: ${(b - a).toFixed(4)}ms apart` };
      },
    ),
  );

  return rows;
}

// ─── asynchronous surface ───────────────────────────────

async function abortRows(): Promise<GlobalRow[]> {
  const rows: GlobalRow[] = [];

  const timeoutFn = (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout;
  if (typeof timeoutFn !== 'function') {
    rows.push({
      api: 'AbortSignal.timeout',
      usedBy: 'download/timeouts.ts:62',
      verdict: 'port',
      detail: 'absent — every core timeout is built on it',
    });
  } else {
    const signal = AbortSignal.timeout(30);
    const fired = await new Promise<boolean>((resolve) => {
      signal.addEventListener('abort', () => resolve(true));
      setTimeout(() => resolve(signal.aborted), 300);
    });
    rows.push({
      api: 'AbortSignal.timeout',
      usedBy: 'download/timeouts.ts:62',
      verdict: fired ? sourceOf(timeoutFn) : 'port',
      detail: fired ? 'fires' : 'never fired within 300ms',
    });
  }

  const anyFn = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn !== 'function') {
    rows.push({
      api: 'AbortSignal.any',
      usedBy: 'download/timeouts.ts:62 · download/engine.ts:793',
      verdict: 'port',
      detail: 'absent — `withTimeout` combines caller and timeout signals with it',
    });
  } else {
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    controller.abort();
    rows.push({
      api: 'AbortSignal.any',
      usedBy: 'download/timeouts.ts:62 · download/engine.ts:793',
      verdict: combined.aborted ? sourceOf(anyFn) : 'port',
      detail: combined.aborted
        ? 'aborting one member aborts the combination'
        : 'the combination ignored its member',
    });
  }

  return rows;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The three fetch behaviours core needs, against both implementations.
 *
 * `expo/fetch` is the one N1 is expected to inject (it streams); the global is
 * RN's XHR-backed one and is what a careless `fetchImpl` default would pick up.
 * Testing both is how the difference becomes a documented row instead of a
 * surprise in N4.
 */
async function fetchRow(
  api: string,
  usedBy: string,
  passing: 'native' | 'polyfill',
  check: () => Promise<{ ok: boolean; detail: string }>,
): Promise<GlobalRow> {
  try {
    const { ok, detail } = await check();
    return { api, usedBy, verdict: ok ? passing : 'port', detail };
  } catch (err) {
    return {
      api,
      usedBy,
      verdict: 'port',
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** b23.tv is expanded by reading Location WITHOUT following (bilibili.ts:318,326). */
function redirectRow(name: string, impl: FetchLike, passing: 'native' | 'polyfill') {
  return fetchRow(
    `${name}: redirect:'manual' + read Location`,
    'download/bilibili.ts:318,326 (b23.tv expansion)',
    passing,
    async () => {
      const res = await impl(`${PROBE_HOST}/redirect`, { redirect: 'manual' });
      const location = res.headers.get('location');
      const ok = location === '/redirected' && res.status >= 300 && res.status < 400;
      return {
        ok,
        detail: `status ${res.status} · location ${location ?? 'null'}${
          ok ? '' : ' — the redirect was followed, or the header was hidden'
        }`,
      };
    },
  );
}

function emptyBodyRow(name: string, impl: FetchLike, passing: 'native' | 'polyfill') {
  return fetchRow(`${name}: 204 with no body`, 'skybridge http.ts:77', passing, async () => {
    const res = await impl(`${PROBE_HOST}/empty`);
    const body = await res.text();
    return {
      ok: res.status === 204 && res.ok && body === '',
      detail: `status ${res.status} · ok ${res.ok} · body ${JSON.stringify(body)}`,
    };
  });
}

function streamingRow(name: string, impl: FetchLike, passing: 'native' | 'polyfill') {
  return fetchRow(
    `${name}: streaming res.body`,
    'skybridge sse.ts:43-47 (subscribeEvents)',
    passing,
    async () => {
      const res = await impl(`${PROBE_HOST}/stream`);
      const body = res.body;
      if (body === null || body === undefined) {
        return {
          ok: false,
          detail: 'res.body is null — this one buffers, so SSE cannot read it incrementally',
        };
      }
      const reader = body.getReader();
      let chunks = 0;
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks += 1;
        bytes += value?.length ?? 0;
      }
      // One chunk means the response was buffered and handed over whole, which
      // reads as success and is exactly what SSE cannot use.
      return {
        ok: chunks > 1,
        detail:
          chunks > 1
            ? `${chunks} chunks / ${bytes} bytes arrived incrementally`
            : `body existed but arrived as ${chunks} chunk — buffered, not streamed`,
      };
    },
  );
}

async function fetchRows(name: string, impl: FetchLike): Promise<GlobalRow[]> {
  const passing = provenance(impl) === 'native' ? 'native' : 'polyfill';
  const unreachable = (detail: string): GlobalRow[] => [
    {
      api: `${name} — redirect:'manual' / 204 / streaming body`,
      usedBy: 'bilibili.ts:318,326 · skybridge http.ts:77 · sse.ts:43-47',
      verdict: 'unverified',
      detail: `probe host unreachable (${detail}). Run \`just spike-mobile-probe-host\` and retry — this row does not go green on its own.`,
    },
  ];

  try {
    const health = await impl(`${PROBE_HOST}/health`);
    if (!health.ok) return unreachable(`/health answered ${health.status}`);
  } catch (err) {
    return unreachable(err instanceof Error ? err.message : String(err));
  }

  return [
    await redirectRow(name, impl, passing),
    await emptyBodyRow(name, impl, passing),
    await streamingRow(name, impl, passing),
  ];
}

export async function runGlobalsPanel(): Promise<GlobalRow[]> {
  const rows = [...syncRows(), ...(await abortRows())];

  // Whether these are two implementations or one is the difference between
  // "N1 must inject expo/fetch" and "the default is already it". Both sets of
  // rows are run either way; this says how to read them.
  const same = (globalThis.fetch as unknown) === (expoFetch as unknown);
  rows.push({
    api: 'globalThis.fetch vs expo/fetch — same function?',
    usedBy: 'every `fetchImpl` injection point (skybridge http.ts:33,113,141 · client.ts:201)',
    verdict: 'polyfill',
    detail: same
      ? 'identical — the global IS expo/fetch, so the two blocks below are one measurement'
      : 'different functions — the rows below are two independent measurements',
  });

  rows.push(...(await fetchRows('globalThis.fetch', globalThis.fetch as FetchLike)));
  rows.push(...(await fetchRows('expo/fetch', expoFetch as unknown as FetchLike)));
  return rows;
}
