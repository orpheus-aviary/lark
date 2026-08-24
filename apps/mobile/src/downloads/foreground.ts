// When this process is allowed to keep working (N4c, §2.4 — the machine N4
// §2.6 froze).
//
// Android does not let an app keep a network transfer going in the background
// on its own say-so; it lets a FOREGROUND SERVICE do it. This file decides
// when that service is up, what its one notification says, and what happens
// when the system takes the permission back. `modules/lark-transfer` does the
// Kotlin half and knows nothing about downloads; this half knows nothing about
// Kotlin.
//
// PURE LOGIC, INJECTED WITH FOUR THINGS, and that is deliberate: two of the
// four edges here (the retreat with nothing enqueued, and cancelling
// everything on a quota expiry) are states a device reaches rarely and slowly.
// Reproducing them on the phone costs a build-install-tap cycle each;
// reproducing them here costs a second, which is the same trade `player/store.ts`
// took for its races.
//
// THE ONE THING THIS FILE MUST NOT DO IS FAIL A DOWNLOAD. A song lost because
// a notification would not appear is a worse outcome than a song downloaded
// without one, and pretending the service is up when it is not is worse than
// both — hence `degraded`, which is a state and not an error.

import type { DownloadTaskData } from '@lark/shared';
import { activeInSweepOrder, isActive } from './cancel';

/**
 * Five states. Three of them are the obvious ones; these two are not:
 *
 * - `arming` — the service has been asked for BUT NOTHING IS ENQUEUED YET.
 *   The gesture is the only moment Android is guaranteed to allow the start
 *   (§1.2), and between the tap and the first task there is a network
 *   preflight that takes seconds. Starting the service after it would be
 *   starting it from the background, which is exactly what is forbidden.
 * - `degraded` — the download is running with no service holding the process
 *   up. Recorded, never silent, and never a failure.
 *
 * `paused-by-system` is only ever visible inside the app: stopping the service
 * takes its notification with it, and there is no `expo-notifications` here to
 * say anything afterwards (N4 §1.9).
 */
export type ForegroundPhase = 'idle' | 'arming' | 'running' | 'degraded' | 'paused-by-system';

export interface ForegroundStatus {
  phase: ForegroundPhase;
  /**
   * The `code` behind a `degraded` phase, `null` in every other one.
   *
   * Three values, and they are three different stories. `ERR_LARK_FGS_NOT_ALLOWED`
   * is the system refusing out loud — a normal thing when the tap is followed
   * by a switch to another app. `ERR_LARK_FGS_NEVER_STARTED` is the system
   * refusing in silence, which is what vivo's Android 15 actually does
   * (N4c-3, MEASURED). Anything else means the module itself is wrong, and the
   * difference has to survive to a screen: a self-built Expo module that
   * silently does not exist is precisely how N4b lost an afternoon
   * (`docs/LESSONS.md`).
   */
  reason: string | null;
}

export const FOREGROUND_IDLE: ForegroundStatus = { phase: 'idle', reason: null };

/**
 * How long the service outlives its last task.
 *
 * Two downloads in a row are two tasks with a gap between them, and a
 * notification that vanishes and returns inside that gap reads as a bug. The
 * grace is cancelled the moment anything is queued again.
 */
const STOP_GRACE_MS = 2_000;

/**
 * Floor on how often the notification text is rewritten (decision c).
 *
 * Every rewrite is an IPC to the notification manager, and the engine already
 * throttles progress to one event per task per 500ms. Same drop-don't-queue
 * shape as `player/now-playing.ts`: a skipped update is not lost, because the
 * next event recomputes the current text and sends that.
 */
const NOTIFICATION_MIN_INTERVAL_MS = 1_000;

/**
 * How long after a successful `start()` the service is given to actually
 * appear.
 *
 * MEASURED, N4c-3: on vivo's Android 15 a `startForegroundService` from the
 * background is refused SILENTLY — no exception, no service. `start()`
 * resolving therefore means "the system took the request", not "the service is
 * up", and a state machine that believes the first one tells the user their
 * download is protected when it is not. Nobody waits on this check; it is a
 * second opinion that arrives late and only ever downgrades.
 */
const START_CONFIRM_MS = 2_000;

/** The reason behind a `degraded` the system announced by doing nothing at all. */
const NEVER_STARTED = 'ERR_LARK_FGS_NEVER_STARTED';

/** The notification's two halves. `N 首` is appended once there is an N. */
const DOWNLOADING = '正在下载';
/** What the body says before anything has been named. */
const PREPARING = '准备中…';

/** What the machine needs from `modules/lark-transfer`, and no more. */
export interface ForegroundService {
  start(title: string, body: string): Promise<void>;
  update(title: string, body: string): Promise<void>;
  stop(): Promise<void>;
  /** Is it up RIGHT NOW — which `start()` resolving does not answer. */
  isRunning(): Promise<boolean>;
}

export interface ForegroundDeps {
  service: ForegroundService;
  /** The hub: every engine callback goes through it (`hub.ts`). */
  subscribe(listener: () => void): () => void;
  getState(): { readonly tasks: readonly DownloadTaskData[] };
  /**
   * The engine, for the two things the hub cannot answer.
   *
   * `snapshot()` rather than `getState()` on the timeout path on purpose: when
   * the system takes the quota back, "everything" has to mean the engine's own
   * list at that instant, not a mirror of it that is one callback behind.
   */
  engine: {
    snapshot(): { readonly tasks: readonly DownloadTaskData[] };
    cancel(taskId: string): void;
  };
  /** Where the phase becomes readable — the hub (decision e). */
  publish(status: ForegroundStatus): void;
  now(): number;
  /** Run `fn` after `ms`; the returned function cancels it. */
  delay(ms: number, fn: () => void): () => void;
  /**
   * Is the app on screen? (`AppState`, 2026-08-24)
   *
   * Asked in exactly one place — see `whenNothingIsLeft` — because exactly one
   * decision here depends on a clock that does not run in the background.
   */
  appActive(): boolean;
}

export interface ForegroundController {
  status(): ForegroundStatus;
  /**
   * The gesture — the tap, before any network work. Never rejects: a service
   * that will not start is a degraded download, not a failed one.
   */
  arm(): Promise<void>;
  /**
   * The gesture's work is over, whatever came of it. Call it from a `finally`:
   * a preflight that threw enqueued nothing, and a service left `arming` with
   * nothing to do would hold this process up forever.
   */
  settle(): void;
  /** Wired to the module's `onTimeout` event. */
  handleTimeout(): Promise<void>;
  /** Tests only — the real one lives as long as the process. */
  dispose(): void;
}

const codeOf = (err: unknown): string =>
  err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : String(err);

/** The song the notification names: the one being worked on, else the next. */
function describe(active: readonly DownloadTaskData[]): string {
  const current = active.find((task) => task.state === 'running') ?? active[0];
  if (current === undefined) return PREPARING;
  if (current.title !== null && current.title !== '') return current.title;
  // A queued link genuinely has no name yet, and inventing one would be worse
  // than showing what the user typed (`DownloadTaskData.title`).
  const { input } = current;
  if (input.type === 'keyword') return input.query;
  if (input.type === 'url') return input.url;
  return PREPARING;
}

export function createForegroundController(deps: ForegroundDeps): ForegroundController {
  let status: ForegroundStatus = FOREGROUND_IDLE;
  /** False between the gesture and the caller telling us it is done. */
  let settled = true;
  let cancelStop: (() => void) | null = null;
  /** What the notification says, as far as we know, and when we said it. */
  let showing: string | null = null;
  let showingAt = 0;

  const move = (phase: ForegroundPhase, reason: string | null = null): void => {
    if (status.phase === phase && status.reason === reason) return;
    status = { phase, reason };
    deps.publish(status);
  };

  const clearPendingStop = (): void => {
    cancelStop?.();
    cancelStop = null;
  };

  const stopService = async (): Promise<void> => {
    clearPendingStop();
    showing = null;
    move('idle');
    // Called even from `degraded`, where by our own account the service never
    // started. It is idempotent, and N4b measured the case that makes it worth
    // the call: `start` rejected AFTER `startForegroundService` had already
    // taken effect, because the bridge could not convert its return value. A
    // service we believe is not running can be running.
    //
    // STOPPING DURING `arming` IS SAFE ON THE NATIVE SIDE, and that is where it
    // was made safe rather than here (N4f-2): a stop that reaches a service the
    // system has not created yet cancels a promise it is holding us to, and the
    // app is killed with `ForegroundServiceDidNotStartInTimeException`. The
    // module answers that case by asking the service to stop ITSELF once it has
    // called `startForeground` — so this state machine keeps saying what it
    // means, and does not need a delay it could not size anyway.
    await deps.service.stop();
  };

  const scheduleStop = (): void => {
    if (cancelStop !== null) return;
    cancelStop = deps.delay(STOP_GRACE_MS, () => {
      cancelStop = null;
      void stopService();
    });
  };

  const publishText = (active: readonly DownloadTaskData[]): void => {
    const title = `${DOWNLOADING} ${active.length} 首`;
    const body = describe(active);
    const text = `${title}\n${body}`;
    if (text === showing) return;
    const at = deps.now();
    if (at - showingAt < NOTIFICATION_MIN_INTERVAL_MS) return;
    void deps.service.update(title, body);
    showing = text;
    showingAt = at;
  };

  const whileWorking = (active: readonly DownloadTaskData[]): void => {
    clearPendingStop();
    // Two ifs and not an else: the second one is what puts the first text up in
    // the same pass that arms it.
    if (status.phase === 'arming') move('running');
    if (status.phase === 'running') publishText(active);
  };

  const whenNothingIsLeft = (): void => {
    if (status.phase === 'arming') {
      // The preflight is still going — nothing enqueued YET is not the same as
      // nothing to enqueue, and only the caller knows which.
      if (settled) void stopService();
      return;
    }
    if (status.phase === 'running' || status.phase === 'degraded') {
      // 🔴 A GRACE PERIOD PROTECTS AGAINST A SECOND TAP, AND A TAP NEEDS A
      // SCREEN (REPORTED from the device, 2026-08-24: the notification sat on
      // 「正在下载 1 首」 long after the last song had landed).
      //
      // `delay` is a JS timer and those do not fire while the app is away —
      // measured three times in this app (N0b-4a, N3f, N4c-3: 「用 JS 定时器
      // 安排『进入后台之后做某事』，测的是『回到前台之后做某事』」). The stop
      // was the ONE step in the whole download lifecycle that depended on one,
      // which is why everything else about a backgrounded download works and
      // only the ending hangs.
      //
      // Backgrounded there is nothing to protect: nobody can queue a second
      // download without coming back first, and the dataSync quota is a daily
      // budget worth handing back. So the grace applies on screen and nowhere
      // else.
      //
      // WHAT THIS DOES NOT FIX: the screen going off while lark is still the
      // foreground app. Android leaves `AppState` on `active` there, the timer
      // freezes anyway, and the notification clears a moment after the phone is
      // unlocked. Nobody is looking at a shade behind a locked screen, so the
      // residue is visible only in a dumpsys.
      if (deps.appActive()) scheduleStop();
      else void stopService();
    }
    // `paused-by-system` falls through on purpose: the system stopped this, and
    // an empty queue is the CONSEQUENCE, not a reason to call it idle.
  };

  /** The one reaction, from the hub and from `settle` alike. */
  const reconcile = (): void => {
    const active = deps.getState().tasks.filter(isActive);
    if (active.length > 0) whileWorking(active);
    else whenNothingIsLeft();
  };

  const cancelQuietly = (taskId: string): void => {
    try {
      deps.engine.cancel(taskId);
    } catch (err) {
      // Past the point of no return: it is seconds from finishing and nothing
      // here can hurry it. Letting that throw would abandon the sweep with the
      // tasks after it still running, which is the state the system just
      // forbade.
      if (codeOf(err) !== 'TASK_NOT_CANCELLABLE') throw err;
    }
  };

  /**
   * Which arming a late answer belongs to.
   *
   * A confirmation that arrives after the service was stopped and started
   * again would otherwise downgrade the CURRENT service on the strength of the
   * previous one.
   */
  let generation = 0;

  /** The second opinion (`START_CONFIRM_MS`). Only ever downgrades. */
  const confirmStarted = async (armed: number): Promise<void> => {
    if (armed !== generation) return;
    if (await deps.service.isRunning()) return;
    if (armed !== generation) return;
    // `idle` and `paused-by-system` are not downgraded: whatever the service
    // was doing, it is over, and saying "degraded" about a download that has
    // finished would be a warning about nothing.
    if (status.phase !== 'arming' && status.phase !== 'running') return;
    move('degraded', NEVER_STARTED);
  };

  const unsubscribe = deps.subscribe(reconcile);

  return {
    status: () => status,

    async arm(): Promise<void> {
      settled = false;
      // A tap during the grace period is the case this line exists for: the
      // stop would land two seconds later, in the middle of the preflight, and
      // take the service down just before the download it was armed for.
      clearPendingStop();
      // Already up, or on its way up. Re-entering the foreground state to say
      // so would restart the ten-second `startForeground` deadline for nothing.
      if (status.phase === 'running' || status.phase === 'arming') return;

      move('arming');
      generation += 1;
      const armed = generation;
      try {
        await deps.service.start(DOWNLOADING, PREPARING);
      } catch (err) {
        move('degraded', codeOf(err));
        return;
      }
      // It said yes. Ask again in a moment whether it meant it (see
      // START_CONFIRM_MS) — not awaited, because the caller's next move is a
      // preflight that has no reason to wait two seconds for a second opinion.
      deps.delay(START_CONFIRM_MS, () => {
        void confirmStarted(armed);
      });
    },

    settle(): void {
      settled = true;
      reconcile();
    },

    async handleTimeout(): Promise<void> {
      clearPendingStop();
      // BEFORE the cancels. Each one wakes `reconcile`, and a phase still
      // reading `running` when the last task goes would schedule a stop that
      // lands two seconds later and calls this state `idle` — the app would
      // forget it had been stopped by the system.
      move('paused-by-system');
      showing = null;

      // Scope and order come from `cancel.ts`, which is also what the screen's
      // 全部取消 sweeps (decision d): "everything" must not mean two different
      // sets. The error policy below stays HERE — a quota the system took back
      // is not a conversation, so anything but the commit point propagates.
      for (const task of activeInSweepOrder(deps.engine.snapshot().tasks)) cancelQuietly(task.id);

      // The service has usually stopped itself by now (`onTimeout` calls
      // `stopSelf`), and this is the one call that must not depend on having
      // won that race.
      await deps.service.stop();
    },

    dispose(): void {
      clearPendingStop();
      // Any confirmation still in flight belongs to a controller nobody reads.
      generation += 1;
      unsubscribe();
    },
  };
}
