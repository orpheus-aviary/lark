// Does this app bundle carry its own ffmpeg, and where (M7-16)?
//
// A `bundled` release ships the two binaries in `Resources/ffmpeg`; a `system`
// release ships none and expects the user's own install. The daemon does not
// look for either by itself — it is handed a DIRECTORY, and only when one is
// really there. That is why the signal is a directory rather than a flag:
// whoever spawns the daemon knows what it was packaged with, and the resolver
// stays a pure function of its environment.
//
// Dev is the "no bundle" case by construction: `process.resourcesPath` points
// into the Electron install, which has no `ffmpeg` directory. The justfile
// exports the vendored directory for dev runs, and it is inherited untouched
// — so a dev session and a bundled release exercise the same resolver level.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface MediaToolsDirDeps {
  resourcesPath: string;
  /** Test seam. */
  exists?: (path: string) => boolean;
}

/**
 * The bundled toolchain directory, or `null` when this build has none.
 *
 * Both binaries have to be there. Half a directory is a broken build, and
 * pointing the daemon at it would trade a clear "the app bundle is incomplete"
 * for a confusing "ffprobe is missing".
 */
export function bundledMediaToolsDir(deps: MediaToolsDirDeps): string | null {
  const exists = deps.exists ?? existsSync;
  const dir = join(deps.resourcesPath, 'ffmpeg');
  if (!exists(join(dir, 'ffmpeg')) || !exists(join(dir, 'ffprobe'))) return null;
  return dir;
}

/**
 * The environment the daemon child gets.
 *
 * When this build carries a bundle, its directory WINS over whatever was
 * inherited: a packaged app must not transcode through a stray environment
 * variable left over from a developer's shell.
 */
export function withMediaToolsDir(
  env: NodeJS.ProcessEnv,
  deps: MediaToolsDirDeps,
): NodeJS.ProcessEnv {
  const dir = bundledMediaToolsDir(deps);
  return dir === null ? env : { ...env, LARK_MEDIA_TOOLS_DIR: dir };
}
