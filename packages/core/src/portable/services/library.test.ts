// `readLyrics` on the service face (N3c, decision h).
//
// NOT a LibraryContract case, and that is the decision rather than an
// oversight: `ContractSongSeed` can write an audio file and nothing else, so a
// contract case would mean widening the seed and teaching all three hooks to
// place a lyrics file — for a question the three front ends cannot disagree
// about. Reading a file is not library semantics. The id gate, on the other
// hand, is, and that is what this file is here for.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../db/index.js';
import { nodeFileContext } from '../../node-fs.js';
import { songLyricsPath, songsDir } from '../../paths.js';
import { InvalidIdError } from '../errors.js';
import { type LibraryService, createLibraryService } from './library.js';

const ID = '9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001';

let nest: string;
let service: LibraryService;
let close: () => void;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-service-lyrics-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  const { sqlite, portable } = createDatabase({ dbPath: join(nest, 'songs.db') });
  close = () => sqlite.close();
  service = createLibraryService({
    db: portable,
    files: nodeFileContext(),
    // Nothing here deletes, so the journal never runs — an honest empty
    // result rather than a stub that would lie if it were ever called.
    fileOps: { drain: async () => ({ executed: 0, failed: 0, skipped: 0 }) },
    audioMode: 'canonical',
  });
});

afterEach(() => {
  close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

describe('readLyrics', () => {
  it('returns the file when there is one', async () => {
    mkdirSync(join(songsDir(), ID), { recursive: true });
    writeFileSync(songLyricsPath(ID), '[00:01.00]一行\n');
    await expect(service.readLyrics(ID)).resolves.toBe('[00:01.00]一行\n');
  });

  it('returns null when the song has no lyrics — absence is not an error', async () => {
    await expect(service.readLyrics(ID)).resolves.toBeNull();
  });

  it('refuses an id that never passed the gate, before any path is built', async () => {
    await expect(service.readLyrics('../../etc/passwd')).rejects.toBeInstanceOf(InvalidIdError);
    await expect(service.readLyrics('')).rejects.toBeInstanceOf(InvalidIdError);
  });
});
