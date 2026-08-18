// The `/conflicts/*` surface (v0.2 T3d, §4.6 / D4).
//
// A conflict record is a RECEIPT, not a merge: LWW already decided, the row
// already holds the remote value, and this table remembers what the user's own
// copy said so they can put it back. Four routes, and the split between them
// is about cost — the badge asks for a count on every status change, while the
// conflict page wants the payloads.
//
// `resolve` carries `expected_current`, the winner's LWW triple as the
// conflict recorded it. Between seeing a conflict and answering it a third
// device can write again, and restoring a local copy over THAT would undo a
// change nobody ever saw. So the row must still hold exactly the version this
// conflict says won, or the answer is refused (409) and the user decides once
// more against what is actually there.

import {
  type ConflictRow,
  countUnresolvedConflicts,
  getConflict,
  listConflicts,
  resolveConflict,
} from '@lark/core';
import {
  API_PATHS,
  type ConflictCountData,
  type ConflictData,
  type ConflictListData,
  type LwwKey,
  type SongSyncPayload,
  apiPath,
} from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ok } from '../response.js';
import {
  InvalidRequestError,
  objectBody,
  optionalString,
  pathUuid,
  requiredSafeInteger,
} from '../validation.js';

export function registerConflictRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(API_PATHS.conflicts, async (_req, reply) => {
    const conflicts = listConflicts(ctx.sqlite).map(toConflictData);
    ok(reply, { conflicts } satisfies ConflictListData, undefined, conflicts.length);
  });

  // Its own route rather than `conflicts.length`: the badge polls this on every
  // status change, and shipping every payload to answer "is there anything"
  // would put a song's whole record on the wire once a second.
  app.get(API_PATHS.conflictsCount, async (_req, reply) => {
    ok(reply, { count: countUnresolvedConflicts(ctx.sqlite) } satisfies ConflictCountData);
  });

  app.get<{ Params: { id: string } }>(apiPath.conflict(':id'), async (req, reply) => {
    const id = pathUuid(req.params.id);
    ok(reply, toConflictData(getConflict(ctx.sqlite, id)));
  });

  app.post<{ Params: { id: string } }>(apiPath.conflictResolve(':id'), async (req, reply) => {
    const id = pathUuid(req.params.id);
    const body = objectBody(req.body, ['strategy', 'expected_current']);
    const strategy = optionalString(body, 'strategy', { maxLength: 16 });
    if (strategy !== 'local' && strategy !== 'remote') {
      throw new InvalidRequestError('INVALID_BODY', "strategy must be 'local' or 'remote'");
    }
    const expected = objectBody(body.expected_current, [
      'updated_at_ms',
      'lww_counter',
      'device_id',
    ]);
    const expectedCurrent: LwwKey = {
      updated_at_ms: requiredSafeInteger(expected, 'updated_at_ms', { min: 0 }),
      lww_counter: requiredSafeInteger(expected, 'lww_counter', { min: 0 }),
      device_id:
        optionalString(expected, 'device_id', {
          maxLength: 128,
          allowEmpty: true,
          nullable: true,
        }) ?? null,
    };

    resolveConflict(ctx.portable, id, { strategy, expected_current: expectedCurrent });

    // A `local` resolve wrote through the ordinary update path, so the library
    // changed and the outbox grew — both of which somebody is waiting to hear.
    if (strategy === 'local') ctx.eventsBus.emit({ type: 'songs:changed' });
    ctx.eventsBus.emit({
      type: 'conflicts:changed',
      count: countUnresolvedConflicts(ctx.sqlite),
    });
    ok(reply, { id, strategy }, 'conflict resolved');
  });
}

/**
 * Project a record onto the wire, parsing the two stored payloads.
 *
 * A payload that will not parse becomes `null` rather than an error: the
 * record is still worth showing (it says WHEN and BY WHOM the row changed),
 * and a conflict page that 500s is strictly worse than one missing a column.
 */
function toConflictData(row: ConflictRow): ConflictData {
  return {
    id: row.id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    detected_at: row.detected_at,
    remote_seq: row.remote_seq,
    local_payload: parsePayload(row.local_payload),
    remote_payload: parsePayload(row.remote_payload),
    local_key: {
      updated_at_ms: row.local_updated_at_ms ?? 0,
      lww_counter: row.local_lww_counter ?? 0,
      device_id: row.local_device_id,
    },
    remote_key: {
      updated_at_ms: row.remote_updated_at_ms ?? 0,
      lww_counter: row.remote_lww_counter ?? 0,
      device_id: row.remote_device_id,
    },
  };
}

function parsePayload(raw: string | null): SongSyncPayload | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as SongSyncPayload)
      : null;
  } catch {
    return null;
  }
}
