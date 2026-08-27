// What one song's ⋮ menu offers (0.1.1 ⑩).
//
// THE BUG THIS REPLACES IS A LIST, WHICH IS WHY IT IS A FUNCTION. The 歌曲 tab
// built nine entries inline; the playlist detail built one — 移出歌单 — and
// nothing anywhere said the two were meant to be the same menu. A phone shows
// one of them at a time, so the difference was invisible everywhere except in
// the moment somebody went looking for 改歌名 inside a playlist and found a
// menu that could only remove the song.
//
// The context adds an entry, it never takes one away: everything a song can
// have done to it in the library can be done to it from inside a playlist, and
// a playlist adds the one action that only means something there.
//
// 移出歌单 SITS BEFORE 删除 AND IS NOT RED. That is the selection bar's rule
// (`ui/selection-bar.tsx` callers), applied here for the first time — the old
// single-song sheet painted 移出歌单 red, which put the reversible action and
// the permanent one in the same colour, one tap apart.

import type { SongData } from '@lark/shared';

export type SongActionId =
  | 'rename'
  | 'artist'
  | 'pin'
  | 'playlist'
  | 'copy-link'
  | 'open-link'
  | 'edit-link'
  | 'redownload'
  | 'remove'
  | 'delete';

export interface SongAction {
  id: SongActionId;
  label: string;
  /** Red, and only for what cannot be undone. Exactly one entry has it. */
  danger?: true;
}

export interface SongActionContext {
  /** The menu was opened inside a playlist, so 移出歌单 means something. */
  inPlaylist: boolean;
}

export function songActions(song: SongData, context: SongActionContext): readonly SongAction[] {
  return [
    { id: 'rename', label: '改歌名' },
    { id: 'artist', label: '改歌手' },
    // The label is the VERB, so it says what the tap will do rather than what
    // the song currently is.
    { id: 'pin', label: song.pinned ? '取消固定' : '固定' },
    { id: 'playlist', label: '添加到歌单' },
    // The link three (the desktop's M5-10 set). Copy takes whatever is stored;
    // open only takes http(s) (`library/links.ts`); changing it is the one
    // that can give a song a link it never had.
    { id: 'copy-link', label: '复制链接' },
    { id: 'open-link', label: '用 app 打开' },
    { id: 'edit-link', label: '更改链接' },
    // A FORCED refetch, which is a different thing from the row's tap: that
    // one fetches only what is missing and then plays it.
    { id: 'redownload', label: '重新下载' },
    ...(context.inPlaylist ? ([{ id: 'remove', label: '移出歌单' }] as const) : []),
    { id: 'delete', label: '删除', danger: true },
  ];
}
