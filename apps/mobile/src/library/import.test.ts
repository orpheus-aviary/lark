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
import {
  IMPORT_FILE_MAX_BYTES,
  type ImportFileSource,
  ImportSourceChangedError,
  commitImportFile,
  loadImportFile,
} from './import';

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

// What core does with an import is core's, and `portable/library/transfer.test.ts`
// tests it against a real database — every target, every reuse rule, the
// all-or-nothing rollback. What is MOBILE's, and therefore here, is the second
// read: that it happens, that its digest decides, and that the entries handed
// over are its own rather than the preview's.
describe('commitImportFile', () => {
  const CHOICE = { target: { kind: 'library' }, reuse: new Map() } as const;

  /** A source whose bytes can be swapped between the two reads. */
  function mutableSource(initial: string) {
    let text = initial;
    return {
      source: {
        name: 'x.lark-playlist.json',
        size: 0,
        read: async () => encoder.encode(text),
      } satisfies ImportFileSource,
      swap: (next: string) => {
        text = next;
      },
    };
  }

  it('imports the entries from the SECOND read, not the preview’s', async () => {
    const { source: src } = mutableSource(IMPORT_FIXTURE_JSON);
    const preview = await loadImportFile(library, src);
    const seen: unknown[] = [];
    const spy = {
      ...library,
      importPlaylist: (input: unknown) => {
        seen.push(input);
        return { playlist_id: 'p1', total: 2, created: 1, reused: 1, added: 2 };
      },
    };

    await commitImportFile(spy, src, preview, {
      target: { kind: 'new', name: '晚风' },
      reuse: new Map([[0, 'song-id-1']]),
    });

    expect(seen).toEqual([
      {
        entries: preview.entries,
        target: { kind: 'new', name: '晚风' },
        reuse: [{ index: 0, song_id: 'song-id-1' }],
      },
    ]);
    // IDENTITY, not equality, and that is the whole assertion: an unchanged
    // file parses to entries that are EQUAL to the preview's either way, so
    // `toEqual` above cannot tell which read they came from. A different array
    // object can.
    expect((seen[0] as { entries: unknown }).entries).not.toBe(preview.entries);
  });

  it('refuses when the file changed under the answers, and carries the new one', async () => {
    const { source: src, swap } = mutableSource(IMPORT_FIXTURE_JSON);
    const preview = await loadImportFile(library, src);
    const importPlaylist = vi.fn();
    swap(IMPORT_FIXTURE_JSON.replace('"duration": 372', '"duration": 999'));

    const failure = await commitImportFile(
      { ...library, importPlaylist },
      src,
      preview,
      CHOICE,
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ImportSourceChangedError);
    // Nothing was imported against indices that no longer mean what they did.
    expect(importPlaylist).not.toHaveBeenCalled();
    // And the screen has the file it would have to preview next, so going back
    // does not cost a third read — or open a window for a second change.
    expect((failure as ImportSourceChangedError).current.digest).not.toBe(preview.digest);
    expect((failure as ImportSourceChangedError).current.entries[0].duration).toBe(999);
  });

  it('applies the size gate to the second read too', async () => {
    const { source: src, swap } = mutableSource(IMPORT_FIXTURE_JSON);
    const preview = await loadImportFile(library, src);
    const importPlaylist = vi.fn();
    swap(`${IMPORT_FIXTURE_JSON}${' '.repeat(IMPORT_FILE_MAX_BYTES)}`);

    await expect(
      commitImportFile({ ...library, importPlaylist }, src, preview, CHOICE),
    ).rejects.toThrow(/上限 20MB/);
    expect(importPlaylist).not.toHaveBeenCalled();
  });
});
