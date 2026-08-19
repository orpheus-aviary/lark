// The LibraryContract's third hook (criterion 13, the N2 gate).
//
// `services/contract/index.ts` said this was coming: "N2's mobile client will
// add a third hook without touching a case." Nothing in `cases.ts` changed.
//
// A case asserts what the LIBRARY answers, never what a front end calls it.
// The daemon says `INVALID_BODY` where the CLI says `USAGE_ERROR`; this hook
// has no dialect of its own yet — it holds the service directly — so its
// translation is the shortest of the three: core's four error classes, named.
// That shortness is worth stating rather than hiding, because it is also the
// reason this hook is the most sensitive of the three: with no wire and no
// exit codes in between, a case that passes here passes on the service itself.
//
// FRESH LIBRARY PER CASE, and on a phone that means the whole boot sequence,
// eighteen times. Cheaper would be to open the database directly — and it
// would also stop testing the thing the app actually does.

import {
  type ContractFailure,
  ContractRefusal,
  type ContractReport,
  type ContractSongSeed,
  InvalidIdError,
  type LibraryContractHooks,
  LibraryInputError,
  type LibraryService,
  type LibrarySubject,
  NotFoundError,
  VirtualPlaylistError,
  assertLibraryId,
  createSong,
  runLibraryContract,
} from '@lark/core/portable';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { Directory, File } from 'expo-file-system';
import { type BootResult, runBootSequence } from '../boot/sequence';
import { nestDirectory, recoveredSongsRoot, songDirectory } from '../ports/paths';
import { NO_PLAYER_CACHE_OPTIONS, createLibrary } from '../services/library';
import { type ScenarioRow, resetInstall } from './d16';

/**
 * core's refusals, in the contract's vocabulary.
 *
 * `NotFoundError` is on this list for a reason worth remembering: the first
 * mapping table written for this batch had four entries and the plan's had
 * three (§1.3, "v1 漏了 `NotFoundError`"), and the case that would have caught
 * it says "a well-formed id that names nothing is not found" — which without
 * the mapping arrives as `other` and fails as a mystery.
 */
function failureOf(err: unknown): ContractFailure | null {
  if (err instanceof LibraryInputError) return 'invalid-input';
  if (err instanceof InvalidIdError) return 'invalid-id';
  if (err instanceof VirtualPlaylistError) return 'virtual-playlist';
  if (err instanceof NotFoundError) return 'not-found';
  return null;
}

/**
 * Every subject call goes through this.
 *
 * Anything unmapped is rethrown AS ITSELF rather than becoming `other`: the
 * contract counts `other` as a case failure, and a stack trace beats a label
 * when the reason is that something genuinely broke.
 */
async function translated<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const failure = failureOf(err);
    if (failure === null) throw err;
    throw new ContractRefusal(failure, err instanceof Error ? err.name : 'unknown');
  }
}

/** Which boot each live subject came from, so `close` can end it. */
const openBoots = new Map<LibrarySubject, BootResult>();

function seedInto(boot: BootResult, input: ContractSongSeed): string {
  const song = createSong(boot.db, {
    name: input.name,
    ...(input.artist === undefined ? {} : { artist: input.artist }),
    ...(input.source_provider === undefined
      ? {}
      : { source_provider: input.source_provider, source_key: input.source_key }),
  });
  if (input.fileBytes !== undefined) {
    const directory = songDirectory(song.id);
    if (!directory.exists) directory.create({ intermediates: true });
    const audio = new File(boot.files.paths.songAudio(song.id));
    audio.create({ overwrite: true });
    audio.write(new Uint8Array(input.fileBytes));
  }
  return song.id;
}

function subjectFor(boot: BootResult, library: LibraryService): LibrarySubject {
  return {
    listSongs: (query) => translated(() => library.listSongs(query)),
    getSong: (id) => translated(() => library.getSong(id)),
    updateSong: (id, patch) => translated(() => library.updateSong(id, patch)),
    deleteSong: (id) => translated(() => library.deleteSong(id)),
    pinSong: (id, pinned) => translated(() => library.pinSong(id, pinned)),

    listPlaylists: () => translated(() => library.listPlaylists()),
    createPlaylist: (name) => translated(() => library.createPlaylist(name)),
    renamePlaylist: (id, name) => translated(() => library.renamePlaylist(id, name)),
    deletePlaylist: (id) => translated(() => library.deletePlaylist(id)),
    listPlaylistSongs: (id) => translated(() => library.listPlaylistSongs(id)),
    addPlaylistSongs: (id, songIds) => translated(() => library.addPlaylistSongs(id, songIds)),
    removePlaylistSong: (id, songId) => translated(() => library.removePlaylistSong(id, songId)),
    reorderPlaylist: (id, move) => translated(() => library.reorderPlaylist(id, move)),

    exportPlaylist: (id) =>
      translated(() =>
        library.buildExport(
          // The virtual playlist is not a row, so it is exported by NAME —
          // the same shape the CLI's backend builds (`direct.ts`).
          id === VIRTUAL_ALL_PLAYLIST_ID
            ? { playlistId: null, name: VIRTUAL_ALL_PLAYLIST_ID }
            : { playlistId: assertLibraryId(id) },
        ),
      ),
    cacheUsedBytes: () => translated(() => library.cacheStatus(NO_PLAYER_CACHE_OPTIONS).used_bytes),

    seedSong: (input) => Promise.resolve(seedInto(boot, input)),
    songFilesExist: (id) => Promise.resolve(songDirectory(id).exists),
  };
}

const HOOKS: LibraryContractHooks = {
  async open(): Promise<LibrarySubject> {
    await resetInstall();
    for (const stale of [new Directory(nestDirectory(), 'songs'), recoveredSongsRoot()]) {
      if (stale.exists) stale.delete();
    }
    const boot = await runBootSequence();
    const subject = subjectFor(boot, createLibrary(boot));
    openBoots.set(subject, boot);
    return subject;
  },

  async close(subject: LibrarySubject): Promise<void> {
    openBoots.get(subject)?.handle.closeSync();
    openBoots.delete(subject);
  },
};

export async function runLibraryContractScenarios(): Promise<ScenarioRow[]> {
  const rows: ScenarioRow[] = [];
  const report: ContractReport = {
    pass: (group, name) => rows.push({ name: `${group} · ${name}`, ok: true, detail: 'pass' }),
    fail: (group, name, error) =>
      rows.push({
        name: `${group} · ${name}`,
        ok: false,
        detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }),
    // A skip reads as a failure: this hook has no host-specific exemptions, so
    // a case that did not run is a case nobody is watching.
    skip: (group, name, reason) =>
      rows.push({ name: `${group} · ${name}`, ok: false, detail: `skipped: ${reason}` }),
  };

  await runLibraryContract(HOOKS, report);
  await resetInstall();
  return rows;
}
