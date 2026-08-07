// Native file dialogs live in main; the renderer reaches them over IPC
// (D20). The picker logic takes the dialog as a parameter so flow tests can
// inject a fake result (M4-14⑥ — CDP cannot drive native dialogs).

import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { sanitizeFileName } from '@lark/shared';
import type {
  BrowserWindow,
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue,
} from 'electron';
import { dialog, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc.js';
import { openExternalIfSafe } from './window.js';

export interface OpenDialogLike {
  showOpenDialog(win: BrowserWindow, options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
}

export interface SaveDialogLike {
  showSaveDialog(win: BrowserWindow, options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
}

export interface SaveExportInput {
  default_name: string;
  content: string;
}

/** Multi-select .mp3 picker. Cancel (or no selection) → empty array. */
export async function pickMp3(dialogLike: OpenDialogLike, win: BrowserWindow): Promise<string[]> {
  const result = await dialogLike.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'MP3', extensions: ['mp3'] }],
  });
  return result.canceled ? [] : result.filePaths;
}

/** Single .json picker for a playlist import file. Cancel → null. */
export async function pickJsonFile(
  dialogLike: OpenDialogLike,
  win: BrowserWindow,
): Promise<string | null> {
  const result = await dialogLike.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
}

// The rule moved into `@lark/shared` in M6: `lark playlist export -o <dir>`
// derives a filename the same way, and two copies would drift.
export { sanitizeFileName };

/**
 * Ask where to put an export and write it there.
 *
 * Written to a temporary file in the SAME directory and renamed into place:
 * the user usually picks a path that already holds an older export, and a
 * failed write must not be allowed to leave that file truncated.
 */
export async function saveExportFile(
  dialogLike: SaveDialogLike,
  win: BrowserWindow,
  input: SaveExportInput,
): Promise<boolean> {
  const result = await dialogLike.showSaveDialog(win, {
    defaultPath: sanitizeFileName(input.default_name),
  });
  if (result.canceled || result.filePath === undefined || result.filePath === '') return false;

  const target = result.filePath;
  const staged = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(staged, input.content, 'utf8');
    await rename(staged, target);
  } catch (err) {
    await unlink(staged).catch(() => {});
    throw err;
  }
  return true;
}

export function registerDialogIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC_CHANNELS.pickMp3, async () => {
    const win = getWindow();
    if (win === null) return [];
    return await pickMp3(dialog, win);
  });

  ipcMain.handle(IPC_CHANNELS.pickJsonFile, async () => {
    const win = getWindow();
    if (win === null) return null;
    return await pickJsonFile(dialog, win);
  });

  ipcMain.handle(IPC_CHANNELS.saveExportFile, async (_event, input: unknown) => {
    const win = getWindow();
    if (win === null) return false;
    if (typeof input !== 'object' || input === null) return false;
    const { default_name: name, content } = input as Partial<SaveExportInput>;
    if (typeof name !== 'string' || typeof content !== 'string') return false;
    return await saveExportFile(dialog, win, { default_name: name, content });
  });

  // Links come from song metadata — which a sync or an import may have
  // written — so the same R10 gate the window-open handler uses applies here.
  ipcMain.handle(IPC_CHANNELS.openExternal, (_event, url: unknown) =>
    typeof url === 'string' ? openExternalIfSafe(url) : false,
  );
}
