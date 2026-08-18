// NetEase Cloud Music. Two hops: a form-encoded search, then one lyric fetch
// per hit until three candidates have real timed LRC.

import { type LyricsCandidate, toCandidate } from './lrc.js';
import {
  type LyricsQuery,
  type LyricsSourceOptions,
  MAX_CANDIDATES,
  UA,
  arr,
  firstName,
  getJson,
  rec,
  resolveSourceOptions,
  searchTerm,
  str,
} from './shared.js';

export async function searchNetease(
  query: LyricsQuery,
  options: LyricsSourceOptions = {},
): Promise<LyricsCandidate[]> {
  const { fetchImpl, signal, origins } = resolveSourceOptions(options);
  const headers = { referer: 'https://music.163.com', 'user-agent': UA };
  const body = new URLSearchParams({
    s: searchTerm(query),
    type: '1',
    limit: '10',
    offset: '0',
  });

  const search = await getJson(fetchImpl, `${origins.netease}/api/search/get`, {
    method: 'POST',
    body: body.toString(),
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    signal,
  });

  const out: LyricsCandidate[] = [];
  for (const entry of arr(rec(rec(search)?.result)?.songs)) {
    if (out.length >= MAX_CANDIDATES) break;
    const song = rec(entry);
    const id = song?.id;
    if (typeof id !== 'number') continue;

    // `lv=1` asks for the timed version. A hit with only a plain-text
    // translation yields no timestamps and `toCandidate` drops it.
    const lyric = await getJson(fetchImpl, `${origins.netease}/api/song/lyric?id=${id}&lv=1`, {
      headers,
      signal,
    }).catch(() => null);

    const candidate = toCandidate(
      'netease',
      str(song?.name),
      firstName(song?.artists),
      str(rec(rec(lyric)?.lrc)?.lyric),
    );
    if (candidate !== null) out.push(candidate);
  }
  return out;
}
