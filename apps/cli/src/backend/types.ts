import type { ApiResponse, StatusData } from '@lark/shared';

/**
 * What a command may call, independent of how it reaches the data.
 *
 * Two backends implement it: HTTP (the default, talking to a running daemon)
 * and `--direct` (linking `@lark/core` in-process, from T3). The mode matrix in
 * `resolve.ts` decides which one a given command gets, and R31 is the rule that
 * shapes it: while OUR daemon is alive, a direct WRITE is refused outright,
 * because cross-process mutual exclusion for playback / downloads / cache
 * eviction lives in the daemon and nowhere else.
 *
 * Commands receive the raw envelope, never a plucked-out payload, so `--json`
 * can print exactly what the daemon said — `message` and `total` included.
 *
 * The interface grows one batch at a time, alongside the commands that need
 * it; the direct backend answers anything it does not implement with
 * `USAGE_ERROR` rather than a half-working approximation (M6-5).
 */
export interface Backend {
  status(): Promise<ApiResponse<StatusData>>;
}
