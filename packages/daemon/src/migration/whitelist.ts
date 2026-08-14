// What still answers while the audio migration runs (0.3.0 T3, §3.2-2).
//
// The list is short and it is a list, not a prefix rule: a route joins the
// migration surface by being written down here, never by looking like one of
// its neighbours. Everything else answers `AUDIO_MIGRATION_PENDING`.
//
// Each entry earns its place:
//
//   /status              liveness + the migration counters, unauthenticated —
//                        the only channel a GUI has before it can read a token.
//   /api/instance        "is this MY daemon", which the GUI settles before it
//                        adopts a running one (M4-2). Refusing it would make a
//                        migrating daemon look like a stranger's.
//   /api/capabilities    what this build can do — including whether ffmpeg is
//                        usable, which is the first thing a blocked migration
//                        needs the user to see.
//   /events              an already-connected subscriber keeps its stream.
//
// The file-op trio and the migration's own endpoints join in T3b; without them
// a directory held by a stuck sync op cannot be freed, and the pass cannot
// finish.

import { API_PATHS } from '@lark/shared';

const WHITELIST: ReadonlySet<string> = new Set([
  `GET ${API_PATHS.status}`,
  `GET ${API_PATHS.instance}`,
  `GET ${API_PATHS.capabilities}`,
  `GET ${API_PATHS.events}`,
]);

/**
 * The query string is stripped first — `/status?x=1` is the same route — and
 * the comparison is exact, so `/statusfoo` and `/status/../songs` are not.
 */
export function isMigrationWhitelisted(method: string, url: string): boolean {
  return WHITELIST.has(`${method} ${url.split('?')[0]}`);
}
