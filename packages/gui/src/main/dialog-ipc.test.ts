// The export half of the file dialogs (M5-12). The picker is trivial; what is
// worth testing is the write, because the path the user picks is usually an
// EXISTING export — so a failed write must leave that file exactly as it was.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// dialog-ipc reaches for electron at module scope (dialog / ipcMain, plus
// window.ts's `app.on('before-quit')`); nothing here goes through the real ones.
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  dialog: {},
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

const { pickJsonFile, sanitizeFileName, saveExportFile } = await import('./dialog-ipc.js');

const WIN = {} as BrowserWindow;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-export-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const saver = (filePath: string | undefined) => ({
  showSaveDialog: () =>
    Promise.resolve(
      filePath === undefined ? { canceled: true, filePath: '' } : { canceled: false, filePath },
    ),
});

const opener = (filePaths: string[], canceled = false) => ({
  showOpenDialog: () => Promise.resolve({ canceled, filePaths }),
});

describe('sanitizeFileName', () => {
  it('keeps a readable name and drops what a path cannot carry', () => {
    expect(sanitizeFileName('健身 歌单.lark-playlist.json')).toBe('健身 歌单.lark-playlist.json');
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
    expect(sanitizeFileName('..hidden')).toBe('hidden');
  });

  it('falls back to a name rather than an empty one', () => {
    expect(sanitizeFileName('///')).toBe('playlist');
    expect(sanitizeFileName('   ')).toBe('playlist');
  });

  it('caps the length, since names are 500 chars and filenames are not', () => {
    expect(sanitizeFileName('歌'.repeat(300))).toHaveLength(80);
  });
});

describe('pickJsonFile', () => {
  it('answers the chosen path, and null for anything else', async () => {
    await expect(pickJsonFile(opener(['/tmp/a.json']), WIN)).resolves.toBe('/tmp/a.json');
    await expect(pickJsonFile(opener([], true), WIN)).resolves.toBeNull();
    await expect(pickJsonFile(opener([]), WIN)).resolves.toBeNull();
  });
});

describe('saveExportFile', () => {
  it('writes the content and leaves no staging file behind', async () => {
    const target = join(dir, 'out.json');
    const saved = await saveExportFile(saver(target), WIN, {
      default_name: 'out.json',
      content: '{"a":1}',
    });

    expect(saved).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}');
    expect(readdirSync(dir)).toEqual(['out.json']);
  });

  it('replaces an existing export in one step', async () => {
    const target = join(dir, 'out.json');
    writeFileSync(target, 'old');

    await saveExportFile(saver(target), WIN, { default_name: 'out.json', content: 'new' });

    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['out.json']);
  });

  it('leaves the old file alone when the write cannot complete', async () => {
    // A non-empty directory as the target: the staged write succeeds and the
    // rename is what fails, which is the hard half of the atomic swap.
    const target = join(dir, 'occupied');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'keep');

    await expect(
      saveExportFile(saver(target), WIN, { default_name: 'x', content: 'new' }),
    ).rejects.toThrow();

    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep');
    expect(readdirSync(dir)).toEqual(['occupied']);
  });

  it('does nothing when the dialog is cancelled', async () => {
    const saved = await saveExportFile(saver(undefined), WIN, {
      default_name: 'x',
      content: 'y',
    });
    expect(saved).toBe(false);
    expect(existsSync(join(dir, 'x'))).toBe(false);
  });
});
