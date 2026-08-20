package expo.modules.larkaudio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * `ACTION_AUDIO_BECOMING_NOISY`, and nothing else (decision e, criterion 19).
 *
 * Android sends this broadcast just BEFORE the audio route changes away from
 * headphones or a Bluetooth sink — it is the system telling every player "what
 * you are about to play, you are about to play out loud". Ignoring it is how a
 * phone in a pocket starts broadcasting to a bus, and on the frozen device
 * that is exactly what happens: N0b-4b measured the old AudioTrack going
 * `paused` while a new one on `deviceId:3` (the speaker) went `started`.
 *
 * WHY THIS IS OURS TO CARRY. media3 already knows how to do the right thing —
 * `setHandleAudioBecomingNoisy(true)` — but it defaults to off, expo-audio
 * never turns it on and exposes no way to, and React Native has no
 * becoming-noisy event. The three layers above us are each silent for a
 * different reason, so the broadcast has to be received here.
 *
 * THE PAUSE IS NOT DONE HERE. This module has no player and should not get
 * one: what "pause" means — which driver, which lane, what the UI then says —
 * is the store's, and a native shortcut around it would be a second thing that
 * can stop playback without the store knowing. So this emits an event and
 * stops. The cost is a hop through JS, which is microseconds against a route
 * change; the benefit is one place that decides what playing means.
 */
class LarkAudioModule : Module() {
  private var receiver: BroadcastReceiver? = null

  override fun definition() = ModuleDefinition {
    Name("LarkAudio")

    Events(BECOMING_NOISY)

    // Registered for the life of the module rather than only while something
    // plays. A receiver that has to be turned on and off is a receiver that
    // can be off at the moment it matters — and when nothing is playing the
    // event costs a no-op in the store, which is cheaper than the bookkeeping
    // that would keep the two states in step.
    OnCreate {
      val context = appContext.reactContext ?: return@OnCreate
      val listener = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
          if (intent?.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
          this@LarkAudioModule.sendEvent(BECOMING_NOISY)
        }
      }
      val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
      // `RECEIVER_NOT_EXPORTED` from API 33. This one is a protected system
      // broadcast, so the flag is not required even at targetSdk 34+ — it is
      // here because "only the system may reach this receiver" is true, and a
      // registration that says what it means does not need the exemption
      // looked up again later.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.registerReceiver(listener, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        context.registerReceiver(listener, filter)
      }
      receiver = listener
    }

    OnDestroy {
      val listener = receiver ?: return@OnDestroy
      // Cleared BEFORE the unregister, not after: expo-sqlite 57.0.1 taught
      // this library that a teardown which throws halfway leaves a field
      // pointing at something already gone (N2f). `unregisterReceiver` throws
      // when the context has moved on, and a second OnDestroy must then find
      // nothing to do rather than the same stale listener.
      receiver = null
      runCatching { appContext.reactContext?.unregisterReceiver(listener) }
    }
  }

  private companion object {
    const val BECOMING_NOISY = "onBecomingNoisy"
  }
}
