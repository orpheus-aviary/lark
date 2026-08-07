// `lark playlist export` / `lark playlist import` (M6-13).
//
// Export writes atomically — temp file in the SAME directory, then rename —
// because the path a user gives is usually one that already holds an older
// export, and a failed write must not leave that file truncated. An existing
// target is confirmed first, under the same rules as every other destructive
// prompt.
//
// Import is TWO-PHASE, and the digest is the whole point (M5-13): the preview
// tells the user what would happen, the commit re-reads the file, and a
// mismatch is refused rather than imported against indices that have shifted
// under the answer the user gave.

import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import {
  type PlaylistExportData,
  type PlaylistImportPreviewData,
  sanitizeFileName,
} from '@lark/shared';
import type { ImportCommitRequest } from '../backend/types.js';
import type { CommandContext } from '../context.js';
import { confirm } from '../lib/confirm.js';
import { CliError, usageError } from '../lib/errors.js';
import { emitEnvelope, successEnvelope } from '../lib/output.js';
import { resolvePlaylistRef } from '../lib/resolve-ref.js';

/** Same cap the daemon enforces on an import file (M5-13). */
const IMPORT_FILE_MAX_BYTES = 20 * 1024 * 1024;

export interface ExportOptions {
  output?: string;
}

export async function runPlaylistExport(
  ctx: CommandContext,
  ref: string,
  opts: ExportOptions,
): Promise<void> {
  // Required rather than defaulted: writing a file into the current directory
  // because a flag was forgotten is a surprise, and this one has contents the
  // user may not expect to leave the nest.
  if (opts.output === undefined || opts.output === '') {
    throw usageError('导出需要 -o <路径>：给一个文件名，或一个已存在的目录。');
  }

  const id = await resolvePlaylistRef(ctx.backend, ref, { allowAll: true });
  const envelope = await ctx.backend.exportPlaylist(id);
  const data = envelope.data as PlaylistExportData;

  const target = exportTarget(opts.output, data);
  if (existsSync(target)) {
    await confirm(`${target} 已存在，覆盖？`, { yes: ctx.flags.yes, json: ctx.flags.json });
  }
  await writeAtomically(target, `${JSON.stringify(data, null, 2)}\n`);

  if (ctx.flags.json) {
    return emitEnvelope(
      ctx.streams,
      successEnvelope({ path: target, songs: data.songs.length, playlist: data.playlist.name }),
    );
  }
  ctx.streams.out(`✓ 已导出 ${data.songs.length} 首到 ${target}`);
}

/** A directory target gets the playlist's own name; a file target is used as-is. */
function exportTarget(output: string, data: PlaylistExportData): string {
  const absolute = isAbsolute(output) ? output : resolvePath(process.cwd(), output);
  if (existsSync(absolute) && statSync(absolute).isDirectory()) {
    return join(absolute, `${sanitizeFileName(data.playlist.name)}.lark-playlist.json`);
  }
  return absolute;
}

async function writeAtomically(target: string, contents: string): Promise<void> {
  const temp = join(dirname(target), `.${basename(target)}.tmp-${randomUUID()}`);
  await writeFile(temp, contents, { mode: 0o600 });
  await rename(temp, target);
}

export interface ImportOptions {
  to?: string;
  new?: string;
}

export async function runPlaylistImport(
  ctx: CommandContext,
  file: string,
  opts: ImportOptions,
): Promise<void> {
  if (opts.to !== undefined && opts.new !== undefined) {
    throw usageError('--to 和 --new 只能给一个：前者导入已有歌单，后者新建。');
  }

  const filePath = isAbsolute(file) ? file : resolvePath(process.cwd(), file);
  assertReadableSize(filePath);

  // Phase 1 — writes nothing.
  const previewEnvelope = await ctx.backend.importPreview(filePath);
  const preview = previewEnvelope.data as PlaylistImportPreviewData;

  const target = await importTarget(ctx, opts, preview);
  describePreview(ctx, preview, target);

  await confirm(`导入 ${preview.total} 首？`, { yes: ctx.flags.yes, json: ctx.flags.json });

  // Phase 2 — the digest is what makes the answer above still mean something.
  const commit: ImportCommitRequest = { file_path: filePath, digest: preview.digest, target };
  const envelope = await ctx.backend.importPlaylist(commit);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const result = envelope.data;
  ctx.streams.out(
    `✓ 导入完成：共 ${result?.total ?? 0} 首（新建 ${result?.created ?? 0}，复用 ${result?.reused ?? 0}，入单 ${result?.added ?? 0}）`,
  );
}

function assertReadableSize(filePath: string): void {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    throw new CliError('NOT_FOUND', `找不到文件 ${filePath}`, { path: filePath });
  }
  if (size > IMPORT_FILE_MAX_BYTES) {
    throw usageError(
      `导入文件 ${filePath} 有 ${(size / 1024 / 1024).toFixed(1)}MB，上限 ${IMPORT_FILE_MAX_BYTES / 1024 / 1024}MB。`,
    );
  }
}

async function importTarget(
  ctx: CommandContext,
  opts: ImportOptions,
  preview: PlaylistImportPreviewData,
): Promise<ImportCommitRequest['target']> {
  if (opts.new !== undefined) return { kind: 'new', name: opts.new };
  if (opts.to !== undefined) {
    // `--to all` means "into the library only": the songs land, no membership
    // is created (R24 — the virtual playlist has no rows to add to).
    if (opts.to === 'all') return { kind: 'all' };
    return { kind: 'playlist', playlist_id: await resolvePlaylistRef(ctx.backend, opts.to) };
  }
  // Default: a NEW playlist named after the file's own playlist. Merging into
  // something existing is a choice, not a default (M6-13).
  return { kind: 'new', name: preview.playlist_name };
}

function describePreview(
  ctx: CommandContext,
  preview: PlaylistImportPreviewData,
  target: ImportCommitRequest['target'],
): void {
  if (ctx.flags.json) return; // the envelope carries the numbers already

  const where =
    target.kind === 'all'
      ? '只入库，不加入歌单'
      : target.kind === 'new'
        ? `新建歌单「${target.name}」`
        : '加入已有歌单';
  ctx.streams.out(
    `文件包含 ${preview.total} 首：新建 ${preview.new_count}，复用 ${preview.reuse_count}`,
  );
  ctx.streams.out(`目标：${where}`);
  if (preview.suspects.length > 0) {
    // Suspects are imported AS NEW by default (R12) — a live cut and a studio
    // cut share a name. The CLI reports them; choosing to merge is the GUI's
    // job, and stays out of a one-shot command.
    ctx.streams.out(
      `注意：${preview.suspects.length} 首与库里同名同歌手，默认按新歌导入（要合并请用 GUI）`,
    );
  }
}
