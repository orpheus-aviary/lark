// The LibraryContract, driven over the daemon's HTTP routes (N1g).
//
// The subject below reaches the library the way a GUI does: a JSON request
// through the real handler chain — validation, the service, the error mapper,
// the envelope. `app.inject` is that chain minus the socket, so a case that
// passes here passes against a running daemon.
//
// Its twin lives in `apps/cli`, over the in-process `--direct` backend. The
// two hooks are the point: the cases are the same object, and the front ends
// only get to differ in what they CALL a refusal, never in whether there is
// one.

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ContractFailure,
  ContractRefusal,
  type ContractSongSeed,
  type LibraryContractHooks,
  type LibrarySubject,
  createSong,
  paths,
  runLibraryContract,
} from '@lark/core';
import type { ContractReport } from '@lark/core/portable';
import type { ApiResponse } from '@lark/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';

/**
 * The daemon's wire codes, as the contract's vocabulary.
 *
 * `INVALID_BODY` and `INVALID_QUERY` are one library rule wearing two hats —
 * the daemon owes a caller the difference, the library does not have one.
 */
const FAILURE_BY_CODE: Record<string, ContractFailure> = {
  INVALID_BODY: 'invalid-input',
  INVALID_QUERY: 'invalid-input',
  INVALID_ID: 'invalid-id',
  VIRTUAL_PLAYLIST: 'virtual-playlist',
  NOT_FOUND: 'not-found',
};

const nests: string[] = [];
const contexts: TestContext[] = [];

afterAll(async () => {
  for (const ctx of contexts) await closeTestContext(ctx);
  contexts.length = 0;
  for (const nest of nests) rmSync(nest, { recursive: true, force: true });
  nests.length = 0;
});

function openSubject(): LibrarySubject & { ctx: TestContext } {
  const nest = mkdtempSync(join(tmpdir(), 'lark-lib-contract-daemon-'));
  nests.push(nest);
  process.env.LARK_NEST_DIR = nest;
  mkdirSync(join(nest, 'lark'), { recursive: true });

  const ctx = createTestContext();
  contexts.push(ctx);
  const app = buildTestServer(ctx);

  async function call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ): Promise<ApiResponse<T>> {
    // Explicitly annotated: `inject` returns an intersection containing `void`,
    // and `await` does not narrow it inside a helper (M3).
    const res: LightMyRequestResponse =
      payload === undefined
        ? await app.inject({ method, url })
        : await app.inject({ method, url, payload });
    const body = res.json<ApiResponse<T>>();
    if (body.success) return body;
    const code = body.error_code ?? 'UNKNOWN';
    throw new ContractRefusal(FAILURE_BY_CODE[code] ?? 'other', code);
  }

  const data = async <T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ): Promise<T> => (await call<T>(method, url, payload)).data as T;

  return {
    ctx,

    async listSongs(query) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) search.set(key, String(value));
      }
      const suffix = search.size === 0 ? '' : `?${search.toString()}`;
      const body = await call<Awaited<ReturnType<LibrarySubject['listSongs']>>['songs']>(
        'GET',
        `/songs${suffix}`,
      );
      return { songs: body.data ?? [], total: body.total ?? 0 };
    },
    getSong: (id) => data('GET', `/songs/${id}`),
    updateSong: (id, patch) => data('PUT', `/songs/${id}`, patch),
    deleteSong: async (id) => {
      await call('DELETE', `/songs/${id}`);
    },
    pinSong: (id, pinned) => data('PUT', `/songs/${id}/pin`, { pinned }),

    listPlaylists: () => data('GET', '/playlists'),
    createPlaylist: (name) => data('POST', '/playlists', { name }),
    renamePlaylist: (id, name) => data('PUT', `/playlists/${id}`, { name }),
    deletePlaylist: async (id) => {
      await call('DELETE', `/playlists/${id}`);
    },
    listPlaylistSongs: (id) => data('GET', `/playlists/${id}/songs`),
    addPlaylistSongs: async (id, songIds) =>
      (await data<{ added: number }>('POST', `/playlists/${id}/songs`, { song_ids: songIds }))
        .added,
    removePlaylistSong: async (id, songId) => {
      await call('DELETE', `/playlists/${id}/songs/${songId}`);
    },
    reorderPlaylist: async (id, move) => {
      await call('POST', `/playlists/${id}/reorder`, move);
    },

    exportPlaylist: (id) => data('GET', `/playlists/${id}/export`),
    cacheUsedBytes: async () =>
      (await data<{ used_bytes: number }>('GET', '/cache/status')).used_bytes,

    seedSong: (seed) => Promise.resolve(seedSong(ctx, seed)),
    songFilesExist: (id) => Promise.resolve(fileExists(paths.songDirPath(id))),
  };
}

/**
 * Rows go in through core, not through the wire.
 *
 * A song arrives in a real library by download or by import, neither of which
 * is on the surface under contract — and a case about deleting a song should
 * not fail because the download queue is busy.
 */
function seedSong(ctx: TestContext, seed: ContractSongSeed): string {
  const song = createSong(ctx.portable, {
    name: seed.name,
    ...(seed.artist === undefined ? {} : { artist: seed.artist }),
    ...(seed.source_provider === undefined
      ? {}
      : { source_provider: seed.source_provider, source_key: seed.source_key }),
  });
  if (seed.fileBytes !== undefined) {
    mkdirSync(paths.songDirPath(song.id), { recursive: true });
    writeFileSync(paths.songAudioPath(song.id), Buffer.alloc(seed.fileBytes));
  }
  return song.id;
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
  open: () => Promise.resolve(openSubject()),
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

describe('library contract over the daemon routes', () => {
  it('ran every case', () => {
    expect(results.length).toBeGreaterThanOrEqual(18);
  });

  // A skip reads as a failure here on purpose: this suite has no host-specific
  // exemptions, so a case that did not run is a case nobody is watching.
  it.each(results.map((r) => [`${r.group} · ${r.name}`, r] as const))('%s', (_name, result) => {
    expect(result.status === 'pass' ? 'pass' : (result.detail ?? result.status)).toBe('pass');
  });
});
