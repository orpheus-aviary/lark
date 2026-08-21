package expo.modules.larktransfer

import android.app.ForegroundServiceStartNotAllowedException
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Raised when the system refuses to start the service (subplan §2.4).
 *
 * The caller's answer to this is NOT to fail the download. Android 12+ forbids
 * starting a foreground service from the background, and the moment that bites
 * is a user who tapped download and then switched apps while the preflight was
 * still going. Losing the song over a missing notification would be the worse
 * trade; so would pretending it worked. The state machine records a degraded
 * state and downloads anyway.
 */
class ForegroundNotAllowedException(cause: Throwable) :
  CodedException("ERR_LARK_FGS_NOT_ALLOWED", "the system would not start the download service", cause)

/**
 * Start, retitle and stop the dataSync foreground service (N4c, decision e).
 *
 * Four functions and one event, and nothing about downloads: which tasks exist,
 * when to start and when to stop are `downloads/foreground.ts`'s business. This
 * is the part of it that only Kotlin can do.
 */
class LarkTransferModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "no android context" }

  override fun definition() = ModuleDefinition {
    Name("LarkTransfer")

    Events("onTimeout")

    OnCreate {
      // The service has no handle on this module, so the bridge is a static it
      // sets and we fill. Registered once per module instance; a second create
      // simply replaces the lambda.
      LarkTransferService.onQuotaExpired = { sendEvent("onTimeout", mapOf<String, Any>()) }
    }

    OnDestroy {
      LarkTransferService.onQuotaExpired = null
    }

    AsyncFunction("start") { title: String, body: String ->
      val intent =
        Intent(context, LarkTransferService::class.java).apply {
          putExtra(LarkTransferService.EXTRA_TITLE, title)
          putExtra(LarkTransferService.EXTRA_BODY, body)
        }
      // The `Unit` at the end is load bearing (MEASURED): an AsyncFunction's
      // last expression IS its return value, and `startForegroundService`
      // returns a `ComponentName`, which the bridge cannot convert. The call
      // then rejects with "Unknown type: class android.content.ComponentName"
      // AFTER the service has already started — a rejection that looks like
      // "the service would not start" and is the opposite of the truth.
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      } catch (cause: Throwable) {
        // `ForegroundServiceStartNotAllowedException` only exists from API 31,
        // so the class reference is guarded rather than the catch. Anything
        // else is a real failure and keeps its own identity.
        if (
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
          cause is ForegroundServiceStartNotAllowedException
        ) {
          throw ForegroundNotAllowedException(cause)
        }
        throw cause
      }
      Unit
    }

    /**
     * Replace the text under the same id. Deliberately NOT another
     * `startForegroundService`: re-entering the foreground state to change a
     * string would restart the ten-second clock for no reason.
     */
    AsyncFunction("update") { title: String, body: String ->
      if (!LarkTransferService.running) return@AsyncFunction
      TransferNotification.ensureChannel(context)
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.notify(TransferNotification.ID, TransferNotification.build(context, title, body))
    }

    /** Idempotent: stopping a service that never started is not an error. */
    AsyncFunction("stop") {
      // `stopService` returns a Boolean the caller has no use for, and the
      // bridge would hand it to JS as the resolution value. Same reason as
      // `start`'s trailing Unit, one type luckier.
      context.stopService(Intent(context, LarkTransferService::class.java))
      Unit
    }

    AsyncFunction("isRunning") { LarkTransferService.running }
  }
}
