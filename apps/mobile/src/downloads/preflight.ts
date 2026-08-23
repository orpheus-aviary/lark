// The add page's two questions, answered by portable (N4d-2).
//
// "What did they paste?" and "what happens when they tap 下载?" — both already
// have implementations in `@lark/core/portable`, extracted in N4a precisely so
// that a second front end would not write them a second time. This file is the
// shell: it decides WHEN to call them and turns what they throw into something
// a screen can render.
//
// IT DOES NOT REWRITE PORTABLE'S SENTENCES (§1.1). The three LLM gates already
// say the right thing — 「关键词搜索需要配置 LLM；或者直接粘贴 B 站视频链接」,
// 「这个视频有 N 个分P…」 — and a phone that paraphrased them would be a second
// wording to keep in step with a gate it does not own.
//
// THE ONE SENTENCE THIS FILE USED TO WRITE ITSELF IS GONE (N4f-1). 「收藏夹和
// 合集要等下一批」 was a placeholder in front of a door that portable had
// already opened — the same shape N4e-2 found in front of keyword search, where
// the shell read "the gate did not throw" as a refusal and nothing was watching
// that path (§1.2). A list link now recognises as a list, and `expandList` /
// `submitListBatch` below are where it goes.
//
// RECOGNITION IS OFFLINE EXCEPT FOR SHORT LINKS (decision g). `parseSongInput`
// is a pure function: a bvid, a video URL and a line of gibberish are all
// settled without a packet. Only `b23.tv` needs a hop, which is why 「正在解析」
// is a state that appears on short links and not on every keystroke — and why
// `onResolving` fires HERE, synchronously, at the moment the hop starts
// (criterion 21).

import {
  type BilibiliClient,
  type DownloadTarget,
  type ParsedInput,
  fetchList,
  parseSongInput,
  preflightBatch,
  preflightSingle,
  resolveInput,
} from '@lark/core/portable';
import type {
  DownloadBatchData,
  DownloadBatchGroupInput,
  DownloadNamingMode,
  DownloadTaskData,
  FetchListData,
  FetchListRequest,
  ParsedItem,
} from '@lark/shared';
import type { ForegroundController } from './foreground';
import { type ListVideo, overItemLimit } from './selection';

/** The two `ParsedItem` kinds a phone can submit on its own. */
export type VideoItem = Extract<ParsedItem, { kind: 'video' }>;
export type KeywordItem = Extract<ParsedItem, { kind: 'keyword' }>;
/** And the two it has to expand first (N4f). */
export type ListItem = Extract<ParsedItem, { kind: 'favorites' | 'collection' }>;

/**
 * What the page knows about what is in the box.
 *
 * `refused` carries a sentence and nothing else on purpose: every refusal here
 * is already a full explanation of what lark supports, and a code would only
 * tempt a screen into re-wording one of them.
 */
export type Recognition =
  | { kind: 'empty' }
  | {
      kind: 'video';
      item: VideoItem;
      /** The `b23.tv` link this came from, when a hop was needed. */
      expandedFrom: string | null;
      /** True when the link was found INSIDE a longer line (see `findSource`). */
      extracted: boolean;
    }
  | {
      /**
       * A song by name (N4e-2). Not a video: there is nothing to name it after
       * yet, so this carries no title, no page and no naming mode — the model
       * picks the video and the name, which is why the gate in front of it is
       * the LLM one.
       */
      kind: 'keyword';
      item: KeywordItem;
    }
  | {
      /**
       * A favourites folder or a collection (N4f-1).
       *
       * RECOGNISED OFFLINE like everything else on this page: `parseSongInput`
       * reads the ids straight out of the URL, and the expansion — up to 200
       * sequential page requests — waits until the picker mounts (§2.2). The
       * desktop draws the same line: its dialog fetches on mount and its paste
       * box sends nothing while somebody types. Recognising and expanding in
       * one step would put a bilibili request behind every keystroke, because
       * this page re-recognises on every debounce (decision g).
       */
      kind: 'list';
      item: ListItem;
    }
  | { kind: 'refused'; message: string };

export interface RecogniseDeps {
  client: BilibiliClient;
  hasLlm(): boolean;
}

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : `无法识别这段输入：${String(err)}`;

/**
 * The link inside a line that also carries something else.
 *
 * MEASURED (N0b-4c): what the bilibili app puts on the clipboard and into a
 * share is 「标题 + 空格 + 短链」 —
 * `莫愁乡--（OfficialMusicVideo）亚细亚旷世奇才 https://b23.tv/cfzPKZX` — with
 * `EXTRA_TITLE` empty. Handed to `parseSongInput` whole, that is free text, so
 * the single most likely input on a phone would be refused as "keyword search
 * needs an LLM" and 「正在解析」 would be unreachable from a real share
 * (criteria 21 and 22). The desktop never had to care: its paste box is fed by
 * a mouse, and it has a model to fall back on.
 *
 * ONLY REACHED WHEN THE WHOLE LINE READS AS FREE TEXT, so a bare link — of any
 * kind, bilibili or not — still gets its own verdict first. Each candidate goes
 * through `parseSongInput` unchanged, which means every structural check
 * (scheme, credentials, port, host) still runs on it: this picks WHICH string
 * to ask about, it does not decide anything.
 *
 * The first usable token wins. A line with two links is ambiguous and there is
 * no honest way to guess; taking the first is at least the one a person reads
 * first. A token that parsed as a URL and was REFUSED is remembered, because
 * "youtube 不是 B 站链接" explains more than "关键词搜索需要配置 LLM" does.
 */
function findSource(text: string): { source: string | null; refusal: string | null } {
  let refusal: string | null = null;
  for (const token of text.split(/\s+/)) {
    if (token === '') continue;
    try {
      if (parseSongInput(token).kind !== 'keyword') return { source: token, refusal: null };
    } catch (err) {
      refusal ??= messageOf(err);
    }
  }
  return { source: null, refusal };
}

/**
 * Recognise one line of input, with at most one short-link hop.
 *
 * `onResolving` is called synchronously before the hop and not at all without
 * one — it is the page's cue for 「正在解析」, and moving the expansion to
 * submit time is exactly what makes that state disappear (criterion 21's
 * reverse test).
 */
export async function recognise(
  deps: RecogniseDeps,
  raw: string,
  options: { signal?: AbortSignal; onResolving?: () => void } = {},
): Promise<Recognition> {
  const text = raw.trim();
  if (text === '') return { kind: 'empty' };

  let source = text;
  let extracted = false;
  let offline: ParsedInput;
  try {
    offline = parseSongInput(source);
  } catch (err) {
    // `parseSongInput` throws the sentence that says what IS supported — for a
    // youtube link, for a bangumi page, for gibberish. It is already the answer
    // criterion 25 asks for.
    return { kind: 'refused', message: messageOf(err) };
  }

  if (offline.kind === 'keyword') {
    const found = findSource(text);
    if (found.source === null) {
      // Nothing link-shaped in there. A URL we understood and refused explains
      // more than the keyword gate does.
      if (found.refusal !== null) return { kind: 'refused', message: found.refusal };
    } else {
      source = found.source;
      extracted = true;
      offline = parseSongInput(source);
    }
  }

  if (offline.kind === 'short_link') {
    options.onResolving?.();
    try {
      const expanded = await resolveInput(deps.client, source, signalOf(options));
      return settle(deps, expanded, source, extracted);
    } catch (err) {
      return { kind: 'refused', message: messageOf(err) };
    }
  }

  return settle(deps, offline, null, extracted);
}

/** The four kinds a settled parse can be, and what this batch does with each. */
async function settle(
  deps: RecogniseDeps,
  item: ParsedInput,
  expandedFrom: string | null,
  extracted: boolean,
): Promise<Recognition> {
  if (item.kind === 'video') return { kind: 'video', item, expandedFrom, extracted };
  if (item.kind === 'keyword') {
    // Portable's own gate and portable's own words. With a model configured it
    // RETURNS a target instead of throwing — and until N4e-2 the code read that
    // success as a refusal and answered with a placeholder about a batch that
    // had not happened yet. The gate opening is the whole point; what it needs
    // is somewhere to go.
    //
    // The target it hands back is discarded on purpose: a keyword preflight
    // touches no network (the search happens later, inside the task), so asking
    // twice costs nothing, and asking HERE keeps the gate and its sentence in
    // exactly one place.
    try {
      await preflightSingle({ client: deps.client, hasLlm: deps.hasLlm() }, item, undefined);
      return { kind: 'keyword', item };
    } catch (err) {
      return { kind: 'refused', message: messageOf(err) };
    }
  }
  if (item.kind === 'short_link') {
    return { kind: 'refused', message: `短链 ${item.url} 展开后仍是短链，拒绝继续跟随` };
  }
  // A favourites folder or a collection. Nothing is fetched here — the picker
  // does that when it mounts (§2.2).
  return { kind: 'list', item };
}

export interface SubmitDeps extends RecogniseDeps {
  foreground: ForegroundController;
  engine: { enqueueDownload(input: EnqueueInput): DownloadTaskData };
}

interface EnqueueInput {
  target: DownloadTarget;
  playlistIds?: readonly string[];
  url?: string;
}

/**
 * The gesture, from tap to queued task (§1.5).
 *
 * `arm()` FIRST, before any packet: the tap is the only moment Android reliably
 * lets a foreground service start, and N4c-3 measured what happens when it is
 * left until the enqueue — the request is neither refused nor honoured, it is
 * held until the app comes back to the screen, which is the whole download
 * unprotected. `settle()` in a `finally` for the other edge: a preflight that
 * threw enqueued nothing, and a service left `arming` over an empty queue would
 * hold this process up for good.
 *
 * The item comes from `recognise`, already expanded — so this does NOT hop
 * again. `preflightSingle` may still go to the network (the page list, for the
 * multi-part gate), which is the reason `arm()` brackets it rather than
 * bracketing only the enqueue.
 */
export async function submitDownload(
  deps: SubmitDeps,
  input: {
    item: VideoItem | KeywordItem;
    /**
     * `undefined` for a keyword, and that is a rule rather than an omission:
     * a keyword has no title to keep or clean, so portable refuses a video
     * without a mode AND a keyword with one (`assertNamingShape`).
     */
    namingMode: DownloadNamingMode | undefined;
    playlistIds: readonly string[];
    signal?: AbortSignal;
  },
): Promise<DownloadTaskData> {
  await deps.foreground.arm();
  try {
    const target = await preflightSingle(
      { client: deps.client, hasLlm: deps.hasLlm() },
      input.item,
      input.namingMode,
      signalOf(input),
    );
    return deps.engine.enqueueDownload({
      target,
      ...(input.playlistIds.length === 0 ? {} : { playlistIds: input.playlistIds }),
      // A keyword has no URL to remember: the list shows the query instead,
      // which is what the person actually typed.
      ...(input.item.kind === 'video' ? { url: input.item.url } : {}),
    });
  } finally {
    deps.foreground.settle();
  }
}

/** 收藏夹 / 合集 — what a page calls the thing it is about to expand. */
export const listLabel = (item: ListItem): string =>
  item.kind === 'favorites' ? '收藏夹' : '合集';

const listRequest = (item: ListItem): FetchListRequest =>
  item.kind === 'favorites'
    ? { type: 'favorites', media_id: item.media_id }
    : { type: 'collection', mid: item.mid, season_id: item.season_id };

/**
 * Walk a favourites folder or a collection into its videos (§1.3).
 *
 * A shell over `fetchList` and deliberately nothing more — in particular it
 * DOES NOT TOUCH `error`. Partial success is the norm there: a folder whose
 * page 7 failed still hands back six pages of videos plus the reason it
 * stopped, and truncation at the 200-page / 5000-item guardrails comes through
 * that same field with the limits named in it. Rewriting or swallowing that
 * sentence is how a truncated list gets shown as the whole thing (criterion 32).
 *
 * IT THROWS ONLY WHEN NOTHING CAME BACK AT ALL. That is not partial success —
 * it is "this link does not work", and the picker answers it by closing with
 * portable's own words rather than showing an empty list with a warning on top.
 *
 * NOT ARMED (§1.7). Expanding is foreground work with somebody watching the
 * screen; `arm()` buys the right to keep going once the screen is off, which is
 * what a download needs and this does not. It can still take tens of seconds,
 * so the caller passes a signal and aborts it on leaving the page.
 */
export function expandList(
  deps: { client: BilibiliClient },
  item: ListItem,
  options: { signal?: AbortSignal } = {},
): Promise<FetchListData> {
  return fetchList(deps.client, listRequest(item), signalOf(options));
}

export interface SubmitBatchDeps extends RecogniseDeps {
  foreground: ForegroundController;
  engine: {
    enqueueBatches(groups: readonly DownloadBatchGroupInput[]): readonly DownloadBatchData[];
  };
}

/**
 * The picker's 提交, as one group (§2.3, decision i).
 *
 * ONE LIST IS ONE GROUP IS ONE `enqueueBatches` CALL, and that call is
 * all-or-nothing at ADMISSION: it validates every target, checks every item for
 * a naming conflict, checks capacity, and only then creates the playlist and
 * registers the tasks. So a refusal from here means no playlist exists and not
 * one task was queued — which is the half of criterion 33 a screen must not
 * blur into the other half. Items failing later, one at a time, are the task
 * list's business and leave the batch's own count alone.
 *
 * THE ORDER DIFFERS FROM `submitDownload`, on purpose. There, `arm()` comes
 * first because the preflight it brackets may go to the network for a page
 * list, and the tap is the only moment Android reliably lets a service start
 * (N4c-3). Here everything before the enqueue is synchronous and touches
 * nothing: the item ceiling is arithmetic and `preflightBatch` is the LLM gate
 * answered with no request at all. Refusing before arming means a submission
 * that never happens also never starts a notification.
 *
 * The ceiling is checked HERE and not only on the button (decision d). The
 * button being disabled is what a person sees; this is what makes it true —
 * `enqueueBatches` has no item limit of its own, only a queue capacity that
 * happens to sit at the same number today.
 */
export async function submitListBatch(
  deps: SubmitBatchDeps,
  input: {
    /** The playlist to create. Blank is the engine's refusal to make, not ours. */
    name: string;
    videos: readonly ListVideo[];
    /** One mode for the whole group (decision c). */
    namingMode: DownloadNamingMode;
  },
): Promise<void> {
  // The daemon route refuses an empty group too ('each group needs a non-empty
  // items array'); on a phone the button is disabled instead, and this is what
  // keeps that from being the only thing that is true. An empty submission
  // would otherwise create an empty playlist and queue nothing.
  if (input.videos.length === 0) throw new Error('还没有勾选任何视频');
  const refusal = overItemLimit(input.videos.length);
  if (refusal !== null) throw new Error(refusal);

  const groups: readonly DownloadBatchGroupInput[] = [
    {
      // Always a new playlist, never an existing one: the desktop's dialog has
      // no other option either (decision f). The name defaults to the list's
      // own title and the picker lets it be edited.
      target: { kind: 'new', name: input.name },
      items: input.videos.map((video) => ({
        kind: 'video',
        bvid: video.bvid,
        page: null,
        // The list's title travels either way — `original` stores it as it
        // stands, `clean` is what the model reads a song name OUT of. Sending
        // null on the clean branch would hand the model the video's own title
        // instead, which is what once made the desktop's checkbox a no-op.
        title: video.title,
        naming: input.namingMode,
      })),
    },
  ];

  preflightBatch({ client: deps.client, hasLlm: deps.hasLlm() }, groups);

  await deps.foreground.arm();
  try {
    deps.engine.enqueueBatches(groups);
  } finally {
    deps.foreground.settle();
  }
}

/** `exactOptionalPropertyTypes` forbids passing `{ signal: undefined }`. */
const signalOf = (options: { signal?: AbortSignal }): { signal: AbortSignal } | undefined =>
  options.signal === undefined ? undefined : { signal: options.signal };
