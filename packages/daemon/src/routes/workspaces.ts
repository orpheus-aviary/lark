// The `/workspaces` surface (N7e-2).
//
// Two routes, and the second one deliberately does almost nothing: switching
// writes one line into `workspaces.toml` and takes effect at the next launch.
// The daemon goes on serving the library it has open, which is what makes the
// operation safe to interrupt — see `core/workspace-switch.ts` for the list of
// once-per-process gates that a live swap would have to re-enter.
//
// So the response says `restart_required` rather than pretending: the front
// end asks, gets told, and restarts the app. A route that reported success
// while the screen kept showing the old library would be the one lie this
// feature cannot afford.

import {
  inspectWorkspace,
  listWorkspaces,
  paths,
  readWorkspaceIndex,
  switchWorkspace,
} from '@lark/core';
import {
  API_PATHS,
  type WorkspaceData,
  type WorkspaceSwitchData,
  type WorkspacesData,
} from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ok } from '../response.js';
import { objectBody, requiredString } from '../validation.js';

/** A workspace id is `local` or 32 hex — short by construction. */
const MAX_ID = 64;

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /workspaces — the switcher's list, read off the disk and decorated
  // from the index (`core/workspace-list.ts` says why that way round).
  app.get(API_PATHS.workspaces, async (_req, reply) => {
    const index = readWorkspaceIndex(paths.workspacesPath(), ctx.logger);
    // What this daemon HAS OPEN, not what the index now names: a switch
    // moves the second and deliberately leaves the first alone.
    const serving = ctx.workspace;
    ok(
      reply,
      {
        workspaces: listWorkspaces(index).map(
          (row) =>
            ({
              id: row.id,
              label: row.label,
              server_url: row.server_url,
              active: row.active,
              songs: row.songs,
              playlists: row.playlists,
            }) satisfies WorkspaceData,
        ),
        serving,
        serving_has_sync_traces: inspectWorkspace(serving).hasSyncTraces,
      } satisfies WorkspacesData,
      'workspaces on this device',
    );
  });

  // POST /workspaces/switch — one atomic line, and a restart to honour it.
  app.post(API_PATHS.workspacesSwitch, async (req, reply) => {
    const body = objectBody(req.body, ['workspace_id']);
    const id = requiredString(body, 'workspace_id', { maxLength: MAX_ID });
    const result = switchWorkspace(id, ctx.logger);
    ok(
      reply,
      {
        id: result.id,
        previous: result.previous,
        changed: result.changed,
        restart_required: result.changed,
      } satisfies WorkspaceSwitchData,
      result.changed ? '下次启动会打开这个曲库' : '已经在这个曲库上了',
    );
  });
}
