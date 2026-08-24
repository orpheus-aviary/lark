// A paste with more than one line in it (N4h-1, §2.2).
//
// The desktop has had this since M4: `POST /download/parse` splits a pasted
// blob, `BatchSelectModal` shows the lines as a 「单项下载」 group, and every
// one of them goes to the CURRENT playlist. The phone had one box that answered
// about one link. This file is the missing half of that box, and the picker
// (`ui/list-picker.tsx`) is where its rows are shown — the same screen a
// favourites folder fills, with a different source (§0).
//
// TWO PHASES, AND THE SPLIT IS THE WHOLE DESIGN (decision b):
//
//   1. `readLines` — PURE. Every line through `parseLine`, no packet at all,
//      which is what lets the add page re-run it on every keystroke the way it
//      already re-runs the single-line recogniser (decision g of N4d).
//   2. `expandLines` — the short links, one hop each, at most three at a time,
//      run when the PICKER mounts. Doing this in the debounce instead would
//      mean N bilibili requests per keystroke: twelve short links and a
//      thoughtful typist is a rate-limit incident.
//
// WHAT IS NOT DROPPED IS THE POINT (decision d). A line nobody can download
// stays in the list with the reason on it. Silently keeping only the good ones
// leaves somebody counting rows and wondering what they pasted wrong.

import { type BilibiliClient, resolveInput } from '@lark/core/portable';
import type { DownloadBatchItemInput, DownloadNamingMode } from '@lark/shared';
import { DOWNLOAD_PARSE_LINES_MAX } from '@lark/shared';
import type { KeywordItem, VideoItem } from './preflight';
import { parseLine } from './preflight';
import type { PickRow } from './selection';

/** Short links expanded at once. Three is a guess with a reason (§7). */
const EXPAND_CONCURRENCY = 3;

/** One line, as `readLines` left it: settled offline, or waiting for a hop. */
export interface ParsedLine {
  /** 1-based, the way a person counts the lines they pasted. */
  index: number;
  raw: string;
  /** What it parsed to. `null` when the line was refused. */
  parsed: ReturnType<typeof parseLine>['parsed'];
  refusal: string | null;
}

export interface LineSummary {
  lines: readonly ParsedLine[];
  /** Non-empty lines seen, before any de-duplication. */
  total: number;
  /** Set when the whole paste is refused: more lines than the ceiling. */
  refusal: string | null;
  /** Lines that will become a download — videos plus short links. */
  ready: number;
  /** Lines that need a model before they can. */
  keywords: number;
  /** Lines nothing can be done with. */
  unusable: number;
}

/**
 * The identity two lines share when they are the same submission.
 *
 * A pasted block repeats itself constantly — the same link twice, a link and
 * its short form, the same query typed twice — and every duplicate that
 * survives to the picker is a row that promises a second download the engine
 * would merge away (`#mergeInto`). Short links are compared BEFORE the hop, so
 * a repeat costs no request at all; two different short links that resolve to
 * one video are caught after it, in `expandLines`.
 */
function identity(line: ParsedLine): string {
  const parsed = line.parsed;
  if (parsed === null) return `refused:${line.raw.trim()}`;
  if (parsed.kind === 'video') return `video:${parsed.bvid}:${parsed.page ?? 'auto'}`;
  if (parsed.kind === 'keyword') return `keyword:${parsed.query.trim().toLowerCase()}`;
  if (parsed.kind === 'short_link') return `short:${parsed.url}`;
  // A favourites folder or a collection pasted among the lines. It has its own
  // screen and cannot ride in a batch of videos, so it is refused here.
  return `list:${parsed.url}`;
}

/** 「收藏夹和合集要单独粘一条」 — the one refusal this file writes itself. */
const LIST_IN_A_PASTE = '收藏夹和合集要单独粘一条链接，才能挑里面的视频';

/**
 * Split a paste and settle every line offline.
 *
 * Blank lines are not lines: a paste from a notes app is full of them, and
 * counting them would put 「17 行」 in front of somebody who pasted six links.
 */
export function readLines(text: string): LineSummary {
  const raws = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  if (raws.length > DOWNLOAD_PARSE_LINES_MAX) {
    // The ceiling the desktop enforces, said before anything is parsed: this is
    // about the size of the request, not about what is in it.
    return {
      lines: [],
      total: raws.length,
      refusal: `一次最多 ${DOWNLOAD_PARSE_LINES_MAX} 行（当前 ${raws.length}），请分几次粘贴`,
      ready: 0,
      keywords: 0,
      unusable: 0,
    };
  }

  const seen = new Set<string>();
  const lines: ParsedLine[] = [];
  raws.forEach((raw, at) => {
    const parse = parseLine(raw);
    const line: ParsedLine = {
      index: at + 1,
      raw,
      parsed: parse.parsed,
      refusal: parse.refusal,
    };
    if (
      line.parsed !== null &&
      (line.parsed.kind === 'favorites' || line.parsed.kind === 'collection')
    ) {
      line.parsed = null;
      line.refusal = LIST_IN_A_PASTE;
    }
    const key = identity(line);
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(line);
  });

  return {
    lines,
    total: raws.length,
    refusal: null,
    ready: lines.filter(
      (line) => line.parsed?.kind === 'video' || line.parsed?.kind === 'short_link',
    ).length,
    keywords: lines.filter((line) => line.parsed?.kind === 'keyword').length,
    unusable: lines.filter((line) => line.parsed === null).length,
  };
}

/** A line as the picker shows it: something to tick, or a reason it cannot be. */
export interface LineRow extends PickRow {
  /** What to submit. `null` exactly when `reason` is not. */
  item: VideoItem | KeywordItem | null;
}

export interface ExpandLinesDeps {
  client: BilibiliClient;
  /** Whether a keyword line can be ticked at all (user's call, 2026-08-24). */
  hasLlm: boolean;
}

/**
 * Follow every short link, then hand back one row per line.
 *
 * De-duplicates a SECOND time, on the way out: two different short links can
 * resolve to the same video, and only the hop can tell. A line that loses that
 * race is dropped rather than shown as a refusal — it is not a problem with
 * what was pasted, it is the same song twice.
 */
export async function expandLines(
  deps: ExpandLinesDeps,
  lines: readonly ParsedLine[],
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<LineRow[]> {
  const hops = lines.filter((line) => line.parsed?.kind === 'short_link');
  const expanded = new Map<number, ParsedLine>();
  let done = 0;

  const follow = async (line: ParsedLine): Promise<void> => {
    const parsed = line.parsed;
    if (parsed?.kind !== 'short_link') return;
    try {
      const target = await resolveInput(deps.client, parsed.url, signalOf(options));
      expanded.set(line.index, { ...line, parsed: target, refusal: null });
    } catch (err) {
      expanded.set(line.index, {
        ...line,
        parsed: null,
        refusal: err instanceof Error ? err.message : String(err),
      });
    } finally {
      done += 1;
      options.onProgress?.(done, hops.length);
    }
  };

  // Three at a time (decision c): a dozen short links serially is a dozen
  // round trips, and unbounded parallelism against bilibili is a rate limit
  // waiting to happen. The queue is an index cursor rather than a chunked
  // `Promise.all`, so a slow hop does not hold up the two beside it.
  let next = 0;
  const workers = Array.from({ length: Math.min(EXPAND_CONCURRENCY, hops.length) }, async () => {
    while (next < hops.length) {
      const line = hops[next++];
      if (line !== undefined) await follow(line);
    }
  });
  await Promise.all(workers);

  const seen = new Set<string>();
  const rows: LineRow[] = [];
  for (const original of lines) {
    const line = expanded.get(original.index) ?? original;
    const key = identity(line);
    // Only settled lines can collide here; a refusal keeps its own row because
    // two lines that failed differently are two things to tell somebody.
    if (line.parsed !== null && seen.has(key)) continue;
    seen.add(key);
    rows.push(toRow(line, deps.hasLlm));
  }
  return rows;
}

function toRow(line: ParsedLine, hasLlm: boolean): LineRow {
  const key = `line-${line.index}`;
  const parsed = line.parsed;
  if (parsed === null) {
    return { key, label: line.raw, note: null, reason: line.refusal ?? '无法识别', item: null };
  }
  if (parsed.kind === 'video') {
    return {
      key,
      label: parsed.bvid + (parsed.page === null ? '' : ` · 第 ${parsed.page} P`),
      // The line as typed, when the label is not it: a share carries a title,
      // a short link carries nothing recognisable.
      note: line.raw === parsed.bvid ? null : line.raw,
      reason: null,
      item: parsed,
    };
  }
  if (parsed.kind === 'keyword') {
    return {
      key,
      label: `搜索「${parsed.query}」`,
      note: null,
      // Greyed out rather than refused outright (user's call, 2026-08-24): the
      // desktop rejects the WHOLE batch when a keyword rides in it with no
      // model, which on a phone would mean one stray line blocking eleven good
      // ones. `preflightBatch` still guards the submission itself.
      reason: hasLlm ? null : '需要模型：去「设置」填一个',
      item: hasLlm ? parsed : null,
    };
  }
  // A short link that expanded into another short link, or a list that slipped
  // past `readLines`. Both are refusals with their own words.
  return { key, label: line.raw, note: null, reason: LIST_IN_A_PASTE, item: null };
}

/**
 * Chosen rows, in wire shape.
 *
 * A keyword carries NO naming mode and a video must carry one — portable
 * refuses both mistakes (`assertNamingShape`), which is why this is one
 * function rather than a `map` at the call site.
 *
 * `title: null` on every video: a pasted link brings no list title with it, so
 * the name comes from the video itself (`original`) or from the model
 * (`clean`), exactly as a single pasted link behaves today.
 */
export function lineItems(
  rows: readonly LineRow[],
  mode: DownloadNamingMode,
): DownloadBatchItemInput[] {
  const items: DownloadBatchItemInput[] = [];
  for (const row of rows) {
    const item = row.item;
    if (item === null) continue;
    items.push(
      item.kind === 'keyword'
        ? { kind: 'keyword', query: item.query }
        : { kind: 'video', bvid: item.bvid, page: item.page, title: null, naming: mode },
    );
  }
  return items;
}

/** `exactOptionalPropertyTypes` forbids passing `{ signal: undefined }`. */
const signalOf = (options: { signal?: AbortSignal }): { signal: AbortSignal } | undefined =>
  options.signal === undefined ? undefined : { signal: options.signal };
