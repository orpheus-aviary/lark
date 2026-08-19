// Decision a: the one filesystem operation Expo cannot do on Android.
//
// See `android/src/main/java/expo/modules/larkfs/LarkFsModule.kt` for why this
// module exists at all. It was deliberately one function — a bigger native
// surface would be a second filesystem API to keep in step with
// expo-file-system's, and everything else `FileSystemPort` needs already
// exists there.
//
// It is now two, and the second one earned it by measurement rather than by
// convenience: there is no JS way to obtain — or create — the app's external
// files directory, and the acceptance fixture channel needs Android to make
// that directory as this app before `adb push` can put a library in it
// (N2f; the module's own comment carries the probe output).

import { requireNativeModule } from 'expo-modules-core';

interface LarkFsNativeModule {
  /**
   * Rename `from` onto `to`, replacing it, with no window in which `to` is
   * absent. Throws rather than degrading if the platform cannot promise it.
   *
   * Both arguments may be `file://` URIs or plain paths.
   */
  moveAtomic(from: string, to: string): Promise<void>;

  /**
   * Make `<external files>/<name>` and answer its `file://` URI — the
   * acceptance fixture channel's only way in (decision o④).
   *
   * It CREATES rather than looks up, and both halves have to be native: expo
   * decides write permission by whether the path already exists, so a
   * directory this app is entitled to make cannot be made from JS.
   *
   * Synchronous: it is a path and an `mkdirs`, and every caller is a fixture
   * step with nothing else to do while it waits.
   */
  externalDirectory(name: string): string;
}

export default requireNativeModule<LarkFsNativeModule>('LarkFs');
