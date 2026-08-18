// Telling the front-ends something changed (N1a).
//
// `emit` and nothing else. The coordinator announces what a pull touched using
// the SAME event types the local write paths emit — a song that changed
// because another device edited it is not a different kind of change to a GUI
// — so this port carries `LarkEvent` rather than a sync-specific vocabulary.
//
// The daemon's `EventsBus` class satisfies it as-is (its `emit` returns a
// subscriber count, which is not this caller's business). A mobile client will
// hand over whatever its UI listens to.

import type { LarkEvent } from '@lark/shared';

export interface EventsBus {
  emit(event: LarkEvent): void;
}
