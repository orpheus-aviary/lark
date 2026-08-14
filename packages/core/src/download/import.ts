// Importing local audio files (M3-11, R22).
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

import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { ImportResultData } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import type { LarkDatabase } from '../db/index.js';
import { songDirPath } from '../library/lyrics.js';
import { createFileBackedSongInTx } from '../library/songs.js';
import type { MediaToolsProvider } from '../media-tools/registry.js';
import type { ResolvedMediaTools } from '../media-tools/resolve.js';
import { isMp3Format, probeAudio, processAudio } from './ffmpeg.js';
import { landSongFile, stagePaths } from './resolve.js';
import type { DownloadTimeouts } from './timeouts.js';

export interface ImportOptions {
  signal?: AbortSignal;
  timeouts?: DownloadTimeouts;
}

/**
 * Convert each file into the library. One bad file never fails the batch.
 *
 * The extension gate is a cheap filter, not the check: `probeAudio` decides
 * whether a `.mp3` is really an mp3, because an AAC renamed to `.mp3` would
 * otherwise enter the library and fail to play much later (fifth review ⑨).
 *
 * "One bad file never fails the batch" has one exception, and it is the reason
 * `mediaTools` is acquired up front rather than per file: no ffprobe is not a
 * property of any file. Reporting it once per path as an import failure told
 * the user their twenty mp3s were bad when the truth was that this machine
 * cannot inspect any of them (M7-18).
 */
export async function importSongs(
  db: LarkDatabase,
  sqlite: BetterSqlite3.Database,
  mediaTools: MediaToolsProvider,
  filePaths: readonly string[],
  options: ImportOptions = {},
): Promise<ImportResultData> {
  const imported: { song_id: string; name: string }[] = [];
  const failed: { path: string; reason: string }[] = [];

  const tools = await mediaTools.acquire();

  for (const filePath of filePaths) {
    options.signal?.throwIfAborted();
    try {
      imported.push(await importOne(db, sqlite, tools, filePath, options));
    } catch (err) {
      mediaTools.noteExecutionFailure(err);
      failed.push({ path: filePath, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { imported, failed };
}

async function importOne(
  db: LarkDatabase,
  sqlite: BetterSqlite3.Database,
  tools: ResolvedMediaTools,
  filePath: string,
  options: ImportOptions,
): Promise<{ song_id: string; name: string }> {
  if (extname(filePath).toLowerCase() !== '.mp3') {
    throw new Error('只支持 .mp3 文件');
  }

  // The id comes first: the file lands at songs/<id>/, so it has to exist
  // before the conversion, let alone before the row (R22).
  const songId = randomUUID();
  const taskId = randomUUID();
  const paths = stagePaths(songId, taskId);
  const name = basename(filePath, extname(filePath));
  const run = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
  };

  await mkdir(songDirPath(songId), { recursive: true });
  try {
    const probe = await probeAudio(tools.ffprobe.path, filePath, run).catch((err: unknown) => {
      throw new Error(`无法读取音频：${err instanceof Error ? err.message : String(err)}`);
    });
    if (!isMp3Format(probe.container)) {
      throw new Error(`文件扩展名是 .mp3，但实际格式是 ${probe.container || '未知'}`);
    }

    // The library holds one format (0.3.0), so importing is a conversion, not
    // a copy. The user's file is read where it lies and never modified; the
    // output goes straight to the task-scoped temp path inside the song's own
    // directory, which is the same volume as the final name — so the rename
    // below is still atomic, and one staging step disappeared with the copy.
    await processAudio(tools.ffmpeg.path, filePath, paths.transcoded, probe, run);

    landSongFile(db, sqlite, {
      taskId,
      songId,
      stagedPath: paths.transcoded,
      mode: 'new',
      commit: () => {
        createFileBackedSongInTx(db, {
          id: songId,
          // Go parity: the filename is the song name and the artist is blank.
          // No ID3 read — see the plan's open questions.
          name,
          duration: probe.duration,
          file_origin: 'imported',
        });
      },
    });
    return { song_id: songId, name };
  } catch (err) {
    // `landSongFile` cleans up after itself; this covers the steps before it.
    await rm(paths.dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
