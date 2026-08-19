// Decision a: the one filesystem operation Expo cannot do on Android.
//
// See `android/src/main/java/expo/modules/larkfs/LarkFsModule.kt` for why this
// module exists at all. It is deliberately one function — a bigger native
// surface would be a second filesystem API to keep in step with
// expo-file-system's, and everything else `FileSystemPort` needs already
// exists there.

import { requireNativeModule } from 'expo-modules-core';

interface LarkFsNativeModule {
  /**
   * Rename `from` onto `to`, replacing it, with no window in which `to` is
   * absent. Throws rather than degrading if the platform cannot promise it.
   *
   * Both arguments may be `file://` URIs or plain paths.
   */
  moveAtomic(from: string, to: string): Promise<void>;
}

export default requireNativeModule<LarkFsNativeModule>('LarkFs');
