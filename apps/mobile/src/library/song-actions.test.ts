import type { SongData } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { type SongActionId, songActions } from './song-actions';

const song = (patch: Partial<SongData> = {}): SongData =>
  ({ id: 's1', name: '半城烟沙', artist: '许嵩', pinned: false, ...patch }) as SongData;

const ids = (list: readonly { id: SongActionId }[]): SongActionId[] =>
  list.map((entry) => entry.id);

describe('songActions', () => {
  it('offers the whole library menu inside a playlist too', () => {
    // The regression this file exists for: the playlist sheet used to hold
    // 移出歌单 and nothing else.
    const inside = ids(songActions(song(), { inPlaylist: true }));
    for (const id of ids(songActions(song(), { inPlaylist: false }))) {
      expect(inside).toContain(id);
    }
  });

  it('adds 移出歌单 only inside a playlist, and never outside one', () => {
    expect(ids(songActions(song(), { inPlaylist: true }))).toContain('remove');
    expect(ids(songActions(song(), { inPlaylist: false }))).not.toContain('remove');
  });

  it('puts 移出歌单 before 删除', () => {
    const list = ids(songActions(song(), { inPlaylist: true }));
    expect(list.indexOf('remove')).toBeLessThan(list.indexOf('delete'));
  });

  it('makes 删除 the only red entry — 移出歌单 is reversible', () => {
    const red = songActions(song(), { inPlaylist: true }).filter((entry) => entry.danger === true);
    expect(ids(red)).toEqual(['delete']);
  });

  it('names the pin entry after what the tap does', () => {
    const label = (pinned: boolean) =>
      songActions(song({ pinned }), { inPlaylist: false }).find((entry) => entry.id === 'pin')
        ?.label;
    expect(label(false)).toBe('固定');
    expect(label(true)).toBe('取消固定');
  });
});
