// This phone's answer to "which host is running the coordinator" (N5c).
//
// N1f moved the session, the lifecycle mutex, login, logout, refresh, the
// round and the status into `@lark/core/portable`, leaving hosts with one job:
// fill in fifteen fields. The daemon's version of this file is
// `daemon/src/sync/coordinator.ts` and it is twenty lines. This one is longer
// only because six of the answers are worth explaining.
//
// NOTHING HERE STARTS ANYTHING. Building the context does not open a socket,
// arm a timer or read a credential — `SyncRuntime` begins with no session and
// `state = 'auth_required'`, and the triggers that would drive rounds are N5d.
// A context can therefore be assembled at boot, before anyone has logged in
// and on an install that never will.

import {
  type CoordinatorContext,
  type FileEffectRuntime,
  type PortableDb,
  SyncRuntime,
  realSkybridgeApi,
} from '@lark/core/portable';
import { SYNC_PULL_LIMIT_MOBILE } from '@lark/shared';
import Constants from 'expo-constants';
import type { BootResult } from '../boot/sequence';
import { engineLogger } from '../downloads/log';
import { libraryChanged } from '../library-signal';
import { player } from '../player';
import { createSecureCredentialStore } from '../ports/credentials';
import { deviceName } from '../ports/device';
import { createEvents } from '../ports/events';
import { attachSync, refreshSync } from './hub';
import { countQuarantined } from './quarantine';

/**
 * How often the clock trigger asks, in minutes (decision d).
 *
 * The desktop reads `[sync] interval_min` from a config file the phone does
 * not have and, per D12, is not getting — and a settings field for it would be
 * a knob whose effect is nearly invisible here. What actually keeps a phone
 * current is coming back to it: N5d's resume trigger runs a round every time
 * the app returns to the foreground, and this is the backstop for an app left
 * open on a table.
 */
export const SYNC_INTERVAL_MIN = 15;

export interface SyncContextDeps {
  db: PortableDb;
  files: BootResult['files'];
  /**
   * The journal runtime that SHARES THE DOWNLOAD ENGINE'S CLAIMS, which on
   * this phone is `downloadRuntimeOnce(boot).fileOps` and NOT `boot.fileOps`.
   *
   * This is the whole reason the dependency is passed in rather than taken off
   * `BootResult`. A remote delete executes by unlinking a song's audio; a
   * download executes by replacing it. The claim registry is what makes those
   * two take turns, and two runtimes holding two registries would arbitrate
   * against nobody. Boot's own runtime is correct for boot — it drains before
   * an engine exists — and wrong for everything that outlives it (`App.tsx`
   * already makes this exact choice for `LibraryService`).
   */
  fileOps: FileEffectRuntime;
}

let context: CoordinatorContext | null = null;

/**
 * The coordinator context this process gets, once, whatever the Activity does.
 *
 * Same shape as `bootOnce` and `downloadRuntimeOnce`, and the fourth time this
 * app has needed it. Here the cost of a second one would be a second
 * `SyncRuntime`: two sessions, two epoch counters and two lifecycle mutexes
 * over one library, which is precisely the interleaving the mutex exists to
 * prevent.
 */
export function syncContextOnce(deps: SyncContextDeps): CoordinatorContext {
  context ??= build(deps);
  return context;
}

function build(deps: SyncContextDeps): CoordinatorContext {
  const ctx: CoordinatorContext = {
    sync: new SyncRuntime(),
    db: deps.db,
    files: deps.files,
    // The app's recent-error ring, shared with the download engine and the
    // cache (`downloads/log.ts`). Release builds do not reach logcat, so a
    // sync failure that is not in that ring is a sync failure with no
    // explanation anywhere. ⚠️ It carries RAW errors, and a sync error can
    // carry the server URL — see that file's exposure note.
    logger: engineLogger,
    credentials: createSecureCredentialStore(),
    // The composition root's job: `ports/events.ts` decides WHICH sink an
    // event goes to, and this is the only place that knows what the sinks
    // actually are. Wiring them there would drag expo-audio into a module the
    // test config has to be able to load (see that file).
    events: createEvents({
      libraryChanged,
      syncChanged: refreshSync,
      lyricsChanged: (songId) => player.refreshLyrics(songId),
    }),
    now: Date.now,
    deviceName,
    api: realSkybridgeApi,
    fileOps: deps.fileOps,
    countQuarantined,
    intervalMin: () => SYNC_INTERVAL_MIN,
    // 200, not the desktop's 500 (R5). ⚠️ That number was measured on an idle
    // device; the N1 freeze text says N5 must re-measure it against real
    // rendering and playback and drop to 100 if it misses the 100ms budget
    // (criterion 76). Changing it is changing this constant and nothing else —
    // it has no protocol meaning.
    pullLimit: SYNC_PULL_LIMIT_MOBILE,
    version: appVersion(),
  };
  attachSync(ctx);
  return ctx;
}

/**
 * What this build reports when it registers a device.
 *
 * D14's independent APK version line, read from the embedded config rather
 * than hard-coded — a string that has to be edited in two places is a string
 * that will disagree with itself.
 *
 * Exported since N7e: a login that installs into ANOTHER workspace builds its
 * own throwaway context and must report the same version this one does.
 */
export function appVersion(): string {
  const version = Constants.expoConfig?.version;
  return typeof version === 'string' && version !== '' ? version : '0.0.0';
}
