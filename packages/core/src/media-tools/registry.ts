// One answer per process to "can we transcode right now?" (M7-18).
//
// Before this, three places decided independently: boot resolved the binaries
// once and logged them, `ensureMp3`/`probeAudio` re-resolved on every call and
// ignored boot's answer, and import called ffprobe on its own and folded a
// missing toolchain into "this file failed to import". The observable result
// was a daemon reporting no ffmpeg while downloads transcoded fine through
// Homebrew — two truths, both sincere.
//
// So: resolve and probe HERE, cache the verdict, and hand the same
// `ResolvedMediaTools` to every consumer. The rules the cache follows:
//
//   - `ready` is cached until something disproves it. The only thing that can
//     is an actual execution failure (`noteExecutionFailure`) — a binary that
//     vanished mid-session, an app bundle replaced under a running daemon.
//   - `missing` / `incompatible` is re-probed, but no more often than
//     THROTTLE_MS. `brew install ffmpeg` in one window and a settings-page
//     refresh in the other has to recover without a restart; a settings page
//     that polls must not fork six processes a second.
//   - concurrent refreshes share one probe (single-flight). Six queued
//     downloads waking at once should ask the disk once.

import { MediaToolsUnavailableError } from '../errors.js';
import {
  type CapabilityProbeOptions,
  type CapabilityProbeResult,
  type MediaToolsState,
  probeCapabilities,
} from './capabilities.js';
import {
  type ResolveOptions,
  type ResolvedMediaTools,
  type ResolvedTool,
  resolveMediaTools,
} from './resolve.js';

/** Floor between two probes once the answer is known to be bad. */
export const THROTTLE_MS = 5000;

/** The shape `GET /api/capabilities` publishes (shared's `MediaToolsInfo`). */
export interface MediaToolsSnapshot {
  state: MediaToolsState;
  ffmpeg: ResolvedTool | null;
  ffprobe: ResolvedTool | null;
  detail: string | null;
}

export interface MediaToolsRegistryOptions {
  resolve?: ResolveOptions;
  probe?: CapabilityProbeOptions;
  /** Test seam: monotonic milliseconds. */
  now?: () => number;
  throttleMs?: number;
}

/**
 * What consumers depend on. Narrower than the class so the download engine and
 * import can be tested with a two-line fake instead of a probe harness.
 */
export interface MediaToolsProvider {
  /**
   * Usable tools, or `MediaToolsUnavailableError`. Call it BEFORE expensive
   * work whose only purpose is to feed ffmpeg — a machine with no ffmpeg
   * should hear about it in a second, not after a 5MB transfer.
   */
  acquire(): Promise<ResolvedMediaTools>;
  /**
   * `acquire`, plus: a spawn-level failure inside `fn` invalidates the cached
   * verdict. Wrap the actual ffmpeg calls in this, not the surrounding I/O.
   */
  use<T>(fn: (tools: ResolvedMediaTools) => Promise<T>): Promise<T>;
  /** Report a failure from a call made outside `use` (see the class). */
  noteExecutionFailure(err: unknown): void;
  /** Last known verdict. Never probes — safe on a request path. */
  snapshot(): MediaToolsSnapshot;
  /** Probe unless a fresh verdict is already cached. Single-flight. */
  refresh(): Promise<MediaToolsSnapshot>;
}

interface Verdict {
  result: CapabilityProbeResult;
  tools: ResolvedMediaTools | null;
  at: number;
}

export class MediaToolsRegistry implements MediaToolsProvider {
  readonly #options: MediaToolsRegistryOptions;
  readonly #now: () => number;
  readonly #throttleMs: number;
  #verdict: Verdict | null = null;
  #inFlight: Promise<MediaToolsSnapshot> | null = null;

  constructor(options: MediaToolsRegistryOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
    this.#throttleMs = options.throttleMs ?? THROTTLE_MS;
  }

  snapshot(): MediaToolsSnapshot {
    const verdict = this.#verdict;
    if (verdict === null) {
      // Boot refreshes before the server listens, so this is only reachable
      // from a test that skipped it. Report the honest thing rather than a
      // guess in either direction.
      return { state: 'missing', ffmpeg: null, ffprobe: null, detail: '尚未探测' };
    }
    return toSnapshot(verdict);
  }

  async refresh(): Promise<MediaToolsSnapshot> {
    const verdict = this.#verdict;
    if (verdict !== null && !this.#isStale(verdict)) return toSnapshot(verdict);
    this.#inFlight ??= this.#probe().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async use<T>(fn: (tools: ResolvedMediaTools) => Promise<T>): Promise<T> {
    const tools = await this.acquire();
    try {
      return await fn(tools);
    } catch (err) {
      this.noteExecutionFailure(err);
      throw err;
    }
  }

  /**
   * A consumer's run blew up in a way that means the verdict is wrong.
   *
   * Only spawn-level failures count. A transcode that fails on a corrupt input
   * says nothing about the toolchain, and invalidating on those would put the
   * daemon into a re-probe loop for every bad download.
   */
  noteExecutionFailure(err: unknown): void {
    const code = (err as { cause?: NodeJS.ErrnoException } & NodeJS.ErrnoException)?.code;
    const causeCode = (err as { cause?: NodeJS.ErrnoException })?.cause?.code;
    if (
      code === 'ENOENT' ||
      causeCode === 'ENOENT' ||
      code === 'EACCES' ||
      causeCode === 'EACCES'
    ) {
      this.#verdict = null;
    }
  }

  async acquire(): Promise<ResolvedMediaTools> {
    const snapshot = await this.refresh();
    const verdict = this.#verdict;
    if (verdict === null || verdict.tools === null || snapshot.state !== 'ready') {
      const state = snapshot.state === 'missing' ? 'missing' : 'incompatible';
      throw new MediaToolsUnavailableError(state, snapshot.detail ?? '原因未知');
    }
    return verdict.tools;
  }

  #isStale(verdict: Verdict): boolean {
    if (verdict.result.state === 'ready') return false;
    return this.#now() - verdict.at >= this.#throttleMs;
  }

  async #probe(): Promise<MediaToolsSnapshot> {
    const outcome = resolveMediaTools(this.#options.resolve);
    if (!outcome.ok) {
      this.#verdict = {
        result: {
          state: outcome.state,
          detail: outcome.detail,
          version: null,
          configuration: null,
        },
        tools: null,
        at: this.#now(),
      };
      return toSnapshot(this.#verdict);
    }
    const result = await probeCapabilities(outcome.tools, this.#options.probe);
    this.#verdict = { result, tools: outcome.tools, at: this.#now() };
    return toSnapshot(this.#verdict);
  }
}

function toSnapshot(verdict: Verdict): MediaToolsSnapshot {
  const { result, tools } = verdict;
  // A binary is only named once it has answered: reporting a path next to
  // `missing` reads as "we found this and it is broken", which is the other
  // state's story.
  const usable = result.state === 'ready' && tools !== null;
  return {
    state: result.state,
    ffmpeg: usable ? { ...tools.ffmpeg } : null,
    ffprobe: usable ? { ...tools.ffprobe } : null,
    detail: result.detail,
  };
}
