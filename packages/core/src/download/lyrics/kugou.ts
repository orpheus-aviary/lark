// Kugou. Three hops, across three hosts: song search → lyric search by hash →
// lyric download.
//
// The middle hop needs the hash AND the duration in milliseconds. Without them
// it answers `candidates: []` even for a song it obviously has — which is the
// difference between "no lyrics" and "asked wrong".

import { type LyricsCandidate, toCandidate } from './lrc.js';
import {
  type LyricsQuery,
  type LyricsSourceOptions,
  MAX_CANDIDATES,
  UA,
  arr,
  decodeBase64,
  getJson,
  rec,
  resolveSourceOptions,
  searchTerm,
  str,
} from './shared.js';

export async function searchKugou(
  query: LyricsQuery,
  options: LyricsSourceOptions = {},
): Promise<LyricsCandidate[]> {
  const { fetchImpl, signal, origins } = resolveSourceOptions(options);
  const headers = { 'user-agent': UA };
  const params = new URLSearchParams({
    keyword: searchTerm(query),
    page: '1',
    pagesize: '5',
    showtype: '1',
  });

  const search = await getJson(fetchImpl, `${origins.kugouSearch}/api/v3/search/song?${params}`, {
    headers,
    signal,
  });

  const out: LyricsCandidate[] = [];
  for (const entry of arr(rec(rec(search)?.data)?.info)) {
    if (out.length >= MAX_CANDIDATES) break;
    const song = rec(entry);
    const hash = str(song?.hash);
    if (hash === '') continue;
    const songName = str(song?.songname);
    const singer = str(song?.singername);
    // Kugou's own duration when it has one, the audio's otherwise.
    const duration = typeof song?.duration === 'number' ? song.duration : query.duration;

    const krcParams = new URLSearchParams({
      ver: '1',
      man: 'yes',
      client: 'mobi',
      hash,
      keyword: `${songName} - ${singer}`,
      duration: String(Math.round(duration * 1000)),
    });
    const krc = await getJson(fetchImpl, `${origins.kugouKrc}/search?${krcParams}`, {
      headers,
      signal,
    }).catch(() => null);

    const best = rec(arr(rec(krc)?.candidates)[0]);
    if (best === null) continue;

    const dlParams = new URLSearchParams({
      ver: '1',
      client: 'pc',
      id: str(best.id),
      accesskey: str(best.accesskey),
      fmt: 'lrc',
      charset: 'utf8',
    });
    const download = await getJson(fetchImpl, `${origins.kugouLyrics}/download?${dlParams}`, {
      headers,
      signal,
    }).catch(() => null);

    const decoded = decodeBase64(str(rec(download)?.content));
    if (decoded === null) continue;
    const candidate = toCandidate('kugou', songName, singer, decoded);
    if (candidate !== null) out.push(candidate);
  }
  return out;
}
