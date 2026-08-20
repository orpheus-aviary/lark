// Decision e: the one audio event Android sends and nothing above us hears.
//
// See `android/src/main/java/expo/modules/larkaudio/LarkAudioModule.kt` for
// why this module exists. It is one event and no functions, deliberately —
// everything else about playback already has a home, and a native audio API
// growing beside expo-audio's would be a second one to keep in step.

import { NativeModule, requireNativeModule } from 'expo-modules-core';

// A `type` and not an `interface`: `EventsMap` is a `Record<string, …>`, and
// only a type alias gets the implicit index signature that satisfies it.
export type LarkAudioEvents = {
  /**
   * The audio route is about to leave the headphones or the Bluetooth sink.
   *
   * Fires BEFORE the change, which is the only reason acting on it works: a
   * player that pauses here never reaches the speaker. There is no matching
   * "reconnected" event and there should not be one — resuming is the user's
   * decision, the same way it is after a phone call.
   */
  onBecomingNoisy(): void;
};

declare class LarkAudioNativeModule extends NativeModule<LarkAudioEvents> {}

export default requireNativeModule<LarkAudioNativeModule>('LarkAudio');
