package expo.modules.larkfs

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Criterion 10①, and the only place it can be answered.
 *
 * A JS-side poll loop cannot see this window. The subplan says why (§1.5): the
 * production move is one call, and a reader on the same thread only runs after
 * it returns — so an implementation that deleted the target first would pass a
 * JS test exactly as convincingly as one that does not. The desktop's
 * equivalent (`node-fs.test.ts:60`) only works because its write is genuinely
 * asynchronous.
 *
 * So: two real threads. A reader spins on `exists()`; a writer moves. Both
 * implementations run under the SAME harness — same threads, same loop, same
 * sampling — because a counter-test that ran differently from production would
 * be measuring the harness.
 *
 * AND THE COUNTER-TEST HAS TO REPORT SEEING THE WINDOW, not merely fail to be
 * green. `mutantExposesTheWindow` asserts the reader DID observe the file
 * missing; if that ever stops holding, the harness has stopped being able to
 * observe anything and `atomicMoveNeverExposesTheWindow` is worthless.
 */
@RunWith(AndroidJUnit4::class)
class AtomicMoveTest {
  private lateinit var dir: File
  private lateinit var target: File

  @Before
  fun setUp() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    dir = File(context.cacheDir, "lark-fs-atomic-test").apply {
      deleteRecursively()
      mkdirs()
    }
    target = File(dir, "lyrics.lrc").apply { writeText("the old lyrics") }
  }

  private fun freshSource(contents: String): File =
    File(dir, ".lyrics.lrc.${System.nanoTime()}.tmp").apply { writeText(contents) }

  /**
   * Spin on the target until told to stop, recording whether it was ever
   * absent. `exists()` and not a read: absence is the failure mode, and a read
   * of a missing file would just throw somewhere less specific.
   */
  private fun readerThread(stop: AtomicBoolean, sawMissing: AtomicBoolean): Thread =
    Thread {
      while (!stop.get()) {
        if (!target.exists()) sawMissing.set(true)
      }
    }

  @Test
  fun mutantExposesTheWindow() {
    val stop = AtomicBoolean(false)
    val sawMissing = AtomicBoolean(false)
    val reader = readerThread(stop, sawMissing).also { it.start() }

    // The window held open on a background thread — the same place production
    // runs, since `moveAtomic` is an AsyncFunction.
    val inWindow = CountDownLatch(1)
    val release = CountDownLatch(1)
    val writer = Thread {
      AtomicMove.nonAtomicLikeExpo(freshSource("the new lyrics"), target) {
        inWindow.countDown()
        release.await(5, TimeUnit.SECONDS)
      }
    }
    writer.start()

    assertTrue("the writer never reached the window", inWindow.await(5, TimeUnit.SECONDS))
    // The reader is spinning right now, and the target is deleted. Give it a
    // moment to sample rather than assuming it already has.
    Thread.sleep(50)
    val observed = sawMissing.get()
    release.countDown()
    writer.join(5_000)
    stop.set(true)
    reader.join(5_000)

    assertTrue(
      "the reader never saw the target missing — the harness cannot observe the window it is " +
        "here to rule out, so the atomic case proves nothing either",
      observed,
    )
    assertEquals("the new lyrics", target.readText())
  }

  @Test
  fun atomicMoveNeverExposesTheWindow() {
    val stop = AtomicBoolean(false)
    val sawMissing = AtomicBoolean(false)
    val reader = readerThread(stop, sawMissing).also { it.start() }

    // One move is over in microseconds, so a single round could miss a window
    // that is really there. Two thousand of them, with the reader spinning
    // throughout, is what makes "never" mean something.
    val writer = Thread {
      repeat(2_000) { round ->
        AtomicMove.atomic(freshSource("round $round"), target)
      }
    }
    writer.start()
    writer.join(60_000)
    stop.set(true)
    reader.join(5_000)

    assertFalse("the reader saw the target missing during an atomic replace", sawMissing.get())
    assertEquals("round 1999", target.readText())
  }
}
