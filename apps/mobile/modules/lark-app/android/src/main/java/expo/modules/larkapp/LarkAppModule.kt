package expo.modules.larkapp

import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.system.exitProcess

/**
 * The app PROCESS, as JS can reach it. Two things, and what they have in
 * common is that neither is about a file, a player or a service — they are
 * about the runtime this app happens to be inside.
 *
 * ── `quit` — end this process, the way swiping the app out of Recents does
 * (N7g-2).
 *
 * WHY IT IS NATIVE. Switching libraries takes effect at the next launch —
 * `switchWorkspace` writes one line and deliberately touches nothing else — so
 * something has to end this launch. React Native's `BackHandler.exitApp()`
 * only finishes the Activity, and the JS runtime is scoped to the Application,
 * not to it: `bootOnce`'s memoised promise and `ports/paths.ts`'s workspace
 * cache both outlive an Activity. Reopening would hand back the library the
 * switch just moved away from, which looks exactly like a switch that silently
 * did nothing. expo-sqlite's cached native handles are the same story one
 * layer down, and are why `bootOnce` exists at all.
 *
 * `finishAndRemoveTask()` before the exit so the task card goes too — the app
 * has to come back cold, and a card left behind is an invitation to resume a
 * process that is not there.
 *
 * ⚠️ IT NEVER RESOLVES. The promise is gone with the heap that held it; the JS
 * side documents that and callers must not put anything after the `await`.
 */
class LarkAppModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LarkApp")

    // `AsyncFunction` so the call does not block the JS thread while the UI
    // thread tears the task down — and so the caller can await the last render
    // it wants on screen. The body hops to the main looper itself, because
    // `finishAndRemoveTask` is an Activity call and Expo dispatches async
    // functions off the main thread.
    AsyncFunction("quit") {
      val activity = appContext.activityProvider?.currentActivity
      Handler(Looper.getMainLooper()).post {
        activity?.finishAndRemoveTask()
        // Not `Process.killProcess(myPid())`: `exitProcess` runs the JVM's
        // shutdown hooks first, which is what lets anything holding a file
        // close it rather than being shot mid-write.
        exitProcess(0)
      }
    }

    /**
     * ── `delay` — a wait a dark screen cannot freeze (0.1.1 ⑪).
     *
     * 🔴 MEASURED, 2026-08-26, frozen device: `await sleep(300)` inside the
     * player's teardown took **63 537ms**. React Native's JS timers ride the
     * Choreographer, which stops with the display — so the one 300ms wait
     * between "pause the finished song" and "release it" held the whole
     * auto-advance until the phone was UNLOCKED. Everything else on that path
     * was already native and arrived on time: the end-of-song event, the queue
     * decision, the pause itself.
     *
     * A `Handler` on the main looper and not a coroutine, for the same reason
     * `quit` uses one: it is the primitive this module already depends on, and
     * a delayed message is delivered by the looper's own queue, which has
     * nothing to do with whether anything is being drawn.
     *
     * NOT CANCELLABLE, deliberately: the one caller waits out a fixed settle,
     * and the watchdog beside it is idempotent on the JS side. A cancel token
     * would be a second thing to get wrong for no caller that wants it.
     */
    AsyncFunction("delay") { ms: Int, promise: Promise ->
      Handler(Looper.getMainLooper())
        .postDelayed({ promise.resolve(null) }, ms.toLong().coerceAtLeast(0L))
    }
  }
}
