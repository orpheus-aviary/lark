// The `--direct` backend against a REAL library on disk (M6-5).
//
// Two properties are the reason this file is an integration test rather than a
// unit test with fakes:
//
//   1. A read command leaves the nest byte-for-byte alone. That is what makes
//      `--direct` safe to run next to a daemon, and it can only be shown by
//      comparing the tree before and after.
//   2. A write command holds the cross-process writer lock while it runs, and
//      gives it back afterwards — including when it fails.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
// The writer lock needs better-sqlite3, so it lives in the core barrel rather
// than the zero-native `daemon-control` subpath. Tests may import it directly.
import { acquireWriterLock } from '@lark/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliError } from '../lib/errors.js';
import { createDirectBackend } from './direct.js';
import type { Backend } from './types.js';

let nest: string;
const larkDir = (): string => join(nest, 'lark');
const dbPath = (): string => join(larkDir(), 'songs.db');

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-direct-'));
  mkdirSync(larkDir(), { recursive: true });
  vi.stubEnv('LARK_NEST_DIR', nest);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as CliError).code;
  }
}

/** Run `body` with a direct backend, always closing it. */
async function withDirect<T>(
  mode: 'read' | 'write',
  body: (backend: Backend) => Promise<T>,
): Promise<T> {
  const opened = await createDirectBackend({ mode });
  try {
    return await body(opened.backend);
  } finally {
    opened.close();
  }
}

/** Seed a library with two songs and a playlist, through the write backend. */
async function seed(): Promise<{ songs: string[]; playlist: string }> {
  return await withDirect('write', async (backend) => {
    const created = await backend.createPlaylist('收藏');
    const playlistId = (created.data as { id: string }).id;

    // `importPlaylist` is the only write path that CREATES songs without a
    // download, which is exactly what a fixture needs.
    const file = join(nest, 'seed.json');
    writeFileSync(
      file,
      JSON.stringify({
        format: 'lark-playlist',
        version: 1,
        exported_at: 1,
        playlist: { name: '收藏' },
        songs: [
          {
            name: '晴天',
            artist: '周杰伦',
            source_url: null,
            source_provider: null,
            source_key: null,
            lyrics_offset: 0,
            duration: 269,
          },
          {
            name: '稻香',
            artist: '周杰伦',
            source_url: null,
            source_provider: null,
            source_key: null,
            lyrics_offset: 0,
            duration: 223,
          },
        ],
      }),
    );
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    await backend.importPlaylist({
      file_path: file,
      digest,
      target: { kind: 'playlist', playlist_id: playlistId },
    });

    const list = await backend.listSongs({});
    return { songs: (list.data ?? []).map((s) => s.id), playlist: playlistId };
  });
}

/** Every file under the nest, with size + mtime — the zero-write comparison. */
function treeSnapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const st = statSync(full);
      out[relative(root, full)] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(root);
  return out;
}

describe('opening the library', () => {
  it('reports an uninitialised library rather than creating one', async () => {
    expect(await codeOf(() => createDirectBackend({ mode: 'read' }))).toBe('DB_NOT_INITIALIZED');
    expect(readdirSync(larkDir())).toEqual([]);
  });

  it('creates the nest directory a first write needs, but never for a read', async () => {
    // A fresh nest has no `lark/` at all, and the lock database cannot be
    // created in a directory that does not exist (§6-3: `--direct` is how you
    // initialise one without starting a daemon). The read path must NOT do
    // this — it writes nothing, by definition.
    rmSync(larkDir(), { recursive: true, force: true });
    expect(await codeOf(() => createDirectBackend({ mode: 'read' }))).toBe('DB_NOT_INITIALIZED');
    expect(existsSync(larkDir())).toBe(false);

    await withDirect('write', async (backend) => {
      await backend.createPlaylist('新');
    });
    expect(await withDirect('read', async (b) => (await b.listPlaylists()).data?.length)).toBe(2);
  });

  it('refuses to write while another writer holds the lock', async () => {
    await seed();
    const lock = acquireWriterLock({ dbPath: dbPath() });
    try {
      expect(await codeOf(() => createDirectBackend({ mode: 'write' }))).toBe('WRITER_BUSY');
    } finally {
      lock.release();
    }
  });

  it('reads happily while another writer holds the lock', async () => {
    // A read takes no lock at all — that is the whole point of the read path.
    await seed();
    const lock = acquireWriterLock({ dbPath: dbPath() });
    try {
      const names = await withDirect('read', async (backend) =>
        (await backend.listSongs({})).data?.map((s) => s.name),
      );
      expect(names).toHaveLength(2);
    } finally {
      lock.release();
    }
  });

  it('holds the writer lock for the command, and hands it back after', async () => {
    await seed();
    const opened = await createDirectBackend({ mode: 'write' });
    expect(() => acquireWriterLock({ dbPath: dbPath() })).toThrow();
    opened.close();

    const after = acquireWriterLock({ dbPath: dbPath() });
    after.release();
  });
});

describe('reads write nothing', () => {
  it('leaves the whole nest tree untouched', async () => {
    await seed();
    // Checkpoint so the comparison is not about WAL state the seeding left.
    await withDirect('write', async () => {});
    const before = treeSnapshot(nest);

    await withDirect('read', async (backend) => {
      await backend.listSongs({ search: '晴' });
      await backend.listPlaylists();
      await backend.listPlaylistSongs('all');
      await backend.cacheStatus();
    });

    const after = treeSnapshot(nest);
    // WAL sidecars are the documented exemption (M4): a read-only connection
    // to a WAL database creates them and does not remove them on close.
    const ignore = (snap: Record<string, string>): Record<string, string> =>
      Object.fromEntries(Object.entries(snap).filter(([p]) => !/-wal$|-shm$/.test(p)));
    expect(ignore(after)).toEqual(ignore(before));
  });

  it('refuses a write through a read backend', async () => {
    await seed();
    expect(await codeOf(() => withDirect('read', (backend) => backend.createPlaylist('新')))).toBe(
      'USAGE_ERROR',
    );
  });
});

describe('the same answers the daemon would give', () => {
  it('lists songs with total and the has_file probe', async () => {
    const { songs } = await seed();

    const envelope = await withDirect('read', (backend) => backend.listSongs({}));

    expect(envelope.total).toBe(2);
    expect(envelope.data).toHaveLength(2);
    // Enrichment is a live disk probe, exactly as the daemon does it — these
    // songs were imported without files.
    expect(envelope.data?.[0]?.has_file).toBe(false);
    expect(songs).toHaveLength(2);
  });

  it('puts the virtual all playlist first, like the daemon does', async () => {
    // Not a row, so core does not return it — but a list that differs between
    // the two backends would make `lark playlist songs all` work only when a
    // daemon happens to be running (R3/R24).
    await seed();
    const envelope = await withDirect('read', (backend) => backend.listPlaylists());

    expect(envelope.data?.[0]).toMatchObject({ id: 'all', name: 'all', song_count: 2 });
    expect(envelope.data?.[1]?.name).toBe('收藏');
    expect(envelope.total).toBe(2);
  });

  it('treats `all` as a readable view and never as a writable playlist', async () => {
    await seed();

    const listed = await withDirect('read', (backend) => backend.listPlaylistSongs('all'));
    expect(listed.data).toHaveLength(2);

    expect(
      await codeOf(() => withDirect('write', (backend) => backend.deletePlaylist('all'))),
    ).toBe('VIRTUAL_PLAYLIST');
  });

  it('maps a missing song to NOT_FOUND', async () => {
    await seed();
    expect(
      await codeOf(() =>
        withDirect('read', (backend) => backend.getSong('11111111-2222-4333-8444-555555555555')),
      ),
    ).toBe('NOT_FOUND');
  });

  it('maps a malformed id to INVALID_ID', async () => {
    await seed();
    expect(await codeOf(() => withDirect('read', (backend) => backend.getSong('nope')))).toBe(
      'INVALID_ID',
    );
  });

  it('refuses an import whose file changed since the preview', async () => {
    await seed();
    const file = join(nest, 'changed.json');
    const body = {
      format: 'lark-playlist',
      version: 1,
      exported_at: 1,
      playlist: { name: 'x' },
      songs: [],
    };
    writeFileSync(file, JSON.stringify(body));

    expect(
      await codeOf(() =>
        withDirect('write', (backend) =>
          backend.importPlaylist({
            file_path: file,
            digest: 'a'.repeat(64), // not this file's digest
            target: { kind: 'all' },
          }),
        ),
      ),
    ).toBe('IMPORT_SOURCE_CHANGED');
  });
});

describe('round trip', () => {
  it('writes what a later read sees', async () => {
    const { songs, playlist } = await seed();
    const songId = songs[0] as string;

    await withDirect('write', async (backend) => {
      await backend.updateSong(songId, { artist: '周董' });
      await backend.pinSong(songId, true);
      await backend.removePlaylistSong(playlist, songId);
    });

    await withDirect('read', async (backend) => {
      const song = (await backend.getSong(songId)).data;
      expect(song?.artist).toBe('周董');
      expect(song?.pinned).toBe(true);
      expect((await backend.listPlaylistSongs(playlist)).data).toHaveLength(1);
    });
  });

  it('exports what it imported', async () => {
    const { playlist } = await seed();
    const exported = await withDirect('read', (backend) => backend.exportPlaylist(playlist));

    expect(exported.data?.playlist.name).toBe('收藏');
    expect(exported.data?.songs.map((s) => s.name).sort()).toEqual(['晴天', '稻香'].sort());
  });
});

describe('lyrics', () => {
  it('deletes the file, and reports a second delete as LYRICS_NOT_FOUND', async () => {
    const { songs } = await seed();
    const songId = songs[0] as string;
    mkdirSync(join(larkDir(), 'songs', songId), { recursive: true });
    writeFileSync(join(larkDir(), 'songs', songId, 'lyrics.lrc'), '[00:01.00]词\n');

    await withDirect('write', async (backend) => {
      expect((await backend.deleteLyrics(songId)).data).toEqual({ id: songId });
    });
    expect(readdirSync(join(larkDir(), 'songs', songId))).toEqual([]);

    expect(await codeOf(() => withDirect('write', (backend) => backend.deleteLyrics(songId)))).toBe(
      'LYRICS_NOT_FOUND',
    );
  });
});

describe('what only a daemon can do', () => {
  // The mode matrix refuses `--direct` on these commands before a backend is
  // built (M6-3); this is the second wall, and it must never turn into a
  // half-working in-process downloader.
  // Annotated: the calls return different payload types, and inference from
  // the first entry alone would reject the rest.
  const cases: [string, (backend: Backend) => Promise<unknown>][] = [
    ['parseInput', (backend) => backend.parseInput('BV1')],
    ['downloadSong', (backend) => backend.downloadSong({ input: 'BV1' })],
    ['fetchList', (backend) => backend.fetchList({ type: 'favorites', media_id: '1' })],
    ['downloadBatch', (backend) => backend.downloadBatch([])],
    ['downloadTasks', (backend) => backend.downloadTasks()],
    ['redownloadSong', (backend) => backend.redownloadSong('x')],
    ['recognizeUrl', (backend) => backend.recognizeUrl('x')],
    ['downloadLyrics', (backend) => backend.downloadLyrics('x')],
  ];

  it.each(cases)('refuses %s with a usage error', async (_name, call) => {
    await seed();
    expect(await codeOf(() => withDirect('write', call))).toBe('USAGE_ERROR');
  });
});

describe('cache', () => {
  it('reports a status without a config file, and creates none', async () => {
    await seed();
    const status = await withDirect('read', (backend) => backend.cacheStatus());

    expect(status.data?.limit_mb).toBe(0); // unlimited by default
    expect(status.data?.file_count).toBe(0);
    // `loadConfigReadonly` must not have written the default config (M6-23).
    expect(readdirSync(larkDir())).not.toContain('lark_config.toml');
  });
});
