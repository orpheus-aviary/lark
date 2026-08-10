// A `MediaToolsProvider` for tests that are not about ffmpeg (M7-18).
//
// Most of the download and import suites care about queueing, claims, atomic
// landing or event ordering, and reach ffmpeg only incidentally. They get this:
// a provider that hands out whatever paths the test wants and never spawns
// anything. The suites that ARE about ffmpeg use the real registry.

import type { MediaToolsProvider, MediaToolsSnapshot } from '../media-tools/registry.js';
import type { ResolvedMediaTools } from '../media-tools/resolve.js';

export interface FakeMediaToolsOptions {
  ffmpeg?: string;
  ffprobe?: string;
  /** Make every acquire fail, the way a machine with no ffmpeg behaves. */
  unavailable?: Error;
}

export interface FakeMediaTools extends MediaToolsProvider {
  /** Errors handed to `noteExecutionFailure`, in order. */
  readonly noted: readonly unknown[];
}

export function fakeMediaTools(options: FakeMediaToolsOptions = {}): FakeMediaTools {
  const tools: ResolvedMediaTools = {
    ffmpeg: { path: options.ffmpeg ?? 'ffmpeg', source: 'path' },
    ffprobe: { path: options.ffprobe ?? 'ffprobe', source: 'path' },
  };
  const noted: unknown[] = [];
  const snapshot = (): MediaToolsSnapshot =>
    options.unavailable === undefined
      ? { state: 'ready', ffmpeg: { ...tools.ffmpeg }, ffprobe: { ...tools.ffprobe }, detail: null }
      : { state: 'missing', ffmpeg: null, ffprobe: null, detail: options.unavailable.message };

  const acquire = async (): Promise<ResolvedMediaTools> => {
    if (options.unavailable !== undefined) throw options.unavailable;
    return tools;
  };

  return {
    acquire,
    async use(fn) {
      const acquired = await acquire();
      try {
        return await fn(acquired);
      } catch (err) {
        noted.push(err);
        throw err;
      }
    },
    noteExecutionFailure(err) {
      noted.push(err);
    },
    snapshot,
    async refresh() {
      return snapshot();
    },
    noted,
  };
}
