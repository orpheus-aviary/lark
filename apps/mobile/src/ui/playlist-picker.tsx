// "Which playlist?" — one sheet, two callers (N4i-2, decision i).
//
// The row menu's 添加到歌单 and the selection bar's 加入歌单 ask the same
// question about a different number of songs, so they ask it with the same
// component. What differs is only the title, which is why that is the prop.
//
// IT OFFERS 新建歌单… , and the desktop's submenu does not. On a laptop the
// playlist list is on screen beside the song; here, not having it would mean
// leaving this screen, switching tabs, creating one, coming back and finding
// the song again — five steps to avoid one line of code.
//
// The virtual `all` is already gone: `library-context.tsx` filters it out for
// every screen, once (2026-08-24).

import type { PlaylistData } from '@lark/shared';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { useLibrary } from './library-context';
import { Prompt, Sheet, SheetAction } from './sheet';
import { C, S } from './theme';

export function PlaylistPicker({
  title,
  onPick,
  onClose,
}: {
  title: string;
  /** The chosen playlist. Creating one lands here too, once it exists. */
  onPick: (playlist: PlaylistData) => void;
  onClose: () => void;
}) {
  const { library, view, changed } = useLibrary();
  const [creating, setCreating] = useState(false);
  const playlists = view.playlists();

  if (creating) {
    return (
      <Prompt
        title="新建歌单"
        initial=""
        confirmLabel="创建并加入"
        onClose={onClose}
        onConfirm={(name) => {
          // `createPlaylist` answers with the row it made, so the caller gets
          // the same shape it gets from the list — no second lookup, and no
          // "which one did I just create" guess.
          const created = library.createPlaylist(name);
          changed();
          onPick(created);
        }}
      />
    );
  }

  return (
    <Sheet title={title} onClose={onClose}>
      <ScrollView style={styles.list}>
        {playlists.length === 0 ? (
          <Text style={styles.empty}>还没有歌单。</Text>
        ) : (
          playlists.map((playlist) => (
            <SheetAction
              key={playlist.id}
              label={`${playlist.name}（${playlist.song_count} 首）`}
              onPress={() => onPick(playlist)}
            />
          ))
        )}
      </ScrollView>
      <SheetAction label="新建歌单…" onPress={() => setCreating(true)} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // A cap, not a height: three playlists should not draw an empty half screen.
  list: { maxHeight: 320 },
  empty: { color: C.faint, fontSize: 13, paddingVertical: S.gap },
});
