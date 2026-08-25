// A song's link, as the two things a phone can do with it (N4i-2).
//
// 🔴 THE ALLOWLIST IS THE POINT OF THIS FILE. `Linking.openURL` hands a string
// to the system to act on, and `source_url` is a string that came from a user
// — pasted, edited, or (in N5) synced from another device. `intent://` on
// Android is a launcher for arbitrary components; `file://` reaches the
// filesystem; `javascript:` is only harmless because there is no browser here
// to run it in. So exactly two schemes go out, and everything else is refused
// with a sentence rather than passed along. It is R10 (the uuid gate before a
// path) in the shape links have.
//
// `parseSongInput` is deliberately NOT used for this: it answers "can lark
// download this", which is a different and much narrower question. A song
// whose link is a plain https page cannot be downloaded and can absolutely be
// opened — that is the R8 branch's whole reason to exist.

import type { SongData } from '@lark/shared';

/**
 * The url to hand the system, or `null` when there is nothing safe to hand it.
 *
 * `null` is what greys the menu item out, so the two reasons are deliberately
 * NOT distinguished here (no link at all / a link we will not open): the item
 * being dead is the message, and `refusalFor` supplies the sentence when
 * somebody taps it anyway.
 */
export function openableLink(song: Pick<SongData, 'source_url'>): string | null {
  const url = song.source_url;
  if (url === null || url === '') return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

/** Why a link that exists still will not open. `null` when it will. */
export function refusalFor(song: Pick<SongData, 'source_url'>): string | null {
  const url = song.source_url;
  if (url === null || url === '') return '这首歌没有链接';
  if (openableLink(song) !== null) return null;
  return '这个链接不是 http(s)，不会交给系统打开';
}

/** What 复制链接 puts on the clipboard: the link itself, nothing decorated. */
export function copyableLink(song: Pick<SongData, 'source_url'>): string | null {
  const url = song.source_url;
  // Copying is not opening: any stored string is copyable, because the point
  // of copying is to look at it or paste it somewhere else. Only "there is
  // nothing" is a refusal.
  return url === null || url === '' ? null : url;
}
