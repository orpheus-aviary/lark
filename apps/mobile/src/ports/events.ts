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
// `lyrics:changed` goes to BOTH: the library signal rebuilds the list, and the
// player re-reads the words if that song is the one under the needle. The
// second half was N5c's known gap — the player loads lyrics exactly once, when
// a song starts, so a peer's edit to the current song would otherwise appear
// only the next time it played.

import type { EventsBus } from '@lark/core/portable';
import type { LarkEvent } from '@lark/shared';

/**
 * The three places an announcement can land on this phone.
 *
 * REQUIRED, not defaulted, and that is the whole design of this file. The real
 * sinks reach the library signal, the sync hub and the PLAYER — and the player
 * imports expo-audio, so a default wired up here would make this module
 * unloadable by `vitest.config.ts`'s allowlist and take the mapping below out
 * of reach with it. That mapping is a switch with twelve arms and no
 * observable effect on any screen: the worst possible thing to verify by
 * looking at a phone.
 *
 * Same lesson as N5d's `AppState`, met a second time: the wiring belongs to
 * the composition root (`sync/context.ts`), the decision stays here.
 */
export interface EventSinks {
  libraryChanged(): void;
  syncChanged(): void;
  lyricsChanged(songId: string): void;
}

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
export function createEvents(sinks: EventSinks): EventsBus {
  return {
    emit(event: LarkEvent): void {
      switch (event.type) {
        // A pull applied something. The rows on screen and the queue under the
        // player both have to meet what the library now says.
        case 'songs:changed':
        case 'playlists:changed':
        case 'cache:evicted':
          sinks.libraryChanged();
          return;

        // Both, and in this order: the row on the list first, then the words
        // on the player if that song happens to be playing.
        case 'lyrics:changed':
          sinks.libraryChanged();
          sinks.lyricsChanged(event.song_id);
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
