// The cases every front end owes the library (N1g).
//
// Pure and host-free: no test runner, no Node, no database handle. Everything
// a case needs it asks the subject for, so the same fourteen assertions run
// against the daemon's HTTP routes, against the CLI's in-process backend, and
// — from N2 — against a phone.
//
// Where a case exists to pin a divergence that ACTUALLY HAPPENED, it says so.
// Three of them are here for exactly that reason.

import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { check, equal } from '../../contract/assert.js';
import { ContractRefusal, type LibraryContractCase, type LibrarySubject } from './types.js';

/** Run `fn` and assert the library refused it, for the stated reason. */
async function refuses(
  fn: () => Promise<unknown>,
  failure: string,
  what: string,
): Promise<ContractRefusal> {
  let thrown: unknown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  if (thrown === undefined) {
    throw new Error(`${what}: expected a refusal, got a result`);
  }
  if (!(thrown instanceof ContractRefusal)) {
    throw new Error(
      `${what}: expected a ContractRefusal, got ${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)}`,
    );
  }
  equal(thrown.failure, failure, `${what} (front end said ${thrown.nativeCode})`);
  return thrown;
}

export const LIBRARY_CONTRACT_CASES: readonly LibraryContractCase[] = [
  // ── reading ────────────────────────────────────────────
  {
    group: 'query',
    name: 'a song with a file and one without report has_file honestly',
    async run(s: LibrarySubject) {
      const withFile = await s.seedSong({ name: '有文件', fileBytes: 1024 });
      await s.seedSong({ name: '没文件' });
      const { songs, total } = await s.listSongs({});
      equal(total, 2, 'total');
      const hit = songs.find((song) => song.id === withFile);
      check(hit?.has_file === true, 'the seeded file is reported');
      equal(hit?.file_size, 1024, 'file_size');
      check(
        songs.some((song) => song.id !== withFile && song.has_file === false),
        'the song with no file says so',
      );
    },
  },
  {
    group: 'query',
    name: 'total is the filtered count BEFORE pagination',
    async run(s: LibrarySubject) {
      for (const name of ['一', '二', '三']) await s.seedSong({ name });
      const page = await s.listSongs({ limit: 1 });
      equal(page.songs.length, 1, 'page size');
      equal(page.total, 3, 'total ignores the page');
    },
  },
  {
    group: 'query',
    name: 'a search term is trimmed before it is matched (§7 F13)',
    async run(s: LibrarySubject) {
      // The bug this pins: `--direct` passed the raw string to LIKE while the
      // route trimmed it, so the same search found the song over HTTP and
      // nothing in process.
      const id = await s.seedSong({ name: '稻香' });
      const { songs } = await s.listSongs({ search: '  稻香  ' });
      equal(songs.length, 1, 'a padded search still matches');
      equal(songs[0]?.id, id, 'and matches the right song');
    },
  },

  // ── input rules ────────────────────────────────────────
  {
    group: 'input',
    name: 'a name that is only whitespace is refused (§7 F13)',
    async run(s: LibrarySubject) {
      // The other half of the same bug: `--direct` checked LENGTH but never
      // emptiness, so `'   '` became a playlist over there and a 400 here.
      await refuses(() => s.createPlaylist('   '), 'invalid-input', 'a blank playlist name');
    },
  },
  {
    group: 'input',
    name: 'a name is stored trimmed, so padding does not make a second entity',
    async run(s: LibrarySubject) {
      const created = await s.createPlaylist('  练歌  ');
      equal(created.name, '练歌', 'the stored name');
      const song = await s.seedSong({ name: 'x' });
      const updated = await s.updateSong(song, { name: '  稻香  ' });
      equal(updated.name, '稻香', "the song's stored name");
    },
  },
  {
    group: 'input',
    name: 'an over-long name is refused rather than truncated',
    async run(s: LibrarySubject) {
      await refuses(
        () => s.createPlaylist('x'.repeat(501)),
        'invalid-input',
        'a 501-character playlist name',
      );
    },
  },
  {
    group: 'input',
    name: 'a malformed id is a caller mistake, not a missing row (M6)',
    async run(s: LibrarySubject) {
      // The divergence this pins: the id gate lived in the daemon's route
      // layer, so `--direct` reported NOT_FOUND for a string that could never
      // name a row.
      await refuses(() => s.getSong('not-a-uuid'), 'invalid-id', 'a non-uuid song id');
    },
  },
  {
    group: 'input',
    name: 'a well-formed id that names nothing is not found',
    async run(s: LibrarySubject) {
      await refuses(
        () => s.getSong('00000000-0000-4000-8000-000000000000'),
        'not-found',
        'an unused uuid',
      );
    },
  },
  {
    group: 'input',
    name: 'more ids than one call may carry are refused',
    async run(s: LibrarySubject) {
      const playlist = await s.createPlaylist('p');
      const ids = Array.from({ length: 1001 }, () => '00000000-0000-4000-8000-000000000000');
      await refuses(
        () => s.addPlaylistSongs(playlist.id, ids),
        'invalid-input',
        '1001 ids in one call',
      );
    },
  },

  // ── the virtual `all` view (M6) ────────────────────────
  {
    group: 'virtual-all',
    name: 'it is listed first, and counts every song',
    async run(s: LibrarySubject) {
      // The divergence this pins: the daemon composed `all` and core did not,
      // so listing playlists returned a different set depending on whether a
      // daemon happened to be running — which made every name-based reference
      // resolve differently.
      await s.seedSong({ name: '一' });
      await s.seedSong({ name: '二' });
      await s.createPlaylist('p');
      const playlists = await s.listPlaylists();
      equal(playlists[0]?.id, VIRTUAL_ALL_PLAYLIST_ID, 'the first entry');
      equal(playlists[0]?.song_count, 2, 'its song count');
      equal(playlists.length, 2, 'the virtual one plus the real one');
    },
  },
  {
    group: 'virtual-all',
    name: 'it is readable, and it is exactly the default library view',
    async run(s: LibrarySubject) {
      await s.seedSong({ name: '一' });
      await s.seedSong({ name: '二' });
      const view = await s.listPlaylistSongs(VIRTUAL_ALL_PLAYLIST_ID);
      // Compared against the query it is DEFINED as, rather than against the
      // order the seeds went in: two rows created in the same millisecond tie
      // on `created_at` and fall back to id, so "the first one I inserted is
      // first" is not a property the library has (M5).
      const baseline = await s.listSongs({ sort: 'created_at', order: 'asc' });
      equal(view.length, 2, 'song count');
      equal(
        view.map((song) => song.id).join(','),
        baseline.songs.map((song) => song.id).join(','),
        'the virtual playlist is the default library view, song for song',
      );
    },
  },
  {
    group: 'virtual-all',
    name: 'every write against it is refused, never silently dropped',
    async run(s: LibrarySubject) {
      const song = await s.seedSong({ name: '一' });
      const all = VIRTUAL_ALL_PLAYLIST_ID;
      await refuses(() => s.renamePlaylist(all, 'x'), 'virtual-playlist', 'renaming all');
      await refuses(() => s.deletePlaylist(all), 'virtual-playlist', 'deleting all');
      await refuses(() => s.addPlaylistSongs(all, [song]), 'virtual-playlist', 'adding to all');
      await refuses(() => s.removePlaylistSong(all, song), 'virtual-playlist', 'removing from all');
      await refuses(
        () => s.reorderPlaylist(all, { song_id: song }),
        'virtual-playlist',
        'reordering all',
      );
    },
  },

  // ── writing ────────────────────────────────────────────
  {
    group: 'write',
    name: 'create, rename and delete a playlist',
    async run(s: LibrarySubject) {
      const created = await s.createPlaylist('练歌');
      const renamed = await s.renamePlaylist(created.id, '新名字');
      equal(renamed.name, '新名字', 'the new name');
      await s.deletePlaylist(created.id);
      const remaining = await s.listPlaylists();
      check(
        !remaining.some((p) => p.id === created.id),
        'the deleted playlist is gone from the list',
      );
    },
  },
  {
    group: 'write',
    name: 'membership and reorder move a song without touching the others',
    async run(s: LibrarySubject) {
      const a = await s.seedSong({ name: 'A' });
      const b = await s.seedSong({ name: 'B' });
      const playlist = await s.createPlaylist('p');
      equal(await s.addPlaylistSongs(playlist.id, [a, b]), 2, 'added');
      const before = await s.listPlaylistSongs(playlist.id);
      equal(before[0]?.id, a, 'A is first to begin with');

      await s.reorderPlaylist(playlist.id, { song_id: b, before_song_id: a });
      const after = await s.listPlaylistSongs(playlist.id);
      equal(after[0]?.id, b, 'B moved to the front');
      equal(after[1]?.id, a, 'A followed it');

      await s.removePlaylistSong(playlist.id, b);
      const left = await s.listPlaylistSongs(playlist.id);
      equal(left.length, 1, 'one member left');
      equal(left[0]?.id, a, 'and it is the one that stayed');
    },
  },
  {
    group: 'write',
    name: 'pinning is reported back and survives a re-read',
    async run(s: LibrarySubject) {
      const id = await s.seedSong({ name: '一' });
      const pinned = await s.pinSong(id, true);
      check(pinned.pinned === true, 'the answer says pinned');
      const reread = await s.getSong(id);
      check(reread.pinned === true, 'and so does a fresh read');
    },
  },
  {
    group: 'write',
    name: 'deleting a song takes its files with it, not just its row',
    async run(s: LibrarySubject) {
      const id = await s.seedSong({ name: '一', fileBytes: 512 });
      check(await s.songFilesExist(id), 'the file is there to begin with');
      await s.deleteSong(id);
      await refuses(() => s.getSong(id), 'not-found', 'the deleted song');
      check(!(await s.songFilesExist(id)), 'and its directory went with it');
    },
  },

  // ── cache and transfer ─────────────────────────────────
  {
    group: 'cache',
    name: 'the cache counts the bytes a song actually holds',
    async run(s: LibrarySubject) {
      equal(await s.cacheUsedBytes(), 0, 'an empty library holds nothing');
      await s.seedSong({ name: '一', fileBytes: 2048 });
      equal(await s.cacheUsedBytes(), 2048, 'after one file-backed song');
    },
  },
  {
    group: 'transfer',
    name: 'exporting the virtual playlist carries every song and its source key',
    async run(s: LibrarySubject) {
      await s.seedSong({ name: '一', source_provider: 'bilibili', source_key: 'BVaaa:1' });
      await s.seedSong({ name: '二', source_provider: 'bilibili', source_key: 'BVbbb:2' });
      const file = await s.exportPlaylist(VIRTUAL_ALL_PLAYLIST_ID);
      equal(file.songs.length, 2, 'exported song count');
      check(
        file.songs.every((song) => song.source_key !== null && song.source_key !== undefined),
        'every entry carries its key — identity across libraries rests on it (R12)',
      );
    },
  },
];
