// Importing local audio files (M3-11, R22; the matrix is 0.3.0 §3.4).
//
// Two things the Go version got wrong, both fixed by construction:
//
//   - it inserted the row before the file was in place, so a failed copy left
//     a song that plays nothing. This goes through `landSongFile`, the same
//     protocol a download uses — one landing protocol, one recovery routine.
//   - it skipped failures silently, so importing 200 files and getting 180
//     told you nothing about the other 20. Every file reports an outcome.
//
// `file_origin: 'imported'` is the load-bearing field: imports are user assets
// that cannot be re-derived from a source key, so cache eviction must never
// touch them (R1/R26).
//
// From 0.3.0 the library holds one format, so importing is a conversion and
// the question is no longer "is this an mp3" but "what does this file have in
// it". The probe answers that, and `planAudioConversion` turns the answer into
// a copy, a rewrap or an encode. Everything this module adds on top is the
// part a decision table cannot express: which answers are a refusal, and what
// the user should be told about the ones that are not.

import { mkdir, rm } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  IMPORT_AUDIO_EXTENSIONS,
  type ImportFileErrorCode,
  type ImportResultData,
  isImportAudioCodec,
  isImportAudioExtension,
  isLosslessAudioCodec,
} from '@lark/shared';
import { FfmpegError } from '../errors.js';
import { createFileBackedSongInTx } from '../library/songs.js';
import type { MediaToolsProvider } from '../media-tools/registry.js';
import type { ResolvedMediaTools } from '../media-tools/resolve.js';
import { songDirPath } from '../paths.js';
import type { PortableDb } from '../portable/db.js';
import type { DownloadTimeouts } from '../portable/download/timeouts.js';
import { uuid } from '../portable/runtime/random.js';
import { type AudioProbe, probeAudio, processAudio } from './ffmpeg.js';
import { landSongFile, stagePaths } from './resolve.js';

export interface ImportOptions {
  signal?: AbortSignal;
  timeouts?: DownloadTimeouts;
}

/**
 * A file this import will not take, and the reason in both registers: prose
 * for the person, a code for the client.
 *
 * Deliberately NOT a `CodedError`: those are the classes that can reach a
 * response envelope or a task, and a rejected file reaches neither — it rides
 * inside a 200 as one entry of `failed[]`.
 */
export class ImportRejectedError extends Error {
  readonly errorCode: ImportFileErrorCode;
  constructor(errorCode: ImportFileErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ImportRejectedError';
    this.errorCode = errorCode;
  }
}

/**
 * Convert each file into the library. One bad file never fails the batch.
 *
 * The extension gate is a cheap filter, not the check: `probeAudio` decides
 * what a file really is, because an AAC renamed to `.mp3` would otherwise
 * enter the library and fail to play much later (fifth review ⑨). Since
 * 0.3.0 that cuts the other way too — a `.mp3` holding AAC-in-MP4 is a
 * perfectly good import, and is copied rather than re-encoded.
 *
 * "One bad file never fails the batch" has one exception, and it is the reason
 * `mediaTools` is acquired up front rather than per file: no ffprobe is not a
 * property of any file. Reporting it once per path as an import failure told
 * the user their twenty mp3s were bad when the truth was that this machine
 * cannot inspect any of them (M7-18).
 */
export async function importSongs(
  store: PortableDb,
  mediaTools: MediaToolsProvider,
  filePaths: readonly string[],
  options: ImportOptions = {},
): Promise<ImportResultData> {
  const imported: { song_id: string; name: string; warnings: string[] }[] = [];
  const failed: { path: string; reason: string; error_code: ImportFileErrorCode }[] = [];

  const tools = await mediaTools.acquire();

  for (const filePath of filePaths) {
    options.signal?.throwIfAborted();
    try {
      imported.push(await importOne(store, tools, filePath, options));
    } catch (err) {
      mediaTools.noteExecutionFailure(err);
      failed.push({
        path: filePath,
        reason: err instanceof Error ? err.message : String(err),
        error_code: importErrorCode(err),
      });
    }
  }
  return { imported, failed };
}

/**
 * Which refusal this was.
 *
 * Everything the module itself decided arrives typed; anything from ffprobe or
 * ffmpeg is the tools rejecting the file; anything else is a bug here and says
 * so rather than borrowing a format-shaped code.
 */
function importErrorCode(err: unknown): ImportFileErrorCode {
  if (err instanceof ImportRejectedError) return err.errorCode;
  if (err instanceof FfmpegError) return 'FFMPEG_FAILED';
  return 'INTERNAL_ERROR';
}

async function importOne(
  store: PortableDb,
  tools: ResolvedMediaTools,
  filePath: string,
  options: ImportOptions,
): Promise<{ song_id: string; name: string; warnings: string[] }> {
  const extension = extname(filePath);
  if (!isImportAudioExtension(extension)) {
    throw new ImportRejectedError(
      'IMPORT_UNSUPPORTED_FORMAT',
      `不支持的文件类型 ${extension === '' ? '（没有扩展名）' : extension}，支持：${IMPORT_AUDIO_EXTENSIONS.join('、')}`,
    );
  }

  // The id comes first: the file lands at songs/<id>/, so it has to exist
  // before the conversion, let alone before the row (R22).
  const songId = uuid();
  const taskId = uuid();
  const paths = stagePaths(songId, taskId);
  const name = basename(filePath, extension);
  const run = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
  };

  await mkdir(songDirPath(songId), { recursive: true });
  try {
    const probe = await probeAudio(tools.ffprobe.path, filePath, run).catch((err: unknown) => {
      throw new ImportRejectedError(
        'FFMPEG_FAILED',
        `无法读取音频：${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    });
    refuseUnimportable(probe);

    // The library holds one format (0.3.0), so importing is a conversion, not
    // a copy. The user's file is read where it lies and never modified; the
    // output goes straight to the task-scoped temp path inside the song's own
    // directory, which is the same volume as the final name — so the rename
    // below is still atomic, and one staging step disappeared with the copy.
    //
    // Cover art is dropped with everything else `-map` leaves behind. lark has
    // no artwork surface to lose it from.
    const mode = await processAudio(tools.ffmpeg.path, filePath, paths.transcoded, probe, run);

    landSongFile(store.drizzle, store.sqlite, {
      taskId,
      songId,
      stagedPath: paths.transcoded,
      mode: 'new',
      commit: () => {
        createFileBackedSongInTx(store, {
          id: songId,
          // Go parity: the filename is the song name and the artist is blank.
          // No ID3 read — see the plan's open questions.
          name,
          duration: probe.duration,
          file_origin: 'imported',
        });
      },
    });
    return { song_id: songId, name, warnings: describeLosses(probe, mode === 'transcode') };
  } catch (err) {
    // `landSongFile` cleans up after itself; this covers the steps before it.
    await rm(paths.dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * The three refusals, strictest first.
 *
 * Video before no-audio: a music video has both a real video track and a
 * perfectly good audio track, and "这是视频文件" is the useful half of that.
 * A file that trips neither can still be unimportable — the profile decodes a
 * deliberate subset (§4-a), and catching that here costs one comparison and
 * buys a sentence about the format instead of ffmpeg's "no decoder found".
 */
function refuseUnimportable(probe: AudioProbe): void {
  if (probe.has_real_video) {
    throw new ImportRejectedError(
      'IMPORT_HAS_VIDEO',
      '这是视频文件，lark 只导入音频文件（先自己抽出音轨再导入）',
    );
  }
  if (probe.selected_stream_global_index < 0) {
    throw new ImportRejectedError(
      'IMPORT_NO_AUDIO',
      `这个文件里没有音频流（容器 ${probe.container || '未知'}）`,
    );
  }
  if (!isImportAudioCodec(probe.codec)) {
    throw new ImportRejectedError(
      'IMPORT_UNSUPPORTED_FORMAT',
      `不支持的音频编码 ${probe.codec || '未知'}`,
    );
  }
}

/**
 * What the library's copy will not carry. Empty for the common case — an AAC
 * file rewrapped byte for byte loses nothing worth a sentence.
 */
function describeLosses(probe: AudioProbe, reEncoded: boolean): string[] {
  const warnings: string[] = [];
  if (probe.audio_stream_count > 1) {
    warnings.push(`文件有 ${probe.audio_stream_count} 条音轨，只导入了第 1 条`);
  }
  if (reEncoded) {
    warnings.push(
      isLosslessAudioCodec(probe.codec)
        ? `${probe.codec} 是无损格式，已转码为 AAC 192k（有损）`
        : `${probe.codec} 已重新编码为 AAC 192k，音质比原文件略低`,
    );
  }
  return warnings;
}
