import type { ApiResponse, StatusData } from '@lark/shared';

/**
 * What a CLI command may call, independent of how it reaches the data.
 *
 * M0 ships the HTTP backend only. M6 adds the `--direct` backend (linking
 * `@lark/core` in-process); it is gated by R31 — while a daemon is alive,
 * direct WRITES are refused outright, because cross-process mutual exclusion
 * for playback / download / cache eviction does not exist.
 *
 * Commands receive the raw envelope so `--json` can print it verbatim.
 */
export interface Backend {
  status(): Promise<ApiResponse<StatusData>>;
}
