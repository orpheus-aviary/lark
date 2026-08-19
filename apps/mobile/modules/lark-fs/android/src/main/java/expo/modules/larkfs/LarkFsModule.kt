package expo.modules.larkfs

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class MoveFailedException(from: String, to: String, cause: Throwable) :
  CodedException("ERR_LARK_FS_MOVE", "could not move $from onto $to: ${cause.message}", cause)

class ExternalStorageUnavailableException :
  CodedException("ERR_LARK_FS_NO_EXTERNAL", "this device has no external files directory", null)

/**
 * One function, wrapping `AtomicMove.atomic` — which lives next door so the
 * instrumentation test drives the production code rather than a copy of it.
 *
 * `AsyncFunction`, so the move runs on Expo's background dispatcher rather
 * than on the JS thread. That is a responsiveness decision and NOT a
 * verification mechanism: criterion 10① is answered by the instrumentation
 * test next door, which runs a reader thread against both this and a
 * deliberately non-atomic mutant.
 *
 * API 26+ (NIO). `app.config.ts` sets `minSdkVersion: 26` for this reason —
 * expo-file-system's own module is `@RequiresApi(O)` anyway.
 */
class LarkFsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LarkFs")

    AsyncFunction("moveAtomic") { from: String, to: String ->
      val source = File(stripScheme(from))
      val target = File(stripScheme(to))
      try {
        AtomicMove.atomic(source, target)
      } catch (cause: Throwable) {
        throw MoveFailedException(from, to, cause)
      }
    }

    /**
     * Make `<external files>/<name>` and answer its `file://` URI — the only
     * channel that can carry a real desktop library onto the phone
     * (decision o④).
     *
     * MEASURED TWICE, and the reason this module grew a second function after
     * promising not to.
     *
     * ① Constructing the path in JS
     * (`/storage/emulated/0/Android/data/<package>/files`) produces the right
     * string and an unreadable directory: `adb push` creates the intermediate
     * directories as `shell`, and the app is then denied at `Android/data` —
     * the visibility probe answered `0✓/Android✓/data✗/<package>✗/files✗`.
     *
     * ② Asking Android for the path and then creating the child from JS fails
     * too: expo's permission service decides by `File(path).canWrite()` on the
     * path ITSELF (`FilePermissionService.kt`), and a directory that does not
     * exist yet is not writable — "Missing 'WRITE' permission" for a place
     * this app is entitled to make.
     *
     * So both halves are native. `getExternalFilesDir` makes the app-owned
     * root, `mkdirs` makes the child, and everything expo touches afterwards
     * already exists and reads back.
     *
     * Only the acceptance graph reaches it. Production has no fixtures.
     */
    Function("externalDirectory") { name: String ->
      val root = appContext.reactContext?.getExternalFilesDir(null)
        ?: throw ExternalStorageUnavailableException()
      val dir = File(root, name)
      dir.mkdirs()
      "file://${dir.absolutePath}"
    }
  }

  /**
   * The JS side speaks `file://` URIs, because everything else it holds comes
   * from expo-file-system. `java.io.File` does not.
   */
  private fun stripScheme(value: String): String =
    if (value.startsWith("file://")) value.removePrefix("file://") else value
}
