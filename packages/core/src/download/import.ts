// Importing local mp3 files (M3-11, R22).
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
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { ImportResultData } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import type { LarkDatabase } from '../db/index.js';
import { songDirPath } from '../library/lyrics.js';
import { createFileBackedSongInTx } from '../library/songs.js';
import { isMp3Format, probeAudio } from './ffmpeg.js';
import { landSongFile, stagePaths } from './resolve.js';
import type { DownloadTimeouts } from './timeouts.js';

export interface ImportOptions {
  signal?: AbortSignal;
  timeouts?: DownloadTimeouts;
}

/**
 * Copy each file into the library. One bad file never fails the batch.
 *
 * The extension gate is a cheap filter, not the check: `probeAudio` decides
 * whether a `.mp3` is really an mp3, because an AAC renamed to `.mp3` would
 * otherwise enter the library and fail to play much later (fifth review ⑨).
 */
export async function importSongs(
  db: LarkDatabase,
  sqlite: BetterSqlite3.Database,
  filePaths: readonly string[],
  options: ImportOptions = {},
): Promise<ImportResultData> {
  const imported: { song_id: string; name: string }[] = [];
  const failed: { path: string; reason: string }[] = [];

  for (const filePath of filePaths) {
    options.signal?.throwIfAborted();
    try {
      imported.push(await importOne(db, sqlite, filePath, options));
    } catch (err) {
      failed.push({ path: filePath, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { imported, failed };
}

async function importOne(
  db: LarkDatabase,
  sqlite: BetterSqlite3.Database,
  filePath: string,
  options: ImportOptions,
): Promise<{ song_id: string; name: string }> {
  if (extname(filePath).toLowerCase() !== '.mp3') {
    throw new Error('只支持 .mp3 文件');
  }

  // The id comes first: the file lands at songs/<id>/, so it has to exist
  // before the copy, let alone before the row (R22).
  const songId = randomUUID();
  const taskId = randomUUID();
  const paths = stagePaths(songId, taskId);
  const name = basename(filePath, extname(filePath));

  await mkdir(songDirPath(songId), { recursive: true });
  try {
    // `.import.<uuid>.tmp` inside the destination directory: same volume, so
    // the rename below is atomic, and the recovery routine already knows to
    // delete this prefix.
    const staged = join(paths.dir, `.import.${taskId}.tmp`);
    await copyFile(filePath, staged);

    // ffprobe names the file it was given, which is the STAGED copy inside the
    // library — a path the user has never seen and cannot act on. The reason
    // has to talk about the file they picked; `failed[].path` already carries
    // it, so the staged name is replaced rather than appended.
    const probe = await probeAudio(staged, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
    }).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message.split(staged).join(filePath) : String(err);
      throw new Error(`无法读取音频：${detail}`);
    });
    if (!isMp3Format(probe.format)) {
      throw new Error(`文件扩展名是 .mp3，但实际格式是 ${probe.format || '未知'}`);
    }

    landSongFile(db, sqlite, {
      taskId,
      songId,
      stagedPath: staged,
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
