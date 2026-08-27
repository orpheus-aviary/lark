// One song's ⋮ menu, for both lists that have one (0.1.1 ⑩).
//
// WHAT IT OFFERS is `library/song-actions.ts` — a list, tested where a list
// can be tested. What is here is the half that needs the screen: which entries
// this component can carry out on its own, and which ones open something else
// and therefore belong to whoever is showing the menu.
//
// THE SPLIT IS "DOES IT NEED ANOTHER SCREEN":
//
//   HERE — pin, the link three's two read-only halves, 重新下载. Each is one
//   write or one system call, each says its own outcome, and duplicating them
//   in two tabs is how the two menus drifted apart in the first place.
//
//   THE CALLER'S — 改歌名, 改歌手, 添加到歌单, 更改链接, 删除, 移出歌单. Every
//   one of them opens a prompt, a picker or a confirmation that the tab owns,
//   because the tab is what stays on screen behind it.
//
// 🔑 `onRemove` IS ALSO THE CONTEXT. Passing it means "this menu is inside a
// playlist", so there is no second `inPlaylist` prop that could disagree with
// it — an entry cannot be offered without something to carry it out.

import type { SongData } from '@lark/shared';
import * as Clipboard from 'expo-clipboard';
import { Linking, ToastAndroid } from 'react-native';
import { downloadRuntimeOnce } from '../downloads/engine';
import { copyableLink, openableLink, refusalFor } from '../library/links';
import { type SongActionId, songActions } from '../library/song-actions';
import { useLibrary } from './library-context';
import { Sheet, SheetAction } from './sheet';

/** The entries that open another screen. Their handlers are the caller's. */
export interface SongActionHandlers {
  rename: () => void;
  artist: () => void;
  playlist: () => void;
  editLink: () => void;
  delete: () => void;
}

export function SongActionsSheet({
  song,
  on,
  onRemove,
  onClose,
}: {
  song: SongData;
  on: SongActionHandlers;
  /** Present only inside a playlist — and that is what makes it one. */
  onRemove?: () => void;
  onClose: () => void;
}) {
  const { library, boot, changed } = useLibrary();

  /** 🔴 The allowlist is in `library/links.ts` — only http(s) reaches the system. */
  const openLink = (): void => {
    const url = openableLink(song);
    if (url === null) {
      ToastAndroid.show(refusalFor(song) ?? '打不开这个链接', ToastAndroid.SHORT);
      return;
    }
    void Linking.openURL(url).catch(() => {
      // Nothing on this phone claims http(s), or the system refused. Either
      // way it is worth a word: a menu item that does nothing reads as broken.
      ToastAndroid.show('没有应用能打开这个链接', ToastAndroid.SHORT);
    });
  };

  const copyLink = (): void => {
    const url = copyableLink(song);
    if (url === null) {
      ToastAndroid.show('这首歌没有链接', ToastAndroid.SHORT);
      return;
    }
    void Clipboard.setStringAsync(url);
    ToastAndroid.show('链接已复制', ToastAndroid.SHORT);
  };

  /** 重新下载 (criterion 49): the engine answers, and it is the one who speaks. */
  const redownload = (): void => {
    try {
      downloadRuntimeOnce(boot).engine.enqueueRedownload(song.id);
      ToastAndroid.show(`正在重新下载《${song.name}》`, ToastAndroid.SHORT);
    } catch (err) {
      // A full queue, or a row that went away while the sheet was open. Both
      // are the engine's sentences, and both are better than a silent tap.
      ToastAndroid.show(err instanceof Error ? err.message : '没能排上队', ToastAndroid.SHORT);
    }
  };

  const act = (id: SongActionId): void => {
    switch (id) {
      case 'pin':
        library.pinSong(song.id, !song.pinned);
        changed();
        onClose();
        return;
      case 'copy-link':
        copyLink();
        onClose();
        return;
      case 'open-link':
        openLink();
        onClose();
        return;
      case 'redownload':
        redownload();
        onClose();
        return;
      // The rest open something. They do NOT close this sheet — the screen
      // they open is drawn over it and closes both when it is done, which is
      // what keeps 取消 from dropping somebody back into the menu they left.
      case 'rename':
        on.rename();
        return;
      case 'artist':
        on.artist();
        return;
      case 'playlist':
        on.playlist();
        return;
      case 'edit-link':
        on.editLink();
        return;
      case 'remove':
        onRemove?.();
        return;
      case 'delete':
        on.delete();
        return;
    }
  };

  return (
    <Sheet title={song.name} onClose={onClose}>
      {songActions(song, { inPlaylist: onRemove !== undefined }).map((action) => (
        <SheetAction
          key={action.id}
          label={action.label}
          {...(action.danger === true ? { danger: true } : {})}
          onPress={() => act(action.id)}
        />
      ))}
    </Sheet>
  );
}
