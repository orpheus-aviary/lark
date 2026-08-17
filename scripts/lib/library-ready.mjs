// Wait until a daemon is SERVING the library, not merely listening.
//
// Since 0.3.0, a daemon that opens a 0.2.x library upgrades it to schema v3 and
// converts every mp3 in place — and it does that AFTER `listen()` (§3.2-3), so
// for the length of the pass `/status`, `/api/instance` and `/api/capabilities`
// answer 200 while every business route answers 503 `AUDIO_MIGRATION_PENDING`.
//
// Every acceptance harness in this directory runs on a COPY of the real nest,
// which means every one of them walks into that window on its first boot. A
// harness that starts asserting there measures the migration gate rather than
// the product, and the failure reads like a broken feature.
//
// Two states end the wait early rather than burning the timeout: the pass says
// when it has stopped needing a machine (`blocked_environment`) or a person
// (`needs_attention`), and neither turns into `normal` on its own.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `${baseUrl}/status` until the daemon reports phase `normal`.
 *
 * A daemon that reports no `audio_migration` at all is a pre-0.3 daemon and is
 * ready by definition — which is also what makes this safe to call against a
 * fresh nest, where the migration never runs.
 *
 * @param {string} baseUrl e.g. `http://127.0.0.1:47100`
 * @param {{ timeoutMs?: number, log?: (line: string) => void }} [options]
 * @returns {Promise<object>} the last `/status` payload's `data`
 */
export async function waitForLibraryReady(baseUrl, { timeoutMs = 900_000, log } = {}) {
  const deadline = Date.now() + timeoutMs;
  let announcedDone = null;

  while (Date.now() < deadline) {
    const data = await readStatus(baseUrl);
    const verdict = classify(data);

    if (verdict.kind === 'ready') {
      if (announcedDone !== null && log) log(`      migration finished — ${verdict.detail}`);
      return data;
    }
    if (verdict.kind === 'stuck') throw new Error(verdict.detail);
    if (verdict.kind === 'working' && log && announcedDone !== verdict.done) {
      log(`      migrating this copy's audio — ${verdict.detail}`);
      announcedDone = verdict.done;
    }

    await sleep(500);
  }

  throw new Error(`the daemon never started serving the library within ${timeoutMs}ms`);
}

async function readStatus(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json())?.data ?? null) : null;
  } catch {
    return null; // not listening yet
  }
}

/** `waiting` covers both "no answer yet" and "the pass is between updates". */
function classify(data) {
  if (data === null) return { kind: 'waiting' };

  const counts = data.audio_migration;
  if (counts === undefined) return { kind: 'ready', detail: 'no migration on this daemon' };
  if (counts.phase === 'normal') return { kind: 'ready', detail: describe(counts) };
  if (counts.phase === 'fatal') {
    return { kind: 'stuck', detail: `the daemon came up fatal — ${describe(counts)}` };
  }
  if (counts.state === 'blocked_environment' || counts.state === 'needs_attention') {
    return {
      kind: 'stuck',
      detail: `the audio migration stopped and needs handling (${counts.state}) — ${describe(counts)}`,
    };
  }
  return { kind: 'working', done: counts.done, detail: describe(counts) };
}

function describe(counts) {
  const parts = [`${counts.done}/${counts.total} done`];
  for (const key of ['lost', 'kept_unconverted', 'asset_missing', 'blocked', 'blocked_file_op']) {
    if (counts[key] > 0) parts.push(`${key} ${counts[key]}`);
  }
  return parts.join(', ');
}
