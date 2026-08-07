// `lark lyrics redownload|delete` (M6-22).
//
// The two halves sit on opposite sides of the daemon line, and that is not an
// accident: fetching lyrics is a queued task that searches three providers
// online, while deleting them is one `unlink` in the nest — the only lyrics
// operation `--direct` can serve.
//
// Deleting asks first, under the same rules as the other two destructive
// commands (`songs delete`, `playlist delete`): lyrics are not re-derivable
// from the audio, and a re-fetch may well come back with a different file.

import type { CommandContext } from '../context.js';
import { confirm } from '../lib/confirm.js';
import { emitEnvelope } from '../lib/output.js';
import { resolveSongRef } from '../lib/resolve-ref.js';
import type { WaitDeps } from '../lib/wait.js';
import { type WaitOption, followTask } from './download.js';

export async function runLyricsRedownload(
  ctx: CommandContext,
  ref: string,
  opts: WaitOption,
  deps: WaitDeps = {},
): Promise<void> {
  const id = await resolveSongRef(ctx.backend, ref);
  // One task, so it is followed by default — same as `download` and
  // `songs redownload`.
  await followTask(ctx, await ctx.backend.downloadLyrics(id), opts.wait !== false, deps);
}

export async function runLyricsDelete(ctx: CommandContext, ref: string): Promise<void> {
  const id = await resolveSongRef(ctx.backend, ref);
  await confirm('删除这首歌的歌词文件？', { yes: ctx.flags.yes, json: ctx.flags.json });

  const envelope = await ctx.backend.deleteLyrics(id);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);
  ctx.streams.out('✓ 已删除歌词');
}
