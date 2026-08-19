// R4 and R5 — the real sync functions, on the device (N1i).
//
// `workload.ts` measured the STATEMENT SHAPE of a backfill and an apply,
// because until N1 core's sync modules could not be resolved by Metro at all
// (`node:crypto`, `node:fs/promises`). Its own header says what has to happen
// next: "R5 re-runs the real `applyChangesInTx` after N1, and that is what
// freezes the batch size." This file is that re-run.
//
// The difference is the whole reason N1 exists. Nothing here replays anything:
// `runFullBackfillInTx` and `applyChangesInTx` are imported from
// `@lark/core/portable` and are the same function objects the desktop runs. A
// number measured here is a number about lark, not about a proxy for lark.

import {
  type InboundChange,
  type SqliteLike,
  applyChangesInTx,
  runFullBackfillInTx,
} from '@lark/core/portable';
import { SYNC_PULL_LIMIT, SYNC_PULL_LIMIT_MOBILE } from '@lark/shared';
import { MEASURED_ROUNDS, WARMUP_ROUNDS, judge, now, summarize } from '../measure';
import { installPortableRuntime } from '../portable-runtime';
import { type Fixture, type WorkloadRow, fakeUuid, openFixture } from './workload';

/** The fixture `buildLibrary` seeds. R4 asserts the backfill reaches all of it. */
const LIBRARY_SONGS = 2_000;

/** Foreground budget for one applied batch (§1.3-D). */
const APPLY_BUDGET_MS = 100;

/**
 * R4 — a login backfill with its whole workload in front of it.
 *
 * The fixture's `sync_changes` are `update`s and never `create`s, which is the
 * trap: `runFullBackfillInTx` skips any entity that already has a create
 * (backfill.ts:130-134), so a fixture seeded with creates would measure a
 * backfill with almost nothing to do and report it as a fast one.
 *
 * Measured once per fixture, because it is a once-per-login operation and the
 * second run would find the work already done — the count, not the clock, is
 * the judgement.
 */
function runR4Panel(): WorkloadRow[] {
  // Every entity id the backfill mints goes through core's Random provider,
  // which refuses to guess on a host that has not answered (N1a). RN has no
  // `crypto.getRandomValues`, so without this the first `uuid()` throws — which
  // is the port working, and is exactly how this panel failed the first time.
  installPortableRuntime();
  const rows: WorkloadRow[] = [];
  const fixture = openFixture('real-backfill.db', true);
  try {
    const { sqlite } = fixture;
    const started = now();
    const result = sqlite.transaction(() => runFullBackfillInTx(sqlite, new Map()))();
    const elapsed = now() - started;

    rows.push({
      scenario: 'R4 · runFullBackfillInTx, 2,000 songs owed',
      timing: summarize('backfill', [elapsed]),
      ok: judge(result.songs === LIBRARY_SONGS),
      note: `${result.songs} songs (expected ${LIBRARY_SONGS}), ${result.playlists} playlists, ${result.memberships} memberships`,
      size: LIBRARY_SONGS,
    });

    // A second run must find nothing left to do. Without this the first row
    // would pass just as well against a backfill that had already run — which
    // is precisely the fixture trap above, one level up.
    const again = sqlite.transaction(() => runFullBackfillInTx(sqlite, new Map()))();
    rows.push({
      scenario: 'R4 · the same backfill a second time',
      timing: summarize('backfill-again', [0]),
      ok: judge(again.songs === 0),
      note: `${again.songs} songs the second time — a backfill that ran is a backfill that is done`,
      size: null,
    });
  } finally {
    fixture.dispose();
  }
  return rows;
}

/**
 * One inbound update per song, as a device that has been away receives them.
 *
 * `server_seq` and the stamp both climb, so every batch is genuinely newer than
 * the rows it lands on — an apply that lost to LWW would measure a skip.
 */
function inboundBatch(size: number, round: number, offset: number): InboundChange[] {
  const stamp = 1_800_000_000_000 + round * 1_000;
  const changes: InboundChange[] = [];
  for (let i = 0; i < size; i += 1) {
    const index = (offset + i) % LIBRARY_SONGS;
    changes.push({
      server_seq: round * 10_000 + i + 1,
      // NOT this device: a change carrying our own device id is an echo, and
      // the echo path is a different (cheaper) branch of the apply.
      device_id: fakeUuid(111_111),
      client_change_id: fakeUuid(600_000 + round * 10_000 + i),
      entity_type: 'song',
      entity_id: fakeUuid(index),
      op: 'update',
      payload: {
        name: `远端改的 ${index}`,
        artist: `艺人 ${index % 97}`,
        source_url: `https://www.bilibili.com/video/BV1${index}`,
        source_provider: 'bilibili',
        source_key: `BV1${index}:${index}`,
        lyrics_offset: 0,
        duration: 200,
        // Required by `parseSongPayload`, and its absence is why the first run
        // of this panel reported 2,000 skipped in 14ms: an unparseable payload
        // is dead-lettered, which counts as skipped, and a batch that applied
        // nothing is a fast batch that measured nothing.
        created_at_ms: 1_700_000_000_000,
        updated_at_ms: stamp,
        lww_counter: round + 1,
      },
    });
  }
  return changes;
}

interface BatchOutcome {
  samples: number[];
  applied: number;
  skipped: number;
  deadLettered: number;
}

/**
 * `startRound` continues the stamp sequence rather than restarting it.
 *
 * Both sizes are measured against one fixture, and a second pass that began at
 * round 0 again would carry stamps OLDER than what the first pass wrote — so
 * its early batches lose to LWW and are skipped. That is what the first run of
 * this panel reported: the 500 row applied 2,400 of 5,000 and timed a mixture
 * of real work and cheap refusals, which is not a number the desktop's size can
 * be judged against.
 */
function measureBatches(sqlite: SqliteLike, size: number, startRound = 0): BatchOutcome {
  const samples: number[] = [];
  let applied = 0;
  let skipped = 0;
  let deadLettered = 0;
  const rounds = WARMUP_ROUNDS + MEASURED_ROUNDS;
  for (let n = 0; n < rounds; n += 1) {
    const round = startRound + n;
    const changes = inboundBatch(size, round, (round * size) % LIBRARY_SONGS);
    const started = now();
    const outcome = sqlite.transaction(() => applyChangesInTx(sqlite, changes))();
    const elapsed = now() - started;
    if (n >= WARMUP_ROUNDS) {
      samples.push(elapsed);
      applied += outcome.applied;
      skipped += outcome.skipped;
      deadLettered += outcome.deadLettered;
    }
  }
  return { samples, applied, skipped, deadLettered };
}

/**
 * R5 — the mobile pull size, its production wiring, and what it costs.
 *
 * The constant row is not ceremony: `SYNC_PULL_LIMIT_MOBILE` is what the
 * coordinator hands `runSync`, and a number that drifted from the one measured
 * here would be a batch size nobody had ever timed.
 */
function runR5Panel(): WorkloadRow[] {
  installPortableRuntime();
  const rows: WorkloadRow[] = [];

  rows.push({
    scenario: 'R5① · SYNC_PULL_LIMIT_MOBILE is 200',
    timing: summarize('constant', [0]),
    ok: judge(SYNC_PULL_LIMIT_MOBILE === 200),
    note: `mobile ${SYNC_PULL_LIMIT_MOBILE}, desktop ${SYNC_PULL_LIMIT} — the desktop was never close to dropping a frame`,
    size: SYNC_PULL_LIMIT_MOBILE,
  });

  const fixture: Fixture = openFixture('real-apply.db', true);
  try {
    const { sqlite } = fixture;

    const mobile = measureBatches(sqlite, SYNC_PULL_LIMIT_MOBILE);
    const mobileTiming = summarize(`apply ${SYNC_PULL_LIMIT_MOBILE}`, mobile.samples);
    rows.push({
      scenario: `R5③ · applyChangesInTx, ${SYNC_PULL_LIMIT_MOBILE} per batch`,
      timing: mobileTiming,
      ok: judge(
        mobileTiming.p95 <= APPLY_BUDGET_MS &&
          mobile.applied === MEASURED_ROUNDS * SYNC_PULL_LIMIT_MOBILE,
      ),
      // The applied count is part of the judgement: a batch that measured fast
      // because every change lost to LWW is a fast batch that did nothing.
      note: `p95 ${mobileTiming.p95}ms of ${APPLY_BUDGET_MS}ms · applied ${mobile.applied}, skipped ${mobile.skipped}, dead-lettered ${mobile.deadLettered}`,
      size: SYNC_PULL_LIMIT_MOBILE,
    });

    // Recorded, not judged: this is the size N0b-3 measured at 164ms p50 and
    // rejected, and it stays on the panel so the rejection keeps its evidence.
    const desktop = measureBatches(sqlite, SYNC_PULL_LIMIT, WARMUP_ROUNDS + MEASURED_ROUNDS);
    const desktopTiming = summarize(`apply ${SYNC_PULL_LIMIT}`, desktop.samples);
    rows.push({
      scenario: `R5③ · the same at ${SYNC_PULL_LIMIT} (reference, not a judgement)`,
      timing: desktopTiming,
      ok: null,
      note: `p95 ${desktopTiming.p95}ms · applied ${desktop.applied} of ${MEASURED_ROUNDS * SYNC_PULL_LIMIT}, skipped ${desktop.skipped} · why the phone does not use the desktop's size`,
      size: SYNC_PULL_LIMIT,
    });
  } finally {
    fixture.dispose();
  }
  return rows;
}

/** Both, for a panel that renders them together. */
export function runRealSyncPanel(): WorkloadRow[] {
  return [...runR4Panel(), ...runR5Panel()];
}
