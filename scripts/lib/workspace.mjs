// Where a nest's ACTIVE library lives (N7c).
//
// Since N7 one device can hold several libraries: the `local` one at the root
// of `lark/`, where it has always been, and an account's under
// `libraries/<32hex>/`. A library that was already bound to an account MOVES
// there on the first boot of the version that knows about workspaces.
//
// Every harness in this directory runs against a copy of a real nest, and the
// real nest is bound. So anything that names a library artefact by hand —
// `songs.db`, `songs/<id>/song.m4a`, `recovered-songs/` — has to ask rather
// than assume, or it starts asserting against a directory the library walked
// out of.
//
// `activeWorkspaceRootIn` and not `resolveActiveWorkspace`: the latter reads
// `LARK_NEST_DIR` from the current process, and these scripts drive up to two
// nests at once, neither of them this process's.

import { paths } from '../../packages/core/dist/index.js';

/** `<larkDir>` for `local`, `<larkDir>/libraries/<id>` for an account. */
export function libraryDir(larkDir) {
  return paths.activeWorkspaceRootIn(larkDir);
}
