package expo.modules.larkfs

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class MoveFailedException(from: String, to: String, cause: Throwable) :
  CodedException("ERR_LARK_FS_MOVE", "could not move $from onto $to: ${cause.message}", cause)

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
  }

  /**
   * The JS side speaks `file://` URIs, because everything else it holds comes
   * from expo-file-system. `java.io.File` does not.
   */
  private fun stripScheme(value: String): String =
    if (value.startsWith("file://")) value.removePrefix("file://") else value
}
