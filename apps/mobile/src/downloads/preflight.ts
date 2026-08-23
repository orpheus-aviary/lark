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
// wording to keep in step with a gate it does not own. The ONE message this
// file writes itself is the favourites/collection refusal, because portable's
// names two HTTP routes (`/download/fetch-list`, `/download/batch`) that do not
// exist on a phone.
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
  parseSongInput,
  preflightSingle,
  resolveInput,
} from '@lark/core/portable';
import type { DownloadNamingMode, DownloadTaskData, ParsedItem } from '@lark/shared';
import type { ForegroundController } from './foreground';

/** A `ParsedItem` narrowed to the one kind this batch can submit. */
export type VideoItem = Extract<ParsedItem, { kind: 'video' }>;

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
  | { kind: 'refused'; message: string };

export interface RecogniseDeps {
  client: BilibiliClient;
  hasLlm(): boolean;
}

/** What the phone says instead of portable's two-HTTP-route sentence. */
const LIST_NOT_YET = '收藏夹和合集要等下一批。现在请粘贴单个视频的链接。';

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
    // returns a target instead of throwing, which is exactly what should happen
    // once N4e exists — this branch needs no edit then, only a keyword-shaped
    // submission path.
    try {
      await preflightSingle({ client: deps.client, hasLlm: deps.hasLlm() }, item, undefined);
      return { kind: 'refused', message: '关键词搜索要等设置页能配模型的那一批。' };
    } catch (err) {
      return { kind: 'refused', message: messageOf(err) };
    }
  }
  // favourites / collection / a short link that expanded into another one.
  if (item.kind === 'short_link') {
    return { kind: 'refused', message: `短链 ${item.url} 展开后仍是短链，拒绝继续跟随` };
  }
  return { kind: 'refused', message: LIST_NOT_YET };
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
    item: VideoItem;
    namingMode: DownloadNamingMode;
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
      url: input.item.url,
    });
  } finally {
    deps.foreground.settle();
  }
}

/** `exactOptionalPropertyTypes` forbids passing `{ signal: undefined }`. */
const signalOf = (options: { signal?: AbortSignal }): { signal: AbortSignal } | undefined =>
  options.signal === undefined ? undefined : { signal: options.signal };
