// `lark cache status` / `lark cache evict` (M6-4).
//
// Eviction deletes DOWNLOADED files only, never imported ones (R1: an import
// is a user asset with no way back), and never a file whose source cannot be
// confirmed re-downloadable — the probe is fail-closed (R26). The command
// reports both numbers, because "freed 0 bytes" and "skipped 12 songs it could
// not verify" are very different situations.

import type { CacheEvictResultData, CacheStatusData } from '@lark/shared';
import type { CommandContext } from '../context.js';
import { confirm } from '../lib/confirm.js';
import { emitEnvelope } from '../lib/output.js';

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export async function runCacheStatus(ctx: CommandContext): Promise<void> {
  const envelope = await ctx.backend.cacheStatus();
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const data = envelope.data as CacheStatusData;
  ctx.streams.out(`已用：${mib(data.used_bytes)}（${data.file_count} 个音频文件）`);
  ctx.streams.out(`上限：${data.limit_mb === 0 ? '不限' : `${data.limit_mb}MB`}`);
  ctx.streams.out(`可回收：${mib(data.eligible_bytes)}`);
  // Imported files, pinned songs and anything without a re-downloadable
  // source live here — the part of the library eviction will never touch.
  ctx.streams.out(`不可回收：${mib(data.unreclaimable_bytes)}`);
}

export async function runCacheEvict(ctx: CommandContext): Promise<void> {
  await confirm('按最近最少使用清理已下载的音频文件（导入的文件不会被删）？', {
    yes: ctx.flags.yes,
    json: ctx.flags.json,
  });

  const envelope = await ctx.backend.cacheEvict();
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const data = envelope.data as CacheEvictResultData;
  ctx.streams.out(`✓ 清理了 ${data.evicted_count} 首，释放 ${mib(data.freed_bytes)}`);
  if (data.skipped_unverified_count > 0) {
    ctx.streams.out(
      `跳过 ${data.skipped_unverified_count} 首（${mib(data.skipped_unverified_bytes)}）：来源无法确认还能重下，保守起见留着`,
    );
  }
  ctx.streams.out(
    `现在已用 ${mib(data.used_bytes)}，${data.limit_satisfied ? '已在上限内' : '仍超出上限'}`,
  );
}
