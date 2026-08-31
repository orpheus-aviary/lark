// The add page's two functions, bound once for everybody who re-runs a
// download (0.1.1 ⑦⑧).
//
// ONE CALLER SINCE 2026-08-31, and the reason is worth keeping. It was built
// for two — the download page's 重下 button and the automatic retry — and the
// automatic one has since moved to `engine.enqueueRetry`, which replays the
// task's own target instead of rebuilding the request. That is not a tidy-up:
// rebuilding means answering "which naming?", a record carries no such answer
// (`history.ts`), and the answer this file supplies is **whatever the 命名 chip
// says right now**. For a button somebody just pressed that is right (0.1.1
// ⑨); for a retry nobody asked for it silently renamed the song.
//
// So what is left here is the manual path, and the comment below about reading
// the mode per call is about a person's tap rather than a machine's.
//
// A SINGLETON for the ordinary reason (`bootOnce`, the engine, the history):
// the naming mode is read per call, but the client and the foreground
// controller behind these must be the engine's own.

import { readNamingMode, resolveNamingMode } from '@lark/core/portable';
import type { BootResult } from '../boot/sequence';
import { downloadRuntimeOnce } from './engine';
import { recognise, submitDownload } from './preflight';
import type { ReplayDeps } from './replay';

let deps: ReplayDeps | null = null;

export function replayDepsOnce(boot: BootResult): ReplayDeps {
  if (deps === null) {
    const runtime = downloadRuntimeOnce(boot);
    deps = {
      recognise: (text) => recognise({ client: runtime.bilibili, hasLlm: runtime.hasLlm }, text),
      submit: async (item, playlistIds) => {
        const task = await submitDownload(
          {
            client: runtime.bilibili,
            hasLlm: runtime.hasLlm,
            foreground: runtime.foreground,
            engine: runtime.engine,
          },
          {
            item,
            // A keyword carries no mode at all — portable refuses one. A video
            // takes whatever 命名 is chosen NOW: a record does not carry the
            // mode it was submitted under (`history.ts` says why), and today's
            // answer is the honest reading of today's button.
            namingMode:
              item.kind === 'keyword'
                ? undefined
                : resolveNamingMode({
                    remembered: readNamingMode(boot.deviceSettings),
                    hasLlm: runtime.hasLlm(),
                  }),
            playlistIds: [...playlistIds],
          },
        );
        return task.id;
      },
      redownload: (songId) => runtime.engine.enqueueRedownload(songId).id,
      lyrics: (songId) => runtime.engine.enqueueLyrics(songId).id,
    };
  }
  return deps;
}
