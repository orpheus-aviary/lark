// Before the first file (0.3.0 T2, master plan §3.2-5).
//
// Three questions, all asked once per pass and all asked BEFORE anything is
// touched: can this build convert audio at all, can it write where it needs
// to, and is there room. Failing any of them is `blocked_environment` with
// zero files touched — the alternative is finding out halfway through, with
// half a library converted and a disk that is now full.
//
// The space rule is `free ≥ max(500MB, largest single mp3 × 3)`: three copies
// because a conversion holds the source, the temp output and, for an asset,
// the backup at the same time. It is deliberately NOT a budget for the whole
// library — that estimate cannot be made honestly (an m4a is smaller than its
// mp3, sometimes much smaller) and a wrong one would refuse to start on a disk
// that had plenty of room.

import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { probeCapabilities } from '../media-tools/capabilities.js';
import type { ResolvedMediaTools } from '../media-tools/resolve.js';
import { larkDir, migrationBackupDir, songsDir } from '../paths.js';
import { largestMp3Bytes } from './converter.js';

/** The floor, for a library whose biggest song is small. */
export const MIN_FREE_BYTES = 500 * 1024 * 1024;
/** Source + temp output + backup, all alive at once. */
export const SIZE_HEADROOM = 3;

export type PreflightResult = { ok: true } | { ok: false; reason: string };

export interface PreflightOptions {
  sqlite: BetterSqlite3.Database;
  tools: ResolvedMediaTools;
  signal?: AbortSignal;
  /** Test seam: report the free bytes instead of asking the filesystem. */
  freeBytes?: () => Promise<number>;
}

export async function preflightAudioMigration(options: PreflightOptions): Promise<PreflightResult> {
  const capabilities = await probeCapabilities(options.tools, { signal: options.signal });
  if (capabilities.state !== 'ready') {
    return {
      ok: false,
      reason: `ffmpeg 不可用（${capabilities.state}）：${capabilities.detail ?? '能力清单不完整'}`,
    };
  }

  for (const dir of [songsDir(), migrationBackupDir()]) {
    const problem = checkWritable(dir);
    if (problem !== null) return { ok: false, reason: problem };
  }

  const free = await (options.freeBytes ?? defaultFreeBytes)();
  const needed = Math.max(MIN_FREE_BYTES, largestMp3Bytes(options.sqlite) * SIZE_HEADROOM);
  if (free < needed) {
    return {
      ok: false,
      reason: `磁盘剩余 ${mib(free)}，音频迁移需要 ${mib(needed)}——清理一些空间后重试`,
    };
  }
  return { ok: true };
}

/**
 * Create the directory and write a byte into it.
 *
 * `access(W_OK)` would answer for the directory's mode and not for the
 * filesystem: a read-only mount, a full disk and an immutable flag all pass it
 * and then fail on the first real write.
 */
function checkWritable(dir: string): string | null {
  const probe = join(dir, '.migration-write-probe');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, '');
    unlinkSync(probe);
    return null;
  } catch (err) {
    return `目录不可写：${dir}（${err instanceof Error ? err.message : String(err)}）`;
  }
}

async function defaultFreeBytes(): Promise<number> {
  const stats = await statfs(larkDir());
  return stats.bavail * stats.bsize;
}

function mib(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}
