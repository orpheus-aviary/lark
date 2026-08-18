// QQ Music. Search by keyword, then fetch each hit's lyric by `songmid`.
// Lyrics come back base64-encoded even with `nobase64=0`.

import { type LyricsCandidate, toCandidate } from './lrc.js';
import {
  type LyricsQuery,
  type LyricsSourceOptions,
  MAX_CANDIDATES,
  UA,
  arr,
  decodeBase64,
  firstName,
  getJson,
  rec,
  resolveSourceOptions,
  searchTerm,
  str,
} from './shared.js';

export async function searchQq(
  query: LyricsQuery,
  options: LyricsSourceOptions = {},
): Promise<LyricsCandidate[]> {
  const { fetchImpl, signal, origins } = resolveSourceOptions(options);
  const headers = { referer: 'https://y.qq.com', 'user-agent': UA };
  const params = new URLSearchParams({
    w: searchTerm(query),
    p: '1',
    n: '5',
    format: 'json',
    cr: '1',
  });

  const search = await getJson(
    fetchImpl,
    `${origins.qq}/soso/fcgi-bin/client_search_cp?${params}`,
    { headers, signal },
  );

  const out: LyricsCandidate[] = [];
  for (const entry of arr(rec(rec(rec(search)?.data)?.song)?.list)) {
    if (out.length >= MAX_CANDIDATES) break;
    const song = rec(entry);
    const mid = str(song?.songmid);
    if (mid === '') continue;

    const lyricParams = new URLSearchParams({ songmid: mid, format: 'json', nobase64: '0' });
    const lyric = await getJson(
      fetchImpl,
      `${origins.qq}/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${lyricParams}`,
      { headers, signal },
    ).catch(() => null);

    const decoded = decodeBase64(str(rec(lyric)?.lyric));
    if (decoded === null) continue;
    const candidate = toCandidate('qq', str(song?.songname), firstName(song?.singer), decoded);
    if (candidate !== null) out.push(candidate);
  }
  return out;
}
