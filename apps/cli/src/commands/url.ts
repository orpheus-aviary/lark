// `lark songs url get|set|recognize` (M6-12).
//
// The source triple — url, provider, key — is what makes a song
// re-downloadable, and it has its own command family because writing it is not
// a local edit: `set` hands the daemon a pasted link and the daemon goes
// online to normalise it into (provider, key). That is why only `get` works
// with `--direct`, and why the whole family is otherwise daemon-required.
//
// `recognize` is a PREVIEW and writes nothing (R6): it answers "this link is
// BV1xx page 3, titled …", and only `--save` stores it. The two steps are
// separate because the answer is what the user is deciding on — and because
// the key is unique across the library, so saving one can legitimately fail
// with `SOURCE_KEY_CONFLICT` naming the song that already owns it.

import type { RecognizeUrlData, SongData, UpdateSongRequest } from '@lark/shared';
import type { CommandContext } from '../context.js';
import { emitEnvelope } from '../lib/output.js';
import { fieldLines } from '../lib/render.js';
import { resolveSongRef } from '../lib/resolve-ref.js';

export async function runUrlGet(ctx: CommandContext, ref: string): Promise<void> {
  const id = await resolveSongRef(ctx.backend, ref);
  const envelope = await ctx.backend.getSong(id);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const song = envelope.data as SongData;
  for (const line of fieldLines({
    名字: song.name,
    链接: song.source_url ?? '（无）',
    来源: song.source_provider ?? '（无）',
    来源标识: song.source_key ?? '（无）',
  })) {
    ctx.streams.out(line);
  }
}

export async function runUrlSet(ctx: CommandContext, ref: string, url: string): Promise<void> {
  const id = await resolveSongRef(ctx.backend, ref);
  // A url-only patch is the "pasted a link" case: the daemon normalises it and
  // rewrites provider/key to match. An empty string clears all three — the
  // documented way to detach a song from its source.
  const patch: UpdateSongRequest = { source_url: url === '' ? null : url };
  const envelope = await ctx.backend.updateSong(id, patch);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const song = envelope.data as SongData;
  if (song.source_url === null) return ctx.streams.out(`✓ 已清除 ${song.name} 的链接`);
  ctx.streams.out(`✓ ${song.name} → ${song.source_url}`);
  ctx.streams.out(`来源标识：${song.source_key ?? '（这个链接识别不出来源标识，只能当外链保存）'}`);
}

export interface RecognizeOptions {
  save?: boolean;
}

export async function runUrlRecognize(
  ctx: CommandContext,
  ref: string,
  url: string | undefined,
  opts: RecognizeOptions,
): Promise<void> {
  const id = await resolveSongRef(ctx.backend, ref);
  const envelope = await ctx.backend.recognizeUrl(id, url);
  const data = envelope.data as RecognizeUrlData;

  if (opts.save !== true) {
    if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);
    for (const line of fieldLines({
      视频标题: data.video_title,
      链接: data.source_url,
      来源: data.source_provider,
      来源标识: data.source_key,
    })) {
      ctx.streams.out(line);
    }
    return ctx.streams.out('（只是预览，没有写入——加 --save 才保存）');
  }

  // Saving sends the triple EXPLICITLY, so the daemon stores what was just
  // shown rather than resolving the url a second time and possibly landing
  // somewhere else.
  const saved = await ctx.backend.updateSong(id, {
    source_url: data.source_url,
    source_provider: data.source_provider,
    source_key: data.source_key,
  });
  if (ctx.flags.json) return emitEnvelope(ctx.streams, saved);
  ctx.streams.out(`✓ 已保存：${data.video_title}`);
  ctx.streams.out(`来源标识：${data.source_key}`);
}
