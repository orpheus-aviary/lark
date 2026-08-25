// What a pasted URL becomes in the library, and what it would become (N4i-1).
//
// Two operations that belong together and used to live in the daemon's route
// file (`routes/songs.ts`, M3-11):
//
//   `resolveSourceUrl` turns a url into the stored TRIPLE — the four branches
//   below — and is what `PUT /songs/:id` calls for a url-only edit.
//   `recognizeSourceUrl` answers the same question WITHOUT writing, plus the
//   video's title, and is what the desktop's [自动识别] button calls.
//
// They moved here for the reason the preflight moved in N4a: the phone is
// about to need them (N4i's 更改链接), and a six-branch rule implemented twice
// is a rule that will eventually answer differently on a laptop and in a
// pocket — the M6 divergence, in a new place.
//
// THE FOUR BRANCHES, and why each exists:
//
//   nothing            → clear all three. Editing a link to empty is how a
//                        song stops claiming a source it never had.
//   a bilibili video   → the full triple, normalised ONLINE (`p` → `cid`), so
//                        what is stored is what a download can act on.
//   another bilibili   → keep the url, no identity: a favourites page or a
//     page (list/other)   collection is not ONE song's source.
//   another http(s)    → keep the url, no identity (R8). It cannot drive a
//                        download and is still worth keeping — you can open it.
//
// Anything else is refused. `javascript:` and `file:` reach that refusal
// through `parseSongInput`'s shape checks, which is where they should die.

import { InvalidSourceError } from '../errors.js';
import type { BiliRequestOptions, BilibiliClient } from './bilibili.js';
import { normalizeSourceOnline, parseSongInput, resolveInput } from './link.js';

/** The three columns a song's source lives in. All three move together. */
export interface SourceTriple {
  source_url: string | null;
  source_provider: string | null;
  source_key: string | null;
}

/**
 * A recognised video, and every field is non-null — unlike `SourceTriple`,
 * which has to be able to say "no identity". That is the whole difference
 * between the two operations: this one only ever answers about a video.
 */
export interface RecognizedSource {
  source_url: string;
  source_provider: string;
  source_key: string;
  video_title: string;
}

const NOTHING: SourceTriple = { source_url: null, source_provider: null, source_key: null };

/** A url we keep but cannot identify: openable, not downloadable (R8). */
const asPlainUrl = (url: string): SourceTriple => ({
  source_url: url,
  source_provider: null,
  source_key: null,
});

/**
 * The stored triple for a pasted url. Empty clears it; a bilibili video is
 * normalised online; anything else that is a url is kept without an identity.
 *
 * WHY THIS DOES NOT JUST CALL `resolveInput`, which does the same expansion
 * for the download path: every branch that KEEPS a url has to keep the
 * EXPANDED one, and `resolveInput` answers with a parsed item — by the time a
 * short link has turned out to lead somewhere unrecognisable, the target
 * string is gone. So the hop is taken here, and the target is judged exactly
 * as if it had been pasted. The budget is the same one: ONE hop, and a target
 * that is still a short link is refused rather than followed (the route this
 * came from recursed without a budget, which for a redirect loop meant
 * expanding forever).
 */
export async function resolveSourceUrl(
  client: BilibiliClient,
  url: string | null,
  options?: BiliRequestOptions,
): Promise<SourceTriple> {
  if (url === null || url === '') return NOTHING;
  return judge(client, url, options, 1);
}

async function judge(
  client: BilibiliClient,
  raw: string,
  options: BiliRequestOptions | undefined,
  hopsLeft: number,
): Promise<SourceTriple> {
  let parsed: ReturnType<typeof parseSongInput>;
  try {
    parsed = parseSongInput(raw);
  } catch (err) {
    // `parseSongInput` throws exactly one kind, and it means "I cannot read
    // this" — which for an http(s) string is not a refusal but the R8 branch.
    if (!(err instanceof InvalidSourceError)) throw err;
    if (/^https?:\/\//.test(raw)) return asPlainUrl(raw);
    throw err;
  }

  if (parsed.kind === 'short_link') {
    if (hopsLeft === 0) {
      throw new InvalidSourceError(`短链 ${raw} 展开后仍是短链，拒绝继续跟随`);
    }
    // A failed expansion propagates: the network being broken must not be
    // stored as though it were a considered answer about the link.
    const target = await client.expandShortLink(parsed.url, options);
    return judge(client, target, options, hopsLeft - 1);
  }

  // A favourites page, a collection, or free text that is not a url at all.
  if (parsed.kind !== 'video') return asPlainUrl(raw);

  const source = await normalizeSourceOnline(
    client,
    { bvid: parsed.bvid, page: parsed.page },
    options,
  );
  return {
    source_url: source.source_url,
    source_provider: source.source_provider,
    source_key: source.source_key,
  };
}

/**
 * The same recognition WITHOUT writing anything, plus the video's title.
 *
 * Stricter than `resolveSourceUrl` on purpose: this one exists to answer "what
 * IS this link", so a favourites page or a plain url is a refusal rather than
 * a shrug. Its caller is a preview button, and "kept as a url with no
 * identity" is not something to preview.
 */
export async function recognizeSourceUrl(
  client: BilibiliClient,
  url: string,
  options?: BiliRequestOptions,
): Promise<RecognizedSource> {
  const item = await resolveInput(client, url, options);
  if (item.kind !== 'video') throw new InvalidSourceError('只能识别 B 站视频链接');

  const source = await normalizeSourceOnline(client, { bvid: item.bvid, page: item.page }, options);
  const view = await client.view(item.bvid, options);
  return {
    source_url: source.source_url,
    source_provider: source.source_provider,
    source_key: source.source_key,
    video_title: view.title,
  };
}
