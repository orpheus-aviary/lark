// Criterion 24 — can another app hand lark a bilibili link (D13).
//
// The whole judgement is about the PLATFORM half: does an ACTION_SEND from
// somebody else's app reach our JS, and does the raw text survive the trip
// intact. What that text MEANS — which characters are the bvid, whether there
// is a `?p=` on it — is `link.ts`'s job, and `link.ts` is Node-only until N1
// ports it (guard: `check-spike-mobile-imports.sh`). So this panel records the
// text verbatim and does not parse a single character of it; R2 replays these
// recordings through the real parser.
//
// Two arrival paths, and they are different code inside the module:
//
//   - **cold**: the app was not running. Android starts MainActivity with the
//     intent, `ExpoShareIntentReactActivityLifecycleListener.onCreate` parks it
//     in a singleton, and nothing happens until JS mounts and asks for it. If
//     the hook were mounted late (behind a splash, a router, a provider) the
//     intent would sit there unread — which is why the README insists the hook
//     goes in the top component, and why this panel's hook is called from
//     `App` itself.
//   - **warm**: the app is alive. `android:launchMode="singleTask"` (also the
//     plugin's doing) makes Android deliver it to the existing activity through
//     `onNewIntent`, instead of starting a second copy of the app.
//
// Every arrival is appended to a log that the panel keeps itself, because the
// hook's own value is transient: with `resetOnBackground` (the library default,
// left alone here) leaving the app clears it. The log is also what gets POSTed
// to the desktop probe host — on a release build, a payload that only exists on
// screen exists nowhere.

import { ShareIntentModule, getScheme, useShareIntent } from 'expo-share-intent';
import { useEffect, useRef, useState } from 'react';
import { BUILD_IS_DEV, RUNTIME_LABEL } from '../measure';
import { reportToHost } from '../report';

export interface ShareIntentArrival {
  /** Wall clock, so a recording can be lined up with `adb logcat` / the host log. */
  at: number;
  /**
   * Milliseconds since this JS context started.
   *
   * The cold-start evidence: a share that launched the app arrives within a
   * second or so of the bundle running, a warm one arrives minutes later.
   */
  sinceStartMs: number;
  /**
   * Raw `performance.now()`, kept because of what it turned out to be.
   *
   * MEASURED (N0b-4c): on RN Android this is `SystemClock.uptimeMillis()` — not
   * zero at context start, and it does NOT advance while the device is in deep
   * sleep. The first arrival read 81,892s against a `/proc/uptime` of 130,488s;
   * the ~13.5h gap is the night the phone spent asleep. N0b-3's timings are
   * deltas over a few milliseconds and are unaffected, but anything that wants
   * "how long since X" across a screen-off period cannot ask this clock.
   */
  uptimeMs: number;
  type: string | null;
  /** VERBATIM. Not trimmed, not parsed, not normalised. */
  text: string | null;
  /** The library's own extraction — recorded for comparison, never relied on. */
  webUrl: string | null;
  title: string | null;
  files: { fileName: string; mimeType: string; path: string; size: number | null }[] | null;
}

export interface ShareIntentRow {
  name: string;
  ok: boolean | null;
  detail: string;
}

export interface ShareIntentProbe {
  rows: ShareIntentRow[];
  arrivals: ShareIntentArrival[];
  /** Clears the native side too — the button exists to set up the next test. */
  reset: () => void;
}

/**
 * Module constant: `useShareIntent` puts `options.disabled` in effect
 * dependency arrays, and a fresh object every render is a fresh subscription
 * every render.
 *
 * `debug` only ever reaches logcat on a debug build (N0b-3): on release the
 * panel and the probe host are the record.
 */
const OPTIONS = { debug: true } as const;

/**
 * When this bundle started running, in the units of the only clock available.
 *
 * Module scope is as close to "JS start" as anything here gets: `index.ts`
 * imports `App`, which imports this. Subtracting it is what turns
 * `performance.now()` (see `uptimeMs`) into an age.
 */
const JS_START = performance.now();

export function useShareIntentProbe(): ShareIntentProbe {
  const { isReady, hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntent(OPTIONS);
  const [arrivals, setArrivals] = useState<ShareIntentArrival[]>([]);
  // The hook hands out a new object per delivery, so identity is the honest
  // "have I already written this one down" test — comparing text would collapse
  // two shares of the same video into one.
  const lastLogged = useRef<unknown>(null);

  // Syncing an external system's deliveries into our own append-only record is
  // exactly what an effect is for; the POST is part of the same job.
  useEffect(() => {
    if (!hasShareIntent) return;
    if (lastLogged.current === shareIntent) return;
    lastLogged.current = shareIntent;

    const arrival: ShareIntentArrival = {
      at: Date.now(),
      sinceStartMs: Math.round(performance.now() - JS_START),
      uptimeMs: Math.round(performance.now()),
      type: shareIntent.type,
      text: shareIntent.text ?? null,
      webUrl: shareIntent.webUrl,
      title: shareIntent.meta?.title ?? null,
      files:
        shareIntent.files?.map((f) => ({
          fileName: f.fileName,
          mimeType: f.mimeType,
          path: f.path,
          size: f.size,
        })) ?? null,
    };
    setArrivals((previous) => [...previous, arrival]);
    reportToHost('share-intent', {
      runtime: RUNTIME_LABEL,
      dev: BUILD_IS_DEV,
      arrival,
      // The count makes a lost POST visible: gaps in the sequence are gaps in
      // the evidence, not in the platform.
      index: arrivals.length,
    });
  }, [hasShareIntent, shareIntent, arrivals.length]);

  const rows: ShareIntentRow[] = [
    {
      name: 'native module present',
      // `requireOptionalNativeModule` returns null when the module is not in
      // the build — which is precisely how a release APK that forgot the
      // plugin would behave: a panel that renders fine and never receives
      // anything.
      ok: ShareIntentModule != null,
      detail:
        ShareIntentModule == null
          ? 'ExpoShareIntentModule not found — the plugin is not in this build'
          : 'ExpoShareIntentModule resolved',
    },
    {
      name: 'hook ready',
      ok: isReady,
      detail: isReady ? 'listeners attached' : 'not ready',
    },
    {
      name: 'scheme from expo-constants',
      ok: getScheme({}) === 'larkspike',
      detail: `getScheme() = ${String(getScheme({}))}`,
    },
    {
      name: 'arrivals',
      ok: arrivals.length > 0 ? true : null,
      detail:
        arrivals.length === 0
          ? 'nothing received yet — share something to "lark spike"'
          : `${arrivals.length} received${hasShareIntent ? ' · one is current' : ' · none current (reset or backgrounded)'}`,
    },
  ];

  if (error !== null) {
    rows.push({ name: 'hook error', ok: false, detail: error });
  }

  return {
    rows,
    arrivals,
    reset: () => {
      resetShareIntent();
    },
  };
}
