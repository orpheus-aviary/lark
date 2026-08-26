// What `workspaces.toml` / `workspaces.json` means (N7b).
//
// ONE FILE PER DEVICE, next to the nest rather than inside any library,
// holding the one fact that cannot be worked out from the disk: WHICH
// workspace this device opens. Everything else in it is decoration — a label
// and a server url so a switcher can show something a person recognises
// instead of 32 hex digits.
//
// 🔑 THE DISK IS THE TRUTH ABOUT WHICH WORKSPACES EXIST, not this file. A
// directory under `libraries/` with a `songs.db` in it IS a workspace; an
// entry here without one is decoration for something that is not there. That
// split is deliberate and it is what makes a damaged index survivable: the
// worst it can cost is a name and a starting point, never a library that
// stops being visible. An index that were the sole register would turn one
// corrupt file into "where did my songs go".
//
// WHY THIS IS SIMPLER THAN OWL'S GATE. owl checks three things — the id
// parses, the `[profiles.<id>]` section exists, and the db file exists —
// because there the profile's DB and its CREDENTIALS live in two different
// files, so "account session + local db" and "profile db + legacy config" are
// both reachable states. lark keeps a workspace's credentials INSIDE the
// workspace (`libraries/<id>/skybridge.toml`, §2.1), so the db existing and
// the credentials existing are the same question, and the section check has
// nothing left to catch.
//
// PARSING ONLY. This module takes something already decoded — smol-toml on the
// desktop, `JSON.parse` on the phone — and says what it means. It reads no
// files, creates nothing and deletes nothing, which is criterion 107's real
// content: a file this build cannot understand must not be able to cost
// anybody a library.

import type { StructuredLogger } from './logger.js';
import { WORKSPACE_LOCAL, isWorkspaceId } from './workspace.js';

/**
 * What a switcher shows for one workspace. Both fields are decoration, and
 * both are honestly allowed to be empty — a workspace whose entry was lost is
 * still perfectly usable, it just has no name yet.
 */
export interface WorkspaceEntry {
  /** Usually the account this workspace belongs to. `''` when unknown. */
  readonly label: string;
  /** Where it syncs, for display. `''` for `local` and for unknown. */
  readonly server_url: string;
}

export interface WorkspaceIndex {
  /** Which workspace this device opens. Always a valid id. */
  readonly active: string;
  /** Decoration, by id. Absence means "no name", never "not there". */
  readonly entries: Readonly<Record<string, WorkspaceEntry>>;
}

/** A device that has never switched: it opens the library it always had. */
export const DEFAULT_WORKSPACE_INDEX: WorkspaceIndex = {
  active: WORKSPACE_LOCAL,
  entries: {},
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Read the index, or fall back to the device that has never switched.
 *
 * Every failure lands on the same answer — `active = local`, no decoration —
 * and every one of them is logged, because the two ways this goes wrong look
 * identical from the outside: a phone that opens the wrong library and a phone
 * whose index was never written both just show a library.
 */
export function parseWorkspaceIndex(value: unknown, logger?: StructuredLogger): WorkspaceIndex {
  if (!isPlainObject(value)) {
    logger?.warn({}, 'the workspace index is not an object — this device opens its local library');
    return DEFAULT_WORKSPACE_INDEX;
  }

  const active = asString(value.active);
  if (!isWorkspaceId(active)) {
    logger?.warn(
      { active: value.active },
      `the workspace index names an active workspace this build cannot use — opening '${WORKSPACE_LOCAL}'`,
    );
  }

  const entries: Record<string, WorkspaceEntry> = {};
  const stored = value.entries;
  if (stored !== undefined && !isPlainObject(stored)) {
    logger?.warn({}, 'the workspace index has no readable entries — the list will be unnamed');
  } else if (isPlainObject(stored)) {
    for (const [id, entry] of Object.entries(stored)) {
      // An id that is not an id was never a directory name either, so there is
      // nothing on disk this drops the name of.
      if (!isWorkspaceId(id)) {
        logger?.warn({ id }, 'the workspace index names something that is not a workspace id');
        continue;
      }
      if (!isPlainObject(entry)) continue;
      entries[id] = { label: asString(entry.label), server_url: asString(entry.server_url) };
    }
  }

  return { active: isWorkspaceId(active) ? active : WORKSPACE_LOCAL, entries };
}

/**
 * The plain object a host encodes.
 *
 * Whole-file, never a merge with what is on disk: the caller has just switched
 * workspaces or registered one, and merging would let an `active` that was
 * replaced outlive the replacement.
 */
export function serializeWorkspaceIndex(index: WorkspaceIndex): Record<string, unknown> {
  return { active: index.active, entries: { ...index.entries } };
}

export interface ActiveWorkspaceVerdict {
  /** The workspace to open. Always valid, never absent. */
  readonly id: string;
  /** What the index asked for, which is not always what it got. */
  readonly requested: string;
  /** True when the request could not be honoured. Somebody should log it. */
  readonly fellBack: boolean;
}

/**
 * Which workspace a device opens — the gate, in one place for both hosts.
 *
 * TWO QUESTIONS, and owl's third has nothing left to catch here (see the
 * header): the id is one this build understands, and its library is on disk.
 * `hasLibrary` is handed in because that is the only part that differs — a
 * `statSync` on the desktop, an expo `File.exists` on the phone.
 *
 * EITHER ONE FAILING MEANS `local`, and it is worth being explicit about which
 * way that cuts. A device whose real library is under `libraries/` and whose
 * index went missing comes up on an EMPTY local library: alarming, and it
 * loses nothing. The other direction — treating the index as gospel and
 * creating a library at the missing path — would put new songs somewhere the
 * person cannot find. `fellBack` exists so a host can say which happened,
 * because from the outside the two look identical.
 */
export function decideActiveWorkspace(
  index: WorkspaceIndex,
  hasLibrary: (id: string) => boolean,
): ActiveWorkspaceVerdict {
  const requested = index.active;
  if (requested === WORKSPACE_LOCAL) {
    return { id: WORKSPACE_LOCAL, requested, fellBack: false };
  }
  if (hasLibrary(requested)) return { id: requested, requested, fellBack: false };
  return { id: WORKSPACE_LOCAL, requested, fellBack: true };
}

/** The index with `id` named. Pure — the caller writes it. */
export function withWorkspaceEntry(
  index: WorkspaceIndex,
  id: string,
  entry: WorkspaceEntry,
): WorkspaceIndex {
  if (!isWorkspaceId(id)) throw new Error(`not a workspace id: ${id}`);
  return { active: index.active, entries: { ...index.entries, [id]: entry } };
}

/** The index with `id` active. Pure — the caller writes it. */
export function withActiveWorkspace(index: WorkspaceIndex, id: string): WorkspaceIndex {
  if (!isWorkspaceId(id)) throw new Error(`not a workspace id: ${id}`);
  return { active: id, entries: index.entries };
}
