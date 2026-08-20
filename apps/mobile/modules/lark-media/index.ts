// Decision b: reading a landed file's duration with MediaMetadataRetriever.
//
// See `android/src/main/java/expo/modules/larkmedia/LarkMediaModule.kt` for why
// this is native and why it is MMR. One function, like `modules/lark-fs`: a
// bigger native surface would be a second media API to keep in step with
// expo-audio's, and the landing needs exactly this one thing that JS cannot do.

import { requireNativeModule } from 'expo-modules-core';

interface LarkMediaNativeModule {
  /**
   * The duration in seconds of the audio file at `path`, read with
   * MediaMetadataRetriever. Rejects if the file cannot be decoded — which is
   * what a truncated or empty download looks like, and the signal the landing
   * turns into "do not commit" (§1.4). Does not touch audio focus, so it never
   * disturbs playback (criterion 9).
   *
   * `path` may be a `file://` URI or a plain path.
   */
  readDurationSeconds(path: string): Promise<number>;
}

export default requireNativeModule<LarkMediaNativeModule>('LarkMedia');
