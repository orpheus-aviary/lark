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
//   /api/audio-migration the report and the retry: what is happening, and
//                        "I fixed the machine, go on".
//   /sync/file-ops …     the way OUT of a stuck migration. A sync op that gave
//                        up owns a song directory, the pass may not touch it,
//                        and nothing else can retry or discard it (§3.2-10).
//
// `POST /api/audio-migration/backup/clear` is deliberately NOT here: the pass
// is still moving files into that directory, and a delete that races it is not
// a feature. It becomes available with everything else, once the library is.

import { API_PATHS } from '@lark/shared';

const WHITELIST: ReadonlySet<string> = new Set([
  `GET ${API_PATHS.status}`,
  `GET ${API_PATHS.instance}`,
  `GET ${API_PATHS.capabilities}`,
  `GET ${API_PATHS.events}`,
  `GET ${API_PATHS.audioMigration}`,
  `POST ${API_PATHS.audioMigrationRetry}`,
  `GET ${API_PATHS.syncFileOps}`,
  `POST ${API_PATHS.syncFileOpsRetry}`,
  `POST ${API_PATHS.syncFileOpsDiscard}`,
]);

/**
 * The query string is stripped first — `/status?x=1` is the same route — and
 * the comparison is exact, so `/statusfoo` and `/status/../songs` are not.
 */
export function isMigrationWhitelisted(method: string, url: string): boolean {
  return WHITELIST.has(`${method} ${url.split('?')[0]}`);
}
