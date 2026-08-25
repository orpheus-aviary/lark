// Criterion 87 (the desktop half) and the size gate (N6a).
//
// The digest constant is checked against a THIRD implementation here —
// `@noble/hashes`, standing in for the host — while the phone's answer for the
// same bytes is taken by `acceptance/playlist-import.ts` with `expo-crypto`.
// Neither side computes the expected value: `shasum -a 256` did, once, and
// both compare to it (`acceptance/import-fixture.ts`).
//
// The size gate gets tests for the reason the rest of this app's pure modules
// do: on a phone the failure is a screen that sits there for thirty seconds
// while 300MB goes through a JS hash, which reads as a crash and is invisible
// in a log.

import { installSha256BytesAsync, parseAndValidate } from '@lark/core/portable';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import {
  IMPORT_FIXTURE_DIGEST,
  IMPORT_FIXTURE_JSON,
  IMPORT_FIXTURE_PLAYLIST_NAME,
  IMPORT_FIXTURE_SONG_COUNT,
} from '../acceptance/import-fixture';
import { IMPORT_FILE_MAX_BYTES, type ImportFileSource, loadImportFile } from './import';

// Whoever gets there first wins; the port refuses a DIFFERENT function, so
// this file installs one and only one.
installSha256BytesAsync(async (data) => bytesToHex(sha256(data)));

const library = { parseImportFile: parseAndValidate };
const encoder = new TextEncoder();

function source(bytes: Uint8Array, over: Partial<ImportFileSource> = {}): ImportFileSource {
  return { name: '晚风.lark-playlist.json', size: bytes.length, read: async () => bytes, ...over };
}

describe('loadImportFile', () => {
  it('parses the fixture to the digest the desktop computed for the same bytes', async () => {
    const file = await loadImportFile(library, source(encoder.encode(IMPORT_FIXTURE_JSON)));

    expect(file.digest).toBe(IMPORT_FIXTURE_DIGEST);
    // Parsing, not only hashing: a file that hashed right and parsed to
    // nothing would pass on the digest alone.
    expect(file.playlist_name).toBe(IMPORT_FIXTURE_PLAYLIST_NAME);
    expect(file.entries).toHaveLength(IMPORT_FIXTURE_SONG_COUNT);
    expect(file.entries[1].lyrics_offset).toBe(-250);
  });

  it('refuses a declared size over the cap WITHOUT reading the file', async () => {
    const read = vi.fn(async () => new Uint8Array(0));
    const huge = { name: '一部电影.json', size: IMPORT_FILE_MAX_BYTES + 1, read };

    await expect(loadImportFile(library, huge)).rejects.toThrow(/上限 20MB/);
    // The whole point of the declared size: 300MB never enters JS.
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses on the byte count when the system declined to declare a size', async () => {
    const bytes = new Uint8Array(IMPORT_FILE_MAX_BYTES + 1);

    // 0 is what a SAF `content://` URI reports — "ask by reading", not "empty".
    await expect(loadImportFile(library, source(bytes, { size: 0 }))).rejects.toThrow(/上限 20MB/);
  });

  it('lets core reject a file that is not one of ours', async () => {
    const bytes = encoder.encode('{"format":"spotify","version":1}');

    await expect(loadImportFile(library, source(bytes))).rejects.toThrow();
  });
});
