// The LibraryContract, driven through the in-process `--direct` backend (N1g).
//
// The twin of `packages/daemon/src/routes/library-contract.test.ts`, which
// runs the same case objects over HTTP. Two front ends, one suite: whatever
// they call a refusal, they have to refuse the same things — which is exactly
// what stopped being true when each of them wrote the library's rules out for
// itself (§7 F13, and the two M6 cases).
//
// `@lark/core` is imported statically here, unlike in `direct.ts`: this is a
// test, the guard excludes it, and a contract that reached the library through
// a dynamic import would be testing the import.

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ContractFailure,
  ContractRefusal,
  type ContractSongSeed,
  type LibraryContractHooks,
  type LibrarySubject,
  createDatabase,
  createSong,
  paths,
  runLibraryContract,
} from '@lark/core';
import type { ContractReport } from '@lark/core/portable';
import { afterAll, describe, expect, it } from 'vitest';
import { CliError } from '../lib/errors.js';
import { type DirectBackend, createDirectBackend } from './direct.js';

/**
 * The CLI's exit-code vocabulary, as the contract's.
 *
 * `USAGE_ERROR` is where the daemon says `INVALID_BODY` or `INVALID_QUERY`:
 * a terminal and a wire owe their callers different words for the same
 * refusal, and neither is wrong.
 */
const FAILURE_BY_CODE: Record<string, ContractFailure> = {
  USAGE_ERROR: 'invalid-input',
  INVALID_ID: 'invalid-id',
  VIRTUAL_PLAYLIST: 'virtual-playlist',
  NOT_FOUND: 'not-found',
};

/** Every subject call goes through this, so a CliError never escapes as itself. */
async function translated<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CliError) {
      throw new ContractRefusal(FAILURE_BY_CODE[err.code] ?? 'other', err.code);
    }
    throw err;
  }
}

const nests: string[] = [];
const open: DirectBackend[] = [];
const seedHandles: { close(): void }[] = [];

afterAll(() => {
  for (const backend of open) backend.close();
  open.length = 0;
  // Closed here, not at the end of `openSubject`: the seeding closure is
  // called by the CASE, long after the hook returned. Closing it early made
  // every seeding case fail with "the database connection is not open".
  for (const handle of seedHandles) handle.close();
  seedHandles.length = 0;
  for (const nest of nests) rmSync(nest, { recursive: true, force: true });
  nests.length = 0;
});

async function openSubject(): Promise<LibrarySubject> {
  const nest = mkdtempSync(join(tmpdir(), 'lark-lib-contract-direct-'));
  nests.push(nest);
  process.env.LARK_NEST_DIR = nest;
  mkdirSync(join(nest, 'lark'), { recursive: true });

  const dbPath = paths.dbPath();
  // Seeded through core against the same file the backend will open. A song
  // arrives in a real library by download or by import, and neither is on the
  // surface under contract.
  const seeded = createDatabase({ dbPath });
  seedHandles.push(seeded.sqlite);
  const seed = (input: ContractSongSeed): string => {
    const song = createSong(seeded.portable, {
      name: input.name,
      ...(input.artist === undefined ? {} : { artist: input.artist }),
      ...(input.source_provider === undefined
        ? {}
        : { source_provider: input.source_provider, source_key: input.source_key }),
    });
    if (input.fileBytes !== undefined) {
      mkdirSync(paths.songDirPath(song.id), { recursive: true });
      writeFileSync(paths.songAudioPath(song.id), Buffer.alloc(input.fileBytes));
    }
    return song.id;
  };

  const direct = await createDirectBackend({ mode: 'write', dbPath });
  open.push(direct);
  const b = direct.backend;

  return {
    listSongs: (query) =>
      translated(async () => {
        const res = await b.listSongs(query);
        return { songs: res.data ?? [], total: res.total ?? 0 };
      }),
    getSong: (id) => translated(async () => (await b.getSong(id)).data as never),
    updateSong: (id, patch) =>
      translated(async () => (await b.updateSong(id, patch)).data as never),
    deleteSong: (id) =>
      translated(async () => {
        await b.deleteSong(id);
      }),
    pinSong: (id, pinned) => translated(async () => (await b.pinSong(id, pinned)).data as never),

    listPlaylists: () => translated(async () => (await b.listPlaylists()).data ?? []),
    createPlaylist: (name) => translated(async () => (await b.createPlaylist(name)).data as never),
    renamePlaylist: (id, name) =>
      translated(async () => (await b.renamePlaylist(id, name)).data as never),
    deletePlaylist: (id) =>
      translated(async () => {
        await b.deletePlaylist(id);
      }),
    listPlaylistSongs: (id) => translated(async () => (await b.listPlaylistSongs(id)).data ?? []),
    addPlaylistSongs: (id, songIds) =>
      translated(async () => (await b.addPlaylistSongs(id, songIds)).data?.added ?? 0),
    removePlaylistSong: (id, songId) =>
      translated(async () => {
        await b.removePlaylistSong(id, songId);
      }),
    reorderPlaylist: (id, move) =>
      translated(async () => {
        await b.reorderPlaylist(id, move);
      }),

    exportPlaylist: (id) => translated(async () => (await b.exportPlaylist(id)).data as never),
    cacheUsedBytes: () => translated(async () => (await b.cacheStatus()).data?.used_bytes ?? 0),

    seedSong: (input) => Promise.resolve(seed(input)),
    songFilesExist: (id) => Promise.resolve(fileExists(paths.songDirPath(id))),
  };
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

const HOOKS: LibraryContractHooks = {
  open: openSubject,
  close: () => Promise.resolve(),
};

interface Result {
  group: string;
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
}

const results: Result[] = [];
const report: ContractReport = {
  pass: (group: string, name: string) => results.push({ group, name, status: 'pass' }),
  fail: (group: string, name: string, error: unknown) =>
    results.push({
      group,
      name,
      status: 'fail',
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }),
  skip: (group: string, name: string, reason: string) =>
    results.push({ group, name, status: 'skip', detail: reason }),
};

await runLibraryContract(HOOKS, report);

describe('library contract over the --direct backend', () => {
  it('ran every case', () => {
    expect(results.length).toBeGreaterThanOrEqual(18);
  });

  // A skip reads as a failure here on purpose: this suite has no host-specific
  // exemptions, so a case that did not run is a case nobody is watching.
  it.each(results.map((r) => [`${r.group} · ${r.name}`, r] as const))('%s', (_name, result) => {
    expect(result.status === 'pass' ? 'pass' : (result.detail ?? result.status)).toBe('pass');
  });

  // N2 adds a third hook, over the mobile client's own service. It is named
  // here rather than left absent so that "two hooks" stays a statement about
  // where we are, not a number nobody counted.
  it.skip('mobile hook — lands with the mobile app (N2)', () => {});
});
