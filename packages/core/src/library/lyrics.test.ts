import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYNC_CHANGE_BYTES_MAX } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DatabaseHandles, createDatabase } from '../db/index.js';
import { InvalidIdError } from '../errors.js';
import { songsDir } from '../paths.js';
import {
  deleteLyrics,
  deleteLyricsFile,
  readLyrics,
  songAudioPath,
  songDirPath,
  songLyricsPath,
  writeLyrics,
  writeLyricsFile,
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

function seedLyrics(text: string): void {
  mkdirSync(join(songsDir(), ID), { recursive: true });
  writeFileSync(songLyricsPath(ID), text);
}

describe('paths', () => {
  it('builds the payload paths under the song directory', () => {
    expect(songAudioPath(ID)).toBe(join(songsDir(), ID, 'song.m4a'));
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
    seedLyrics('[00:01.00]hello');
    await expect(readLyrics(ID)).resolves.toBe('[00:01.00]hello');
  });

  it('returns null when there is no lyrics file', async () => {
    await expect(readLyrics(ID)).resolves.toBeNull();
  });

  it('rejects an invalid id', async () => {
    await expect(readLyrics('nope')).rejects.toThrow(InvalidIdError);
  });
});

describe('writeLyricsFile', () => {
  it('creates the song directory and writes the file', async () => {
    await writeLyricsFile(ID, '[00:01.00]hello');
    await expect(readLyrics(ID)).resolves.toBe('[00:01.00]hello');
  });

  it('replaces existing lyrics', async () => {
    seedLyrics('[00:01.00]old');
    await writeLyricsFile(ID, '[00:01.00]new');
    await expect(readLyrics(ID)).resolves.toBe('[00:01.00]new');
  });

  // The temp sibling must never survive: a `.tmp` left in a song directory
  // would look like crash residue to M3's recovery routine.
  it('leaves no temp file behind', async () => {
    await writeLyricsFile(ID, '[00:01.00]hello');
    expect(readdirSync(songDirPath(ID))).toEqual(['lyrics.lrc']);
  });

  // "No lyrics" is the absence of the file — a zero-byte file reads back as
  // lyrics that exist and say nothing.
  it('refuses empty content instead of creating an empty file', async () => {
    await expect(writeLyricsFile(ID, '   ')).rejects.toThrow(/empty lyrics/);
    await expect(readLyrics(ID)).resolves.toBeNull();
  });

  it('rejects an invalid id before touching the filesystem', async () => {
    await expect(writeLyricsFile('../evil', 'x')).rejects.toThrow(InvalidIdError);
  });

  it('cleans up its temp file when the rename fails', async () => {
    // A directory where lyrics.lrc should be: the write succeeds, the rename
    // cannot. The temp file must not be left behind.
    mkdirSync(songLyricsPath(ID), { recursive: true });
    await expect(writeLyricsFile(ID, '[00:01.00]x')).rejects.toThrow();
    expect(readdirSync(songDirPath(ID))).toEqual(['lyrics.lrc']);
  });
});

describe('deleteLyricsFile', () => {
  it('deletes an existing file and reports it', async () => {
    seedLyrics('x');
    await expect(deleteLyricsFile(ID)).resolves.toBe(true);
    await expect(readLyrics(ID)).resolves.toBeNull();
  });

  it('reports false when there was nothing to delete', async () => {
    await expect(deleteLyricsFile(ID)).resolves.toBe(false);
  });
});

describe('the synced pair (v0.2)', () => {
  let handles: DatabaseHandles;

  beforeEach(() => {
    handles = createDatabase({ dbPath: ':memory:' });
  });

  afterEach(() => {
    handles.sqlite.close();
  });

  const changes = () =>
    handles.sqlite.prepare('SELECT op, payload FROM sync_changes ORDER BY local_seq').all() as {
      op: string;
      payload: string;
    }[];

  it('writes the file first, then publishes it', async () => {
    await writeLyrics(handles.db, ID, '[00:01.00]hello');

    await expect(readLyrics(ID)).resolves.toBe('[00:01.00]hello');
    expect(changes()).toHaveLength(1);
    expect(changes()[0].op).toBe('set_lyrics');
    expect(JSON.parse(changes()[0].payload)).toEqual({ lrc: '[00:01.00]hello' });
  });

  it('publishes a clear even when there was no file to delete', async () => {
    // "This song has no lyrics" is the statement; a peer that still has some
    // has to hear it regardless of what was on this disk.
    await expect(deleteLyrics(handles.db, ID)).resolves.toBe(false);
    expect(changes().map((c) => c.op)).toEqual(['clear_lyrics']);
  });

  it('keeps oversize lyrics locally and archives the refusal (D3)', async () => {
    const huge = `[00:01.00]${'x'.repeat(SYNC_CHANGE_BYTES_MAX)}`;
    await writeLyrics(handles.db, ID, huge);

    // Correct here, never reaching the others — an explicit non-convergence
    // point rather than a silent drop.
    await expect(readLyrics(ID)).resolves.toBe(huge);
    expect(changes()).toHaveLength(0);
    const letter = handles.sqlite
      .prepare("SELECT reason, op FROM sync_dead_letters WHERE direction='out'")
      .get() as { reason: string; op: string };
    expect(letter).toEqual({ reason: 'change_too_large', op: 'set_lyrics' });
  });
});
