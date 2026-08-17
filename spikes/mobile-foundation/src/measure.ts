// The measurement protocol (subplan §3.2a), in one place so every numeric
// criterion answers to the same rules:
//
//   - 3 warmup rounds, discarded;
//   - at least 10 measured rounds;
//   - p50/p95 by NEAREST RANK — `ceil(p/100 * n)`, no interpolation, so a
//     reported p95 is always a sample that actually happened;
//   - cold-start work is judged by MAX over 5 rounds instead of a percentile,
//     because a user gets the one cold start they are having, not the median
//     of ten.
//
// RELEASE BUILDS ONLY. A debug build measures the debugger; its numbers are for
// development and never for a judgement.

/** True when the clock below is `performance.now()` rather than `Date.now()`. */
const HIGH_RESOLUTION_CLOCK = typeof globalThis.performance?.now === 'function';

/**
 * Which JS is running — and it is not the same question as which APK is.
 *
 * A release APK built here still contains `expo-dev-client`, and `expo
 * run:android --variant release` launches it pointing at the dev server: if
 * Metro is up, a "release build" happily runs the DEBUG bundle. `__DEV__` is
 * baked into the bundle at build time, so it answers the question the APK
 * cannot.
 *
 * Everything numeric refuses to render a verdict while this is true (§3.2a:
 * dev numbers are for development). A measurement that cannot tell you which
 * bundle produced it is worse than no measurement, because it looks the same.
 */
export const BUILD_IS_DEV: boolean = typeof __DEV__ !== 'undefined' && __DEV__ === true;

const ON_HERMES: boolean =
  (globalThis as { HermesInternal?: unknown }).HermesInternal !== undefined;

/** One line, attached to every reported result and shown above every number. */
export const RUNTIME_LABEL = `${BUILD_IS_DEV ? 'DEV bundle — NOT a judgement' : 'release bundle'} · ${
  ON_HERMES ? 'Hermes' : 'not Hermes'
} · ${HIGH_RESOLUTION_CLOCK ? 'performance.now()' : 'Date.now() (LOW RESOLUTION)'}`;

/** Verdicts are only allowed to exist on a release bundle. */
export function judge(verdict: boolean): boolean | null {
  return BUILD_IS_DEV ? null : verdict;
}

/** The one clock. Exported for passes that collect their own samples. */
export const now: () => number = HIGH_RESOLUTION_CLOCK
  ? () => globalThis.performance.now()
  : () => Date.now();

const clock = now;

/** Rounds discarded before a measurement starts counting (§3.2a). */
export const WARMUP_ROUNDS = 3;
/** Rounds a measurement counts (§3.2a: at least ten). */
export const MEASURED_ROUNDS = 10;

export interface Timing {
  label: string;
  /** Measured rounds, warmup excluded. */
  samples: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
}

/**
 * Nearest-rank percentile: the smallest sample that at least `p` percent of
 * samples are less than or equal to.
 */
function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(Math.max(rank, 1), sortedAsc.length) - 1];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Summarize samples collected elsewhere (a pass that yields one per segment). */
export function summarize(label: string, samples: readonly number[]): Timing {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, n) => sum + n, 0);
  return {
    label,
    samples: sorted.length,
    p50: round2(percentile(sorted, 50)),
    p95: round2(percentile(sorted, 95)),
    min: round2(sorted[0] ?? Number.NaN),
    max: round2(sorted[sorted.length - 1] ?? Number.NaN),
    mean: round2(sorted.length === 0 ? Number.NaN : total / sorted.length),
  };
}

export interface MeasureOptions {
  warmup?: number;
  rounds?: number;
  /** Untimed setup for the round about to run. */
  before?: (round: number) => void;
  /** Untimed restore, so the next round starts from the same state. */
  after?: (round: number) => void;
}

/**
 * Run `body` under the protocol and report the timing.
 *
 * `before`/`after` are deliberately outside the measured window: a round that
 * had to rebuild its fixture would be reporting the fixture.
 */
export function measure(label: string, body: () => void, options: MeasureOptions = {}): Timing {
  const warmup = options.warmup ?? WARMUP_ROUNDS;
  const rounds = options.rounds ?? MEASURED_ROUNDS;
  const samples: number[] = [];

  for (let i = 0; i < warmup + rounds; i += 1) {
    options.before?.(i);
    const started = clock();
    body();
    const elapsed = clock() - started;
    options.after?.(i);
    if (i >= warmup) samples.push(elapsed);
  }

  return summarize(label, samples);
}

/**
 * Cold-start form: fewer rounds, judged by the worst one.
 *
 * The protocol says 5 rounds and max, which is why this is a separate entry
 * point rather than an options flag — the two judgements should not be a
 * default away from each other.
 */
export function measureColdStart(
  label: string,
  body: () => void,
  options: Omit<MeasureOptions, 'warmup' | 'rounds'> = {},
): Timing {
  return measure(label, body, { ...options, warmup: 0, rounds: 5 });
}

/**
 * Average of `iterations` back-to-back calls, in milliseconds.
 *
 * For operations far below the clock's resolution, where per-call samples would
 * all read 0 and a p95 of 0 says nothing. Reported ALONGSIDE the per-call
 * timing, never instead of it: the criterion is about one call.
 */
export function batchAverage(body: () => void, iterations: number): number {
  const started = clock();
  for (let i = 0; i < iterations; i += 1) body();
  const perCall = (clock() - started) / iterations;
  // Four decimals: the whole point is a number that is not 0.
  return Math.round(perCall * 10_000) / 10_000;
}
