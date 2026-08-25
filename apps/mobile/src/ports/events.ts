// Where the coordinator's announcements go on this phone (N5c).
//
// The port carries `LarkEvent` — the SAME vocabulary the local write paths
// use, on purpose: a song that changed because another device edited it is not
// a different kind of change to a screen. The daemon fans these out over SSE
// to two front ends. Here there is one, in this process, and the fan-out is
// two function calls.
//
// `library-signal.ts` predicted this in N3c: "when sync lands it emits the
// same signal, and everything already listening reconciles itself." That is
// exactly what happens below — the list view rebuilds, and the player checks
// whether the song under its needle still exists.
//
// 🔴 ONE KNOWN GAP, recorded rather than papered over: `lyrics:changed` for the
// song PLAYING RIGHT NOW does not re-read its lyrics. The player loads lyrics
// when a song starts (`bindPlayer`'s `readLyrics`), and its library-change
// handler re-resolves the queue and the row but not the words. A peer editing
// the lyrics of the current song therefore shows up on the next play. The list
// refresh below is still correct and still worth doing; closing the other half
// belongs with the lyrics screen (N5e).

import type { EventsBus } from '@lark/core/portable';
import type { LarkEvent } from '@lark/shared';
import { libraryChanged } from '../library-signal';
import { refreshSync } from '../sync/hub';

/**
 * The two places an announcement can land on this phone.
 *
 * Injected so the mapping below can be tested at all: the real sinks reach
 * `library-signal` and the hub, and this file is the only thing in the app
 * that decides which event goes to which. That decision is a switch with
 * twelve arms and no observable effect on a screen — the worst possible shape
 * to verify by looking at a phone.
 */
export interface EventSinks {
  libraryChanged(): void;
  syncChanged(): void;
}

const REAL: EventSinks = { libraryChanged, syncChanged: refreshSync };

/**
 * The bus the coordinator writes to.
 *
 * Every arm is deliberate, including the ones that do nothing: the coordinator
 * emits five of these types today (`coordinator/runner.ts`), and the rest of
 * the union belongs to the daemon's wire protocol — `player:command` is
 * unicast to a GUI, the `download:*` family is the download hub's business and
 * reaches it through `EngineCallbacks` rather than here. Listing them is how
 * the next person can tell "not applicable" from "forgotten".
 */
export function createEvents(sinks: EventSinks = REAL): EventsBus {
  return {
    emit(event: LarkEvent): void {
      switch (event.type) {
        // A pull applied something. The rows on screen and the queue under the
        // player both have to meet what the library now says.
        case 'songs:changed':
        case 'playlists:changed':
        case 'lyrics:changed':
        case 'cache:evicted':
          sinks.libraryChanged();
          return;

        // The badge, the counts, and the sentence in the settings page.
        case 'sync:status_changed':
        case 'conflicts:changed':
          sinks.syncChanged();
          return;

        // Files were parked instead of deleted. NOTHING ON THIS PHONE EMITS
        // THIS YET: `FileEffectRuntime` announces it through an `onQuarantine`
        // option, and neither the boot assembly nor the engine's passes one
        // (the daemon does, in three places). The arm is here because the
        // count is not lost meanwhile — `quarantined_count` rides on the
        // status, and a round refreshes that at both ends — so wiring the
        // callback later changes WHEN a person finds out, not WHETHER.
        case 'sync:file_quarantined':
          sinks.syncChanged();
          return;

        // Not applicable here, and none of them is emitted by the coordinator:
        // `hello` opens an SSE stream this app does not have, `player:command`
        // is unicast to a desktop GUI, and the download family is delivered
        // straight to the hub by the engine it came from.
        case 'hello':
        case 'player:command':
        case 'download:status':
        case 'download:complete':
        case 'download:error':
        case 'download:cancelled':
        case 'download:batches-changed':
          return;
        default:
          // Compile-time exhaustiveness. A new member of `LarkEvent` stops the
          // build here rather than being silently dropped on the floor — which
          // is what an untyped `default: return` would have done, and the whole
          // reason the daemon-only arms above are spelled out one by one.
          event satisfies never;
          return;
      }
    },
  };
}
