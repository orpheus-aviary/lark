package expo.modules.larkfs

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * The move, extracted from the module definition so that the instrumentation
 * test drives THIS and not a copy of it.
 *
 * That is not tidiness. Criterion 10① is a claim about the production
 * implementation, and a test that re-typed the same three arguments beside it
 * would keep passing after somebody changed the real one.
 */
object AtomicMove {
  /**
   * Rename `from` onto `to` with no window in which `to` is absent.
   *
   * NO FALLBACK. `ATOMIC_MOVE` throws `AtomicMoveNotSupportedException` when
   * the platform cannot promise atomicity, and failing is the correct answer —
   * a copy-then-delete fallback is exactly the silent weakening
   * `FileSystemPort` forbids (criterion 10④).
   */
  fun atomic(from: File, to: File) {
    to.parentFile?.mkdirs()
    Files.move(
      from.toPath(),
      to.toPath(),
      StandardCopyOption.REPLACE_EXISTING,
      StandardCopyOption.ATOMIC_MOVE,
    )
  }

  /**
   * What expo-file-system does, and why this module exists (criterion 10①'s
   * counter-test).
   *
   * `moveSync(overwrite = true)` runs `LocalFile.prepareAsDestination`, which
   * deletes an existing target before `renameTo` — `CopyMoveStrategy.kt:88-91`.
   * The rename itself is atomic; the delete in front of it is what opens the
   * window, and a reader that lands in it sees "no file" rather than "the old
   * file".
   *
   * PRODUCTION MUST NEVER CALL THIS. It exists so the counter-test can show
   * the window it is written to rule out — a guard that has never been seen to
   * trip is a guard nobody has tested.
   *
   * @param barrier run between the delete and the rename, so the window can be
   * held open long enough for another thread to sample it. The real window is
   * microseconds; a test that relied on catching it by luck would be flaky in
   * the direction that reads as "safe".
   */
  fun nonAtomicLikeExpo(from: File, to: File, barrier: () -> Unit = {}) {
    to.parentFile?.mkdirs()
    if (to.exists()) to.delete()
    barrier()
    if (!from.renameTo(to)) throw IllegalStateException("renameTo failed")
  }
}
