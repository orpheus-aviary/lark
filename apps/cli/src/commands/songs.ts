// `lark songs …` (M6-22).
//
// Every command here takes `<name|id>` and resolves it through the same rules
// (M6-10), and the destructive one asks before it acts. `edit` accepts LOCAL
// fields only — the source triple has its own command family (`songs url`,
// T4), because setting a URL means going online and re-identifying the song,
// which is not something `--name` should quietly share a code path with.

import type { SongData, SongSortField, SortOrder, UpdateSongRequest } from '@lark/shared';
import { SONG_SORT_FIELDS, SORT_ORDERS } from '@lark/shared';
import type { CommandContext } from '../context.js';
import { confirm } from '../lib/confirm.js';
import { usageError } from '../lib/errors.js';
import { emitEnvelope, successEnvelope } from '../lib/output.js';
import { fieldLines, formatDuration, songLine } from '../lib/render.js';
import { resolveSongRef } from '../lib/resolve-ref.js';

export interface ListOptions {
  search?: string;
  sort?: string;
  order?: string;
  limit?: string;
  offset?: string;
  /** Audit mode (D8): every song that shares a source key with another. */
  duplicates?: boolean;
}

/** One page of the whole-library scan `--duplicates` runs. */
const SCAN_PAGE = 1000;

/**
 * `--duplicates` is an audit of the WHOLE library, so it refuses the flags
 * that would narrow it: a pair whose other half is on page two, or does not
 * match the search, would silently look like a single song — which is the
 * opposite of what the flag is for.
 */
export function assertListShape(opts: ListOptions): void {
  if (opts.duplicates !== true) return;
  for (const [flag, value] of [
    ['--search', opts.search],
    ['--limit', opts.limit],
    ['--offset', opts.offset],
  ] as const) {
    if (value !== undefined) {
      throw usageError(`--duplicates 扫描整个曲库，不能和 ${flag} 一起用。`);
    }
  }
}

/** Validate here, so a typo is a usage error rather than a daemon 400. */
function listQuery(opts: ListOptions): {
  search?: string;
  sort?: SongSortField;
  order?: SortOrder;
  limit?: number;
  offset?: number;
} {
  const query: ReturnType<typeof listQuery> = {};
  if (opts.search !== undefined) query.search = opts.search;
  if (opts.sort !== undefined) {
    if (!(SONG_SORT_FIELDS as readonly string[]).includes(opts.sort)) {
      throw usageError(`--sort 只能是 ${SONG_SORT_FIELDS.join(' / ')}`);
    }
    query.sort = opts.sort as SongSortField;
  }
  if (opts.order !== undefined) {
    if (!(SORT_ORDERS as readonly string[]).includes(opts.order)) {
      throw usageError(`--order 只能是 ${SORT_ORDERS.join(' / ')}`);
    }
    query.order = opts.order as SortOrder;
  }
  const limit = positiveInt(opts.limit, '--limit', 1);
  if (limit !== undefined) query.limit = limit;
  const offset = positiveInt(opts.offset, '--offset', 0);
  if (offset !== undefined) query.offset = offset;
  return query;
}

function positiveInt(raw: string | undefined, flag: string, min: number): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    throw usageError(`${flag} 需要一个 ≥ ${min} 的整数，收到 ${JSON.stringify(raw)}`);
  }
  return value;
}

export async function runSongsList(ctx: CommandContext, opts: ListOptions): Promise<void> {
  if (opts.duplicates === true) return runSongsDuplicates(ctx, opts);

  const envelope = await ctx.backend.listSongs(listQuery(opts));
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const songs = envelope.data ?? [];
  if (songs.length === 0) return ctx.streams.out('（没有歌曲）');
  for (const song of songs) ctx.streams.out(songLine(song));
  if (envelope.total !== undefined && envelope.total > songs.length) {
    ctx.streams.out(`—— 共 ${envelope.total} 首，本页 ${songs.length} 首`);
  }
}

/**
 * Songs that share a `(provider, key)` with another song (D8, §3.4).
 *
 * Sync keeps both when two devices add the same video — a merge cannot be made
 * order independent, coexistence can — so this is how a user finds the pairs
 * to clean up. The scan pages through the whole library rather than trusting
 * one page: a duplicate whose other half is on page two is exactly the case
 * this command exists for.
 */
async function runSongsDuplicates(ctx: CommandContext, opts: ListOptions): Promise<void> {
  const all: SongData[] = [];
  const query = listQuery(opts);
  for (let offset = 0; ; offset += SCAN_PAGE) {
    const page = await ctx.backend.listSongs({ ...query, limit: SCAN_PAGE, offset });
    const songs = page.data ?? [];
    all.push(...songs);
    if (songs.length < SCAN_PAGE) break;
  }

  const byKey = new Map<string, SongData[]>();
  for (const song of all) {
    // No source is not a duplicate of every other song with no source.
    if (song.source_provider === null || song.source_key === null) continue;
    const key = `${song.source_provider}:${song.source_key}`;
    const group = byKey.get(key);
    if (group) group.push(song);
    else byKey.set(key, [song]);
  }
  const groups = [...byKey.entries()].filter(([, songs]) => songs.length > 1);

  if (ctx.flags.json) {
    // Flat, like every other list — the key is on each row, so a caller can
    // regroup without a second shape to learn.
    const flat = groups.flatMap(([, songs]) => songs);
    return emitEnvelope(ctx.streams, successEnvelope(flat, { total: flat.length }));
  }

  if (groups.length === 0) return ctx.streams.out('（没有来源重复的歌曲）');
  for (const [key, songs] of groups) {
    ctx.streams.out(`${key}  ——  ${songs.length} 首`);
    for (const song of songs) ctx.streams.out(`  ${songLine(song)}`);
  }
  ctx.streams.out(`—— 共 ${groups.length} 组重复，删掉多余的一首即可`);
}

export async function runSongsGet(ctx: CommandContext, ref: string): Promise<void> {
  const id = await resolveSongRef(ctx.backend, ref);
  const envelope = await ctx.backend.getSong(id);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const song = envelope.data as SongData;
  for (const line of fieldLines({
    id: song.id,
    名字: song.name,
    歌手: song.artist,
    时长: formatDuration(song.duration),
    固定: song.pinned ? '是' : '否',
    有文件: song.has_file === undefined ? undefined : song.has_file ? '是' : '否',
    来源: song.source_url ?? '（无）',
    来源标识: song.source_key ?? '（无）',
    歌词偏移: song.lyrics_offset,
  })) {
    ctx.streams.out(line);
  }
}

export interface EditOptions {
  name?: string;
  artist?: string;
  lyricsOffset?: string;
  duration?: string;
}

export async function runSongsEdit(
  ctx: CommandContext,
  ref: string,
  opts: EditOptions,
): Promise<void> {
  const patch: UpdateSongRequest = {};
  if (opts.name !== undefined) patch.name = opts.name;
  if (opts.artist !== undefined) patch.artist = opts.artist;
  if (opts.lyricsOffset !== undefined)
    patch.lyrics_offset = finite(opts.lyricsOffset, '--lyrics-offset');
  if (opts.duration !== undefined) {
    const duration = finite(opts.duration, '--duration');
    if (duration < 0) throw usageError('--duration 不能是负数');
    patch.duration = duration;
  }
  if (Object.keys(patch).length === 0) {
    throw usageError('至少要改一个字段：--name / --artist / --lyrics-offset / --duration');
  }

  const id = await resolveSongRef(ctx.backend, ref);
  const envelope = await ctx.backend.updateSong(id, patch);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);
  ctx.streams.out(`✓ 已更新 ${(envelope.data as SongData).name}`);
}

function finite(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw usageError(`${flag} 需要一个数字，收到 ${JSON.stringify(raw)}`);
  return value;
}

export async function runSongsDelete(ctx: CommandContext, refs: readonly string[]): Promise<void> {
  // Resolve EVERY reference before deleting anything: a run that deletes two
  // songs and then discovers the third name is ambiguous is worse than one
  // that refuses up front.
  const ids: { id: string; ref: string }[] = [];
  for (const ref of refs) ids.push({ id: await resolveSongRef(ctx.backend, ref), ref });

  await confirm(`删除 ${ids.length} 首歌（连同音频与歌词文件）？`, {
    yes: ctx.flags.yes,
    json: ctx.flags.json,
  });

  const deleted: string[] = [];
  for (const { id } of ids) {
    await ctx.backend.deleteSong(id);
    deleted.push(id);
  }

  if (ctx.flags.json) {
    return emitEnvelope(ctx.streams, successEnvelope({ deleted }, { total: deleted.length }));
  }
  ctx.streams.out(`✓ 已删除 ${deleted.length} 首`);
}

export async function runSongsPin(
  ctx: CommandContext,
  ref: string,
  pinned: boolean,
): Promise<void> {
  const id = await resolveSongRef(ctx.backend, ref);
  const envelope = await ctx.backend.pinSong(id, pinned);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);
  const song = envelope.data as SongData;
  ctx.streams.out(`✓ ${song.name} ${pinned ? '已固定（不会被缓存清理）' : '已取消固定'}`);
}
