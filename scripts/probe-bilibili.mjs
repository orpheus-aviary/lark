#!/usr/bin/env node
// Live bilibili endpoint probe (M3-12 ⑤). NOT part of `just check` / CI: it
// talks to the real api.bilibili.com, so it is run by hand — on the first day
// of M3 (the fav / collection go-no-go gate) and again at M3 acceptance.
//
// Why it exists: the Go version's keyword search stopped working silently. A
// risk-control interception answers HTTP 200 with an HTML page, so "it
// compiles and the request succeeds" says nothing. Each check below asserts
// the SHAPE we depend on (envelope code 0, the field the pipeline reads), and
// the unsigned-search check asserts the FAILURE we expect — if bilibili ever
// re-opens it, that check turns red and tells us the WBI machinery could be
// dropped.
//
// Everything is discovered from one keyword search (bvid / mid / season_id /
// media_id), so there are no hard-coded video ids to rot. Any of them can be
// pinned through the environment:
//
//   PROBE_KEYWORD  PROBE_BVID  PROBE_MID  PROBE_SEASON_ID  PROBE_MEDIA_ID
//
// Running it several times back to back trips rate limiting: the signed search
// starts answering the interception page, and every later check then fails
// with "no mid discovered". That cascade is the probe hitting a limit, NOT a
// broken signature — wait a minute and re-run before believing it.

import { createHash } from 'node:crypto';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com';
const TIMEOUT_MS = 15_000;
const KEYWORD = process.env.PROBE_KEYWORD ?? '周杰伦 稻香';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

// ─── HTTP ──────────────────────────────────────────────

/** buvid3 / buvid4 issued by the spi endpoint, filled by `probeSpi`. */
const state = { buvid3: '', buvid4: '', imgKey: '', subKey: '' };

function cookieHeader() {
  const parts = [];
  if (state.buvid3) parts.push(`buvid3=${state.buvid3}`);
  if (state.buvid4) parts.push(`buvid4=${state.buvid4}`);
  return parts.join('; ');
}

async function get(url, { withCookie = true } = {}) {
  const headers = { 'User-Agent': UA, Referer: REFERER };
  const cookie = withCookie ? cookieHeader() : '';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', text };
}

/**
 * Read bilibili's `{code, message, data}` envelope. A risk-control page is an
 * HTML body under HTTP 200 — the exact failure mode that made the Go version
 * look healthy while returning nothing.
 */
async function getJson(url, opts) {
  const res = await get(url, opts);
  if (!res.contentType.includes('json')) {
    throw new Error(
      `non-JSON response (HTTP ${res.status}, ${res.contentType || 'no content-type'}): ${res.text.slice(0, 120).replace(/\s+/g, ' ')}`,
    );
  }
  const body = JSON.parse(res.text);
  if (body.code !== 0) throw new Error(`envelope code ${body.code}: ${body.message}`);
  return body.data;
}

// ─── WBI signing ───────────────────────────────────────

function mixinKey(orig) {
  let out = '';
  for (const idx of MIXIN_KEY_ENC_TAB) if (idx < orig.length) out += orig[idx];
  return out.slice(0, 32);
}

function signWbi(params) {
  const wts = Math.floor(Date.now() / 1000).toString();
  const signed = { ...params, wts };
  const query = Object.keys(signed)
    .sort()
    .map(
      (k) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(String(signed[k]).replace(/[!'()*]/g, ''))}`,
    )
    .join('&');
  const wRid = createHash('md5')
    .update(query + mixinKey(state.imgKey + state.subKey))
    .digest('hex');
  return `${query}&w_rid=${wRid}`;
}

// ─── Check runner ──────────────────────────────────────

const results = [];

/**
 * A check answers PASS, FAIL, or SKIP. SKIP exists because "no sample data
 * found" is not the same verdict as "the endpoint is gone": throw `skip(msg)`
 * when the endpoint could not be exercised for lack of an input id.
 */
class SkipError extends Error {}
const skip = (msg) => {
  throw new SkipError(msg);
};

async function check(name, { gate = false }, fn) {
  try {
    const detail = await fn();
    results.push({ name, state: 'PASS', gate, detail: detail ?? 'ok' });
  } catch (err) {
    results.push({
      name,
      state: err instanceof SkipError ? 'SKIP' : 'FAIL',
      gate,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ─── Probes ────────────────────────────────────────────

const discovered = {
  bvid: process.env.PROBE_BVID ?? '',
  cid: 0,
  mid: process.env.PROBE_MID ?? '',
  seasonId: process.env.PROBE_SEASON_ID ?? '',
  mediaId: process.env.PROBE_MEDIA_ID ?? '',
  /** Every uploader the search turned up — favourites folders are opt-in public. */
  candidateMids: [],
};

/** Strip the `<em class="keyword">` highlight markup search results carry. */
function stripHighlight(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

async function main() {
  // 1. spi — issues the buvid3/buvid4 every later request carries.
  await check('spi buvid (x/frontend/finger/spi)', {}, async () => {
    const data = await getJson('https://api.bilibili.com/x/frontend/finger/spi', {
      withCookie: false,
    });
    must(typeof data.b_3 === 'string' && data.b_3.length > 0, 'no b_3 in spi response');
    state.buvid3 = data.b_3;
    state.buvid4 = data.b_4 ?? '';
    return `b_3=${state.buvid3.slice(0, 12)}… b_4=${state.buvid4 ? 'present' : 'absent'}`;
  });

  // 2. nav — WBI img/sub keys, no login required.
  await check('wbi keys (x/web-interface/nav)', {}, async () => {
    const res = await get('https://api.bilibili.com/x/web-interface/nav');
    const body = JSON.parse(res.text); // nav answers code -101 (not logged in) WITH the keys
    const wbi = body?.data?.wbi_img;
    must(wbi?.img_url && wbi?.sub_url, 'nav response carries no wbi_img');
    const keyOf = (u) => u.split('/').pop().split('.')[0];
    state.imgKey = keyOf(wbi.img_url);
    state.subKey = keyOf(wbi.sub_url);
    must(state.imgKey.length === 32 && state.subKey.length === 32, 'wbi keys are not 32 chars');
    return `img=${state.imgKey.slice(0, 8)}… sub=${state.subKey.slice(0, 8)}… (nav code ${body.code})`;
  });

  // 3. UNSIGNED search — expected to FAIL. Green here means bilibili re-opened
  //    it and the WBI machinery is no longer load-bearing.
  await check('unsigned search is blocked (x/web-interface/search/type)', {}, async () => {
    let blocked = '';
    try {
      await getJson(
        `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(KEYWORD)}&page=1`,
      );
    } catch (err) {
      blocked = err.message;
    }
    must(blocked !== '', 'unsigned search SUCCEEDED — re-evaluate whether WBI is still needed');
    return `blocked as expected — ${blocked.slice(0, 80)}`;
  });

  // 4. WBI-signed search — the keyword path the engine depends on.
  await check('wbi search (x/web-interface/wbi/search/type)', {}, async () => {
    const query = signWbi({
      search_type: 'video',
      keyword: KEYWORD,
      page: 1,
      page_size: 10,
    });
    const data = await getJson(`https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`);
    const list = data.result ?? [];
    must(list.length > 0, 'signed search returned no results');
    const first = list[0];
    must(typeof first.bvid === 'string' && first.bvid.startsWith('BV'), 'no bvid on first result');
    if (!discovered.bvid) discovered.bvid = first.bvid;
    if (!discovered.mid) discovered.mid = String(first.mid ?? '');
    discovered.candidateMids = list.map((r) => String(r.mid ?? '')).filter((m) => m !== '');
    const marked = list.filter((r) => /<em/.test(r.title ?? '')).length;
    return `${list.length} results, first=${first.bvid} "${stripHighlight(first.title ?? '')}" (${marked}/${list.length} titles carry <em> markup)`;
  });

  // 5. pagelist — the p → cid step of source-key normalisation (R30).
  await check('pagelist (x/player/pagelist)', {}, async () => {
    must(discovered.bvid !== '', 'no bvid discovered (search failed and PROBE_BVID unset)');
    const data = await getJson(
      `https://api.bilibili.com/x/player/pagelist?bvid=${discovered.bvid}`,
    );
    must(Array.isArray(data) && data.length > 0, 'empty pagelist');
    must(typeof data[0].cid === 'number', 'no cid on page 1');
    discovered.cid = data[0].cid;
    return `${discovered.bvid}: ${data.length} page(s), p1 cid=${discovered.cid}`;
  });

  // 6. view — title / owner / duration, the frozen naming source (M3-7).
  await check('view (x/web-interface/view)', {}, async () => {
    must(discovered.bvid !== '', 'no bvid available');
    const data = await getJson(
      `https://api.bilibili.com/x/web-interface/view?bvid=${discovered.bvid}`,
    );
    must(typeof data.title === 'string' && data.title.length > 0, 'no title');
    must(typeof data.owner?.name === 'string', 'no owner.name');
    if (!discovered.mid) discovered.mid = String(data.owner?.mid ?? '');
    return `"${data.title}" by ${data.owner.name} (${data.videos} page(s), ${data.duration}s)`;
  });

  // 7. playurl — dash.audio tiers; the engine takes the highest bandwidth.
  await check('playurl dash.audio (x/player/playurl)', {}, async () => {
    must(discovered.cid !== 0, 'no cid available');
    const data = await getJson(
      `https://api.bilibili.com/x/player/playurl?bvid=${discovered.bvid}&cid=${discovered.cid}&fnval=16&fourk=1`,
    );
    const audio = data?.dash?.audio ?? [];
    must(audio.length > 0, 'no dash.audio streams');
    const best = audio.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
    must(typeof best.baseUrl === 'string' && best.baseUrl.startsWith('http'), 'no baseUrl');
    return `${audio.length} tier(s) [${audio.map((a) => a.id).join(', ')}], best bandwidth=${best.bandwidth}`;
  });

  // ─── go/no-go gate: batch list endpoints (never probed before M3) ───

  // Sample discovery only — NOT a gate. `folder/created/list-all` answers
  // `data: null` anonymously (login-gated since the Go era), but lark never
  // needs it: a favourites URL carries the media_id
  // (`space.bilibili.com/<uid>/favlist?fid=<media_id>`). So we reach a real
  // folder through the default-folder convention, media_id = mid * 10 + 2, and
  // walk the search's uploaders until one has a non-empty public folder.
  await check('favorites info (x/v3/fav/folder/info)', { gate: true }, async () => {
    if (discovered.mediaId) {
      const data = await getJson(
        `https://api.bilibili.com/x/v3/fav/folder/info?media_id=${discovered.mediaId}`,
      );
      must(data !== null, 'folder is private or does not exist');
      return `PROBE_MEDIA_ID=${discovered.mediaId}: "${data.title}" (${data.media_count} items)`;
    }
    const mids = [...new Set([discovered.mid, ...discovered.candidateMids])].filter(
      (m) => m !== '',
    );
    must(mids.length > 0, 'no mid discovered');
    let reachable = 0;
    let lastError = null;
    for (const mid of mids) {
      const mediaId = String(BigInt(mid) * 10n + 2n);
      try {
        const data = await getJson(
          `https://api.bilibili.com/x/v3/fav/folder/info?media_id=${mediaId}`,
        );
        if (data === null) continue; // private folder — not an endpoint failure
        reachable++;
        if (data.media_count > 0) {
          discovered.mediaId = mediaId;
          return `mid ${mid} default folder: "${data.title}" (${data.media_count} items, media_id=${mediaId})`;
        }
      } catch (err) {
        lastError = err;
      }
    }
    must(reachable > 0, `no folder was readable — last error: ${lastError?.message}`);
    return `endpoint healthy (${reachable}/${mids.length} folders readable) but all are empty — set PROBE_MEDIA_ID to exercise paging`;
  });

  await check('favorites page (x/v3/fav/resource/list)', { gate: true }, async () => {
    if (discovered.mediaId === '') skip('no non-empty public folder found — set PROBE_MEDIA_ID');
    const data = await getJson(
      `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${discovered.mediaId}&ps=20&pn=1`,
    );
    const medias = data?.medias ?? [];
    must(medias.length > 0, 'no medias in page 1');
    must(typeof medias[0].bvid === 'string', 'no bvid on first media');
    return `${medias.length} item(s), has_more=${data.has_more}, first=${medias[0].bvid} "${medias[0].title}"`;
  });

  await check(
    'collection list (x/polymer/web-space/home/seasons_series)',
    { gate: true },
    async () => {
      if (discovered.seasonId) return `skipped discovery — PROBE_SEASON_ID=${discovered.seasonId}`;
      must(discovered.mid !== '', 'no mid discovered');
      const data = await getJson(
        `https://api.bilibili.com/x/polymer/web-space/home/seasons_series?mid=${discovered.mid}&page_num=1&page_size=10`,
      );
      const seasons = data?.items_lists?.seasons_list ?? [];
      must(seasons.length > 0, `up ${discovered.mid} publishes no 合集`);
      discovered.seasonId = String(seasons[0].meta.season_id);
      return `mid ${discovered.mid}: ${seasons.length} season(s), first="${seasons[0].meta.name}" season_id=${discovered.seasonId}`;
    },
  );

  await check(
    'collection page (x/polymer/web-space/seasons_archives_list)',
    { gate: true },
    async () => {
      must(discovered.seasonId !== '', 'no season_id available');
      const data = await getJson(
        `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${discovered.mid}&season_id=${discovered.seasonId}&page_num=1&page_size=30`,
      );
      const archives = data?.archives ?? [];
      must(archives.length > 0, 'no archives in page 1');
      must(typeof archives[0].bvid === 'string', 'no bvid on first archive');
      return `"${data.meta?.name ?? '?'}": ${archives.length}/${data.page?.total} item(s), first=${archives[0].bvid}`;
    },
  );

  // ─── Report ──────────────────────────────────────────

  console.log('\nbilibili live probe — %s\n', new Date().toISOString());
  for (const r of results) {
    console.log('  %s%s  %s\n        %s', r.state, r.gate ? ' [gate]' : '', r.name, r.detail);
  }

  const failed = results.filter((r) => r.state === 'FAIL');
  const skipped = results.filter((r) => r.state === 'SKIP');
  const gateFailed = failed.filter((r) => r.gate);
  console.log(
    '\n%d passed, %d failed, %d skipped%s\n',
    results.length - failed.length - skipped.length,
    failed.length,
    skipped.length,
    gateFailed.length > 0
      ? ` — ${gateFailed.length} GATE failure(s): fetch-list scope needs a user decision`
      : '',
  );
  process.exitCode = failed.length > 0 ? 1 : 0;
}

await main();
