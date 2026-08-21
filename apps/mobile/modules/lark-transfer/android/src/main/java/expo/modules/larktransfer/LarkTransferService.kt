package expo.modules.larktransfer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/** One channel, one notification id, one way to build it. */
object TransferNotification {
  const val CHANNEL_ID = "lark.downloads"
  const val ID = 0x1A24

  /** Creating a channel that already exists is a no-op — nothing to remember. */
  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.createNotificationChannel(
      // IMPORTANCE_LOW: no sound, no heads-up. A download in progress is not
      // entitled to interrupt anything.
      NotificationChannel(CHANNEL_ID, "下载", NotificationManager.IMPORTANCE_LOW).apply {
        description = "正在下载的歌曲"
        setShowBadge(false)
      },
    )
  }

  /**
   * Built in one place because two callers need the same notification: the
   * service posts it through `startForeground`, and `update` re-posts it under
   * the same id without touching the foreground state.
   */
  fun build(context: Context, title: String, body: String): Notification {
    // The app's own launcher intent, so tapping it comes back to lark rather
    // than to a screen this file would have to know about.
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val pending =
      launch?.let {
        PendingIntent.getActivity(
          context,
          0,
          it,
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
      }

    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(context, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION") Notification.Builder(context)
      }

    return builder
      .setContentTitle(title)
      .setContentText(body)
      // The platform's own glyph: this module ships no resources, and a
      // notification with no small icon is one Android refuses to post.
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .also { b -> pending?.let { b.setContentIntent(it) } }
      .build()
  }
}

/**
 * The foreground service a download runs under (N4c, decision e).
 *
 * WHAT IT BUYS. Nothing here transfers a byte — the transfer is
 * `File.downloadFileAsync`'s, on its own native thread. What this buys is the
 * right to keep running: without a foreground service Android may stop the
 * process while a fifty-megabyte transfer is halfway through, and there is no
 * way to ask for that exemption from JS. expo-audio's service is media3's and
 * declares `mediaPlayback`; this one declares `dataSync`, and the two coexist —
 * two services, two notifications, two types.
 *
 * IT KNOWS NOTHING ABOUT DOWNLOADS, on purpose. It shows a notification, it
 * stays up, and it tells JS when the system takes the quota back. WHICH tasks
 * to cancel when that happens is a business decision and stays in
 * `downloads/foreground.ts` — the same boundary `lark-fs`, `lark-audio` and
 * `lark-media` each keep.
 *
 * THE TEN SECONDS ARE REAL. `startForegroundService` gives a service ten
 * seconds to call `startForeground` before the system kills it, and Android 14
 * tightened what happens when the type is not allowed. So `onStartCommand`
 * reads the text out of the intent and posts the notification FIRST, with no IO
 * on the way.
 */
class LarkTransferService : Service() {
  companion object {
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"

    /**
     * Whether an instance is up, for `isRunning()`.
     *
     * A static, because the module and the service are separate objects with no
     * handle on each other and the question — "is the notification on screen" —
     * is about the process rather than either of them. `dumpsys` stays the
     * authority for a criterion; this is for the app's own state machine, which
     * cannot shell out.
     */
    @Volatile @JvmStatic var running: Boolean = false

    /** Set by the module, called by the service, so JS hears about the quota. */
    @Volatile @JvmStatic var onQuotaExpired: (() -> Unit)? = null
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "lark"
    val body = intent?.getStringExtra(EXTRA_BODY) ?: ""
    TransferNotification.ensureChannel(this)
    val notification = TransferNotification.build(this, title, body)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        TransferNotification.ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      )
    } else {
      startForeground(TransferNotification.ID, notification)
    }
    running = true
    // NOT_STICKY: if the system kills this there is nothing to resume — the
    // downloads it was covering died with the process, and the library's boot
    // sweep is what tidies up after them. A restarted service with no tasks
    // would be a notification about nothing.
    return START_NOT_STICKY
  }

  /**
   * Android 15 (API 35) enforces a cumulative daily budget for `dataSync` — six
   * hours in any twenty-four — and calls this when it runs out.
   *
   * Two things, and only two: tell JS, then stop. Stopping is not optional (an
   * app that ignores this is killed), and what to cancel is not this object's
   * question.
   */
  override fun onTimeout(startId: Int, fgsType: Int) {
    onQuotaExpired?.invoke()
    stopSelf()
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }
}
