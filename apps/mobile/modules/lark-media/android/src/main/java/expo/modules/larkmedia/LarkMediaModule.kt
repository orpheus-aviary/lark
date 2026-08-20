package expo.modules.larkmedia

import android.media.MediaMetadataRetriever
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DurationUnreadableException(path: String, detail: String) :
  CodedException("ERR_LARK_MEDIA_DURATION", "could not read the duration of $path: $detail", null)

/**
 * One function: the duration of an audio file, via `MediaMetadataRetriever`
 * (N4b, decision b — the primary of the duration ladder).
 *
 * The landing needs the ACTUAL length of the bytes that arrived, because the
 * row is written from what landed and a copy that silently carried no audio
 * would otherwise be committed as a song (§1.4). The desktop probes the output
 * with ffprobe; MMR is the phone's equivalent that reads a file path and
 * nothing else — it does NOT take audio focus or build a session, so it never
 * disturbs whatever is playing (criterion 9). A file it cannot decode makes it
 * throw or return null, which is exactly what a truncated or empty download is,
 * and the landing turns that into "do not commit".
 *
 * MMR and ExoPlayer are two different extractors, so "MMR agrees with ffprobe
 * to the millisecond" is NOT a given — criterion 8 measures it against the two
 * fixtures that carry an ffprobe truth, and the fallback if it does not hold is
 * a transient `createAudioPlayer` (decision b's B), never the upstream page
 * duration (which proves nothing about whether the file decodes).
 *
 * `AsyncFunction`, so the read runs on Expo's background dispatcher rather than
 * the JS thread — a responsiveness decision, not a verification one.
 */
class LarkMediaModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LarkMedia")

    AsyncFunction("readDurationSeconds") { path: String ->
      val retriever = MediaMetadataRetriever()
      try {
        retriever.setDataSource(stripScheme(path))
        val raw = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
          ?: throw DurationUnreadableException(path, "no duration metadata")
        val millis = raw.toLongOrNull()
          ?: throw DurationUnreadableException(path, "duration metadata was not a number: $raw")
        if (millis <= 0L) throw DurationUnreadableException(path, "duration was $millis ms")
        millis.toDouble() / 1000.0
      } catch (cause: DurationUnreadableException) {
        throw cause
      } catch (cause: Throwable) {
        // A file MMR cannot open throws IllegalArgumentException / RuntimeException;
        // all of it means the same thing to the caller — this is not a playable file.
        throw DurationUnreadableException(path, cause.message ?: cause.javaClass.simpleName)
      } finally {
        runCatching { retriever.release() }
      }
    }
  }

  /**
   * The JS side speaks `file://` URIs (everything it holds comes from
   * expo-file-system); `MediaMetadataRetriever.setDataSource(String)` wants a
   * plain path.
   */
  private fun stripScheme(value: String): String =
    if (value.startsWith("file://")) value.removePrefix("file://") else value
}
