// `<name|id>` arguments (M6-10 / R25).
//
// Every command that takes a song or a playlist takes EITHER a uuid or a name,
// because "lark playlist delete 收藏" is what a person types and
// "lark playlist delete 3f2a…" is what a script has. The resolution rules are
// the same on both sides, and the ambiguous case is the one that matters:
//
//   a uuid (or the literal `all`)  → used as-is, no lookup
//   exactly one name match          → its id
//   no match                        → NOT_FOUND
//   several matches                 → AMBIGUOUS_* with the candidates listed
//
// Never "the first match": picking one of several identically-named songs on
// the user's behalf is how the wrong thing gets deleted (R25).

import { VIRTUAL_ALL_PLAYLIST_ID, isUuidV4 } from '@lark/shared';
import type { Backend } from '../backend/types.js';
import { CliError } from './errors.js';

/** Exact match first; a case-insensitive pass only if that found nothing. */
function matchByName<T extends { name: string }>(items: readonly T[], ref: string): T[] {
  const exact = items.filter((item) => item.name === ref);
  if (exact.length > 0) return exact;
  const folded = ref.toLocaleLowerCase();
  return items.filter((item) => item.name.toLocaleLowerCase() === folded);
}

export async function resolveSongRef(backend: Backend, ref: string): Promise<string> {
  if (isUuidV4(ref)) return ref;

  // `search` is the daemon's substring filter, so it is a PREFILTER: the exact
  // match below is what decides, and a name that only appears as a substring
  // of another song's never wins by accident.
  const envelope = await backend.listSongs({ search: ref, limit: 200 });
  const matches = matchByName(envelope.data ?? [], ref);

  if (matches.length === 1) return (matches[0] as { id: string }).id;
  if (matches.length === 0) {
    throw new CliError('NOT_FOUND', `没有找到歌曲「${ref}」`, { ref });
  }
  throw new CliError('AMBIGUOUS_SONG', `有 ${matches.length} 首歌叫「${ref}」，请用 id 指定`, {
    ref,
    candidates: matches.map((song) => ({
      id: song.id,
      name: song.name,
      artist: (song as { artist?: string }).artist ?? '',
    })),
  });
}

export interface PlaylistRefOptions {
  /** Whether the virtual `all` playlist is a legal answer here (R24). */
  allowAll?: boolean;
}

export async function resolvePlaylistRef(
  backend: Backend,
  ref: string,
  options: PlaylistRefOptions = {},
): Promise<string> {
  if (ref === VIRTUAL_ALL_PLAYLIST_ID) {
    if (options.allowAll === true) return ref;
    throw new CliError('VIRTUAL_PLAYLIST', '「all」是虚拟歌单，只读——不能对它做这个操作。', {
      ref,
    });
  }
  if (isUuidV4(ref)) return ref;

  const envelope = await backend.listPlaylists();
  // The virtual `all` is first in the daemon's list and is not a real row; it
  // can only be selected by its literal id, handled above.
  const real = (envelope.data ?? []).filter((p) => p.id !== VIRTUAL_ALL_PLAYLIST_ID);
  const matches = matchByName(real, ref);

  if (matches.length === 1) return (matches[0] as { id: string }).id;
  if (matches.length === 0) {
    throw new CliError('NOT_FOUND', `没有找到歌单「${ref}」`, { ref });
  }
  throw new CliError(
    'AMBIGUOUS_PLAYLIST',
    `有 ${matches.length} 个歌单叫「${ref}」，请用 id 指定`,
    {
      ref,
      candidates: matches.map((playlist) => ({ id: playlist.id, name: playlist.name })),
    },
  );
}
