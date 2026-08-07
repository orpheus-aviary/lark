// Human-mode rendering (M6-6).
//
// Only `--json` output is a contract; this is domain text and may change. It
// still follows two rules, because a terminal is a UI: one record per line so
// `grep` and `awk` stay useful, and the id LAST so the eye lands on the name
// first — the id is what you copy, not what you read.

import type { PlaylistData, SongData } from '@lark/shared';

/** `名字 — 歌手  [标记]  id` */
export function songLine(song: SongData): string {
  const marks: string[] = [];
  if (song.pinned) marks.push('固定');
  // `has_file` is a live disk probe, absent when the backend did not enrich.
  if (song.has_file === false) marks.push('需要下载');
  const suffix = marks.length === 0 ? '' : `  [${marks.join(' ')}]`;
  const artist = song.artist === '' ? '' : ` — ${song.artist}`;
  return `${song.name}${artist}${suffix}  ${song.id}`;
}

export function playlistLine(playlist: PlaylistData): string {
  const count = playlist.song_count === undefined ? '' : `  (${playlist.song_count} 首)`;
  return `${playlist.name}${count}  ${playlist.id}`;
}

/** `键: 值` block, for single-record views. */
export function fieldLines(fields: Record<string, unknown>): string[] {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${String(value)}`);
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '未知';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
