// Native file dialogs live in main; the renderer reaches them over IPC
// (D20). The picker logic takes the dialog as a parameter so flow tests can
// inject a fake result (M4-14⑥ — CDP cannot drive native dialogs).

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationBackupDir } from '@lark/core/paths';
import { IMPORT_AUDIO_EXTENSIONS, sanitizeFileName } from '@lark/shared';
import type {
  BrowserWindow,
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue,
} from 'electron';
import { dialog, ipcMain, shell } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc.js';
import { readLegalDocument } from './legal-ipc.js';
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

/**
 * Multi-select audio picker. Cancel (or no selection) → empty array.
 *
 * The filter is `IMPORT_AUDIO_EXTENSIONS` itself rather than a list kept in
 * step with it: the picker and the import gate disagreeing means a file the
 * dialog offers and the daemon then refuses.
 */
export async function pickAudio(dialogLike: OpenDialogLike, win: BrowserWindow): Promise<string[]> {
  const result = await dialogLike.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '音频文件', extensions: [...IMPORT_AUDIO_EXTENSIONS] }],
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
  ipcMain.handle(IPC_CHANNELS.pickAudio, async () => {
    const win = getWindow();
    if (win === null) return [];
    return await pickAudio(dialog, win);
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

  // Closed set, checked here rather than trusted: the renderer picks a
  // DOCUMENT, and anything else answers null instead of touching the disk.
  ipcMain.handle(IPC_CHANNELS.readLegal, async (_event, document: unknown) => {
    if (document !== 'license' && document !== 'notices') return null;
    return await readLegalDocument(document, {
      resourcesPath: process.resourcesPath,
      devRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'),
    });
  });

  // Takes no argument, on purpose (§4-m): main derives the ONE directory this
  // may reveal. An IPC that opened a path the renderer named would be a
  // "launch anything" primitive with a friendly name.
  ipcMain.handle(IPC_CHANNELS.openMigrationBackup, () => openMigrationBackup());
}

/**
 * Reveal the migration backups.
 *
 * `false` when the directory is not there, which is the honest answer after a
 * clear — `shell.openPath` on a missing path opens a file-manager error the
 * user cannot act on.
 */
export async function openMigrationBackup(
  shellLike: { openPath(path: string): Promise<string> } = shell,
): Promise<boolean> {
  const dir = migrationBackupDir();
  if (!existsSync(dir)) return false;
  const error = await shellLike.openPath(dir);
  return error === '';
}
