// Native file dialogs live in main; the renderer reaches them over IPC
// (D20). The picker logic takes the dialog as a parameter so flow tests can
// inject a fake result (M4-14⑥ — CDP cannot drive native dialogs).

import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import { dialog, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc.js';
import { openExternalIfSafe } from './window.js';

export interface OpenDialogLike {
  showOpenDialog(win: BrowserWindow, options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
}

/** Multi-select .mp3 picker. Cancel (or no selection) → empty array. */
export async function pickMp3(dialogLike: OpenDialogLike, win: BrowserWindow): Promise<string[]> {
  const result = await dialogLike.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'MP3', extensions: ['mp3'] }],
  });
  return result.canceled ? [] : result.filePaths;
}

export function registerDialogIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC_CHANNELS.pickMp3, async () => {
    const win = getWindow();
    if (win === null) return [];
    return await pickMp3(dialog, win);
  });

  // Links come from song metadata — which a sync or an import may have
  // written — so the same R10 gate the window-open handler uses applies here.
  ipcMain.handle(IPC_CHANNELS.openExternal, (_event, url: unknown) =>
    typeof url === 'string' ? openExternalIfSafe(url) : false,
  );
}
