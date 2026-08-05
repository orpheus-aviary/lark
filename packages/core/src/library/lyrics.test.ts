import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidIdError } from '../errors.js';
import { songsDir } from '../paths.js';
import {
  deleteLyrics,
  readLyrics,
  songAudioPath,
  songDirPath,
  songLyricsPath,
  writeLyrics,
} from './lyrics.js';

const ID = '9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001';
let nest: string;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-lyrics-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

function writeLyricsFile(text: string): void {
  mkdirSync(join(songsDir(), ID), { recursive: true });
  writeFileSync(songLyricsPath(ID), text);
}

describe('paths', () => {
  it('builds the payload paths under the song directory', () => {
    expect(songAudioPath(ID)).toBe(join(songsDir(), ID, 'song.mp3'));
    expect(songLyricsPath(ID)).toBe(join(songsDir(), ID, 'lyrics.lrc'));
  });

  it.each([
    ['..', '..'],
    ['traversal', '../../etc/passwd'],
    ['a suffixed uuid', `${ID}/..`],
    ['uppercase', ID.toUpperCase()],
    ['empty', ''],
  ])('refuses %s before it can reach a path join', (_label, id) => {
    expect(() => songAudioPath(id)).toThrow(InvalidIdError);
    expect(() => songLyricsPath(id)).toThrow(InvalidIdError);
  });
});

describe('readLyrics', () => {
  it('returns the file content', async () => {
    writeLyricsFile('[00:01.00]hello');
    await expect(readLyrics(ID)).resolves.toBe('[00:01.00]hello');
  });

  it('returns null when there is no lyrics file', async () => {
    await expect(readLyrics(ID)).resolves.toBeNull();
  });

  it('rejects an invalid id', async () => {
    await expect(readLyrics('nope')).rejects.toThrow(InvalidIdError);
  });
});

describe('writeLyrics', () => {
  it('creates the song directory and writes the file', async () => {
    await writeLyrics(ID, '[00:01.00]hello');
    await expect(readLyrics(ID)).resolves.toBe('[00:01.00]hello');
  });

  it('replaces existing lyrics', async () => {
    writeLyricsFile('[00:01.00]old');
    await writeLyrics(ID, '[00:01.00]new');
    await expect(readLyrics(ID)).resolves.toBe('[00:01.00]new');
  });

  // The temp sibling must never survive: a `.tmp` left in a song directory
  // would look like crash residue to M3's recovery routine.
  it('leaves no temp file behind', async () => {
    await writeLyrics(ID, '[00:01.00]hello');
    expect(readdirSync(songDirPath(ID))).toEqual(['lyrics.lrc']);
  });

  // "No lyrics" is the absence of the file — a zero-byte file reads back as
  // lyrics that exist and say nothing.
  it('refuses empty content instead of creating an empty file', async () => {
    await expect(writeLyrics(ID, '   ')).rejects.toThrow(/empty lyrics/);
    await expect(readLyrics(ID)).resolves.toBeNull();
  });

  it('rejects an invalid id before touching the filesystem', async () => {
    await expect(writeLyrics('../evil', 'x')).rejects.toThrow(InvalidIdError);
  });

  it('cleans up its temp file when the rename fails', async () => {
    // A directory where lyrics.lrc should be: the write succeeds, the rename
    // cannot. The temp file must not be left behind.
    mkdirSync(songLyricsPath(ID), { recursive: true });
    await expect(writeLyrics(ID, '[00:01.00]x')).rejects.toThrow();
    expect(readdirSync(songDirPath(ID))).toEqual(['lyrics.lrc']);
  });
});

describe('deleteLyrics', () => {
  it('deletes an existing file and reports it', async () => {
    writeLyricsFile('x');
    await expect(deleteLyrics(ID)).resolves.toBe(true);
    await expect(readLyrics(ID)).resolves.toBeNull();
  });

  it('reports false when there was nothing to delete', async () => {
    await expect(deleteLyrics(ID)).resolves.toBe(false);
  });
});
