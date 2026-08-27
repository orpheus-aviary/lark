// The add page's two functions, bound once for everybody who re-runs a
// download (0.1.1 ⑦⑧).
//
// TWO CALLERS NOW, WHICH IS WHY THIS EXISTS. The download page builds a 重下
// button out of these, and the automatic retry (`retry-runtime.ts`) builds the
// same request out of the same ones — and only one of the two is on a screen.
// Left in the screen, an automatic retry would have had to grow a second copy,
// and the copy would have been the one nobody checked.
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
