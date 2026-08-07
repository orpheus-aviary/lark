#!/usr/bin/env node
// `just accept-m5 [--keep]` — the M5 acceptance matrix (plan §6, items 2–6),
// run against a REAL daemon on a COPY of the nest, with real bilibili traffic.
//
// Headless on purpose: everything here is a judgement no pair of eyes can make
// reliably — did eviction spare the imports, did the row survive its file, did
// the commit refuse a file that changed under it. What is left for a person is
// the list §6 calls 用户手动: how the settings page looks, how dragging feels,
// and whether the song actually comes out of the speakers.
//
// Phase order matches accept-gui: build + copy on the NODE abi (backupNest
// loads better-sqlite3), and the daemon runs on that same abi — no Electron
// here, so no abi switch.

import { spawn } from 'node:child_process';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupNest } from '../packages/core/dist/index.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DAEMON_URL = 'http://127.0.0.1:47100';
/** A live single-part video: no LLM needed, and its cid is stable. */
const VIDEO_URL = 'https://www.bilibili.com/video/BV1GJ411x7h7';
const DEAD_KEY = 'BV1dead00000:1';

const keep = process.argv.includes('--keep');
const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function startDaemon(nestDir) {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'packages/daemon/dist/testing/boot-child.js')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        LARK_NEST_DIR: nestDir,
        LARK_DAEMON_TEST_PORT: '47100',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (chunk) => process.stdout.write(`[daemon] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[daemon] ${chunk}`));
  return child;
}

async function waitForDaemon(nestDir, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await fetch(`${DAEMON_URL}/status`, { signal: AbortSignal.timeout(1000) });
      if (status.ok) {
        const token = (await readFile(join(nestDir, 'lark/daemon-token'), 'utf8')).trim();
        const instance = await fetch(`${DAEMON_URL}/api/instance`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(1000),
        });
        if (instance.ok) return { token, instance: (await instance.json()).data };
      }
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new Error('the acceptance daemon never became ready');
}

async function stopChild(child, timeoutMs = 8000) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const started = Date.now();
  while (child.exitCode === null && Date.now() - started < timeoutMs) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

let daemon = null;
let copy = null;
let events = null;

try {
  console.log('[1/5] copying the nest (node abi)…');
  copy = await backupNest();
  console.log(`      ${copy.nestDir}`);

  console.log('[2/5] starting the acceptance daemon on 47100…');
  daemon = startDaemon(copy.nestDir);
  const { token, instance } = await waitForDaemon(copy.nestDir);
  check(
    'the acceptance daemon owns 47100 and names the copy',
    instance.nest_dir === copy.larkDir,
    instance.nest_dir,
  );

  const auth = { Authorization: `Bearer ${token}` };
  const api = async (method, path, body) => {
    const res = await fetch(`${DAEMON_URL}${path}`, {
      method,
      headers: body ? { ...auth, 'Content-Type': 'application/json' } : auth,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const data = async (method, path, body) => (await api(method, path, body)).json?.data;

  // Collect SSE the way the GUI does, so `cache:evicted` can be asserted.
  const seen = [];
  const sse = await fetch(`${DAEMON_URL}/events`, { headers: auth });
  events = sse.body.getReader();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await events.read().catch(() => ({ done: true }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split('\n')) {
        if (line.startsWith('data: ')) seen.push(JSON.parse(line.slice(6)));
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    }
  })();

  const songFile = (id) => join(copy.larkDir, 'songs', id, 'song.mp3');
  const lyricsFile = (id) => join(copy.larkDir, 'songs', id, 'lyrics.lrc');
  const songById = async (id) => await data('GET', `/songs/${id}`);

  /** Poll a download task to a terminal state. */
  async function settle(taskId, timeoutMs = 180_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const snapshot = await data('GET', '/download/tasks');
      const task = snapshot.tasks.find((t) => t.id === taskId);
      if (task === undefined) return null;
      if (['succeeded', 'failed', 'cancelled'].includes(task.state)) return task;
      await sleep(500);
    }
    throw new Error(`task ${taskId} never finished`);
  }

  // ── 3 · a real download, which is what the cache is a cache OF ──

  console.log('[3/5] downloading one real song…');
  const queued = await data('POST', '/download/song', { input: VIDEO_URL });
  const task = await settle(queued.task_id);
  check(
    'a link download succeeds end to end',
    task?.state === 'succeeded',
    task?.error_message ?? '',
  );
  const downloaded = await songById(task.result.song_id);
  check(
    'the download wrote back the source triple and landed a file',
    downloaded.source_provider === 'bilibili' &&
      /^BV[0-9A-Za-z]+:\d+$/.test(downloaded.source_key) &&
      downloaded.has_file === true,
    `${downloaded.source_key} ${downloaded.file_size} bytes`,
  );

  // ── 4 · cache: what may be reclaimed, and what may never be ──

  console.log('[4/5] cache…');
  const library = await data('GET', '/songs');
  const imported = library.filter((s) => s.file_origin === 'imported' && s.has_file === true);
  const pinTarget = imported[0];
  await api('PUT', `/songs/${pinTarget.id}/pin`, { pinned: true });

  const before = await data('GET', '/cache/status');
  check(
    'status counts every file and reports the limit it was given',
    before.file_count >= imported.length + 1 && before.limit_mb === 0 && before.limit_satisfied,
    `${before.file_count} files, ${(before.used_bytes / 1048576).toFixed(1)}MiB used`,
  );
  check(
    'imports and pins are outside the eligible bytes (R1/R26)',
    before.eligible_bytes < before.used_bytes &&
      before.eligible_bytes >= (downloaded.file_size ?? 0) &&
      before.unreclaimable_bytes === before.used_bytes - before.eligible_bytes,
    `eligible ${(before.eligible_bytes / 1048576).toFixed(1)}MiB of ${(before.used_bytes / 1048576).toFixed(1)}MiB`,
  );

  // A limit under what the imports alone occupy: the only thing eviction is
  // allowed to touch is the song just downloaded.
  const limitMb = Math.max(1, Math.floor((before.used_bytes - before.eligible_bytes) / 1048576));
  await api('PATCH', '/config', { storage: { cache_limit_mb: limitMb } });
  const importedLyrics = existsSync(lyricsFile(downloaded.id));
  const evicted = await data('POST', '/cache/evict');

  // NOT "exactly one": this runs against a copy of a REAL library, where any
  // song the user has re-downloaded is `downloaded` too and therefore just as
  // evictable (R1). What must hold is the invariant, not the fixture's shape.
  check(
    'eviction reclaimed the downloaded audio, and freed at least its bytes',
    !existsSync(songFile(downloaded.id)) &&
      evicted.evicted_count >= 1 &&
      evicted.freed_bytes >= (downloaded.file_size ?? 0),
    `evicted ${evicted.evicted_count}, freed ${(evicted.freed_bytes / 1048576).toFixed(1)}MiB`,
  );
  check(
    'every import survived, pinned or not',
    imported.every((song) => existsSync(songFile(song.id))),
    `${imported.length} imported files`,
  );
  const rowAfter = await songById(downloaded.id);
  check(
    'the row and its lyrics outlive the audio (evicted ≠ forgotten)',
    rowAfter !== undefined &&
      rowAfter.has_file === false &&
      rowAfter.source_key === downloaded.source_key &&
      existsSync(lyricsFile(downloaded.id)) === importedLyrics,
    `has_file=${rowAfter?.has_file}`,
  );
  check(
    'a cache:evicted event named the song',
    seen.some((e) => e.type === 'cache:evicted' && e.song_id === downloaded.id),
  );

  // ── 5 · ensure-file brings it back, and fail-closed keeps a dead key ──

  console.log('[5/5] ensure-file, fail-closed, transfer, links…');
  const ensured = await settle((await data('POST', `/songs/${downloaded.id}/ensure-file`)).task_id);
  check(
    'ensure-file fetches a song whose audio was evicted',
    ensured?.state === 'succeeded' && existsSync(songFile(downloaded.id)),
    ensured?.error_message ?? '',
  );

  // The lease (M5-6): the GUI has not opened /audio yet, so the drain that a
  // second trigger runs must still leave this file alone.
  const afterEnsure = await data('POST', '/cache/evict');
  check(
    'the ensure lease survives a later drain the GUI has not caught up with',
    existsSync(songFile(downloaded.id)) && afterEnsure.evicted_count === 0,
    `evicted ${afterEnsure.evicted_count}`,
  );

  // Fail-closed (R26): a key that cannot be confirmed is never deleted.
  await api('PUT', `/songs/${downloaded.id}`, {
    source_url: downloaded.source_url,
    source_provider: 'bilibili',
    source_key: DEAD_KEY,
  });
  await sleep(61_000 - 0); // let the 60s ensure lease expire before judging
  const failClosed = await data('POST', '/cache/evict');
  check(
    'a source that cannot be verified is skipped, not deleted (R26)',
    existsSync(songFile(downloaded.id)) &&
      failClosed.evicted_count === 0 &&
      failClosed.skipped_unverified_count === 1,
    `skipped ${failClosed.skipped_unverified_count}, freed ${failClosed.freed_bytes}`,
  );

  // Put the real key back and lift the limit, so the rest runs on a sane library.
  await api('PUT', `/songs/${downloaded.id}`, {
    source_url: downloaded.source_url,
    source_provider: 'bilibili',
    source_key: downloaded.source_key,
  });
  await api('PATCH', '/config', { storage: { cache_limit_mb: 0 } });

  // ── export → import round trip ──

  const target = await data('POST', '/playlists', { name: 'M5 验收歌单' });
  await api('POST', `/playlists/${target.id}/songs`, { song_ids: [downloaded.id] });
  const exported = await data('GET', `/playlists/${target.id}/export`);
  check(
    'the export carries the source pair and no ids (R10/R27)',
    exported.format === 'lark-playlist' &&
      exported.version === 1 &&
      exported.songs.length === 1 &&
      exported.songs[0].source_key === downloaded.source_key &&
      !('id' in exported.songs[0]),
    exported.playlist.name,
  );

  const filePath = join(copy.nestDir, 'export.lark-playlist.json');
  writeFileSync(filePath, JSON.stringify(exported, null, 2));
  const preview = await data('POST', '/playlists/import-preview', { file_path: filePath });
  check(
    're-importing an export reuses every song it already knows (R12)',
    preview.total === 1 && preview.reuse_count === 1 && preview.new_count === 0,
    `reuse ${preview.reuse_count}/${preview.total}`,
  );
  const commit = await data('POST', '/playlists/import', {
    file_path: filePath,
    digest: preview.digest,
    target: { kind: 'new', name: '导入回来的' },
  });
  const libraryAfter = await data('GET', '/songs');
  check(
    'the round trip created a playlist but not a single song',
    commit.created === 0 && commit.reused === 1 && libraryAfter.length === library.length,
    `${libraryAfter.length} songs before and after`,
  );

  // A renamed entry is a SUSPECT, and the default is still to import it new.
  const renamed = structuredClone(exported);
  renamed.songs[0].source_key = null;
  renamed.songs[0].source_provider = null;
  renamed.playlist.name = '改过名的';
  const suspectPath = join(copy.nestDir, 'suspect.json');
  writeFileSync(suspectPath, JSON.stringify(renamed, null, 2));
  const suspectPreview = await data('POST', '/playlists/import-preview', {
    file_path: suspectPath,
  });
  check(
    'a same-name entry with no key is a suspect, counted as new (R12)',
    suspectPreview.suspects.length === 1 &&
      suspectPreview.suspects[0].candidates.some((c) => c.id === downloaded.id) &&
      suspectPreview.new_count === 1,
    `${suspectPreview.suspects.length} suspects`,
  );

  // Changing the file after the preview invalidates the indices, and the
  // commit must say so rather than import against them.
  writeFileSync(suspectPath, JSON.stringify({ ...renamed, exported_at: 1 }, null, 2));
  const stale = await api('POST', '/playlists/import', {
    file_path: suspectPath,
    digest: suspectPreview.digest,
    target: { kind: 'all' },
  });
  check(
    'a file that changed since the preview is refused (M5-13)',
    stale.status === 400 && stale.json?.error_code === 'IMPORT_SOURCE_CHANGED',
    `${stale.status} ${stale.json?.error_code}`,
  );

  // ── link editing ──

  const other = libraryAfter.find((s) => s.id !== downloaded.id && s.source_key === null);
  const conflict = await api('PUT', `/songs/${other.id}`, { source_url: VIDEO_URL });
  check(
    'a link that already belongs to another song is a 409 that names it',
    conflict.status === 409 &&
      conflict.json?.error_code === 'SOURCE_KEY_CONFLICT' &&
      conflict.json?.details?.conflicting_song_id === downloaded.id,
    `${conflict.status} ${conflict.json?.details?.conflicting_song_id}`,
  );
  const cleared = await data('PUT', `/songs/${downloaded.id}`, { source_url: null });
  check(
    'clearing the url clears the whole triple',
    cleared.source_url === null && cleared.source_provider === null && cleared.source_key === null,
  );
  const renormalised = await data('PUT', `/songs/${downloaded.id}`, { source_url: VIDEO_URL });
  check(
    'a pasted link is normalised online back into bvid:cid (R30)',
    renormalised.source_key === downloaded.source_key &&
      renormalised.source_url.startsWith('https://www.bilibili.com/video/BV'),
    renormalised.source_url,
  );

  // ── window size round trip (the daemon half of M5-3) ──

  await api('PATCH', '/config', { window: { width: 1234, height: 789 } });
  const config = await data('GET', '/config');
  const toml = await readFile(join(copy.larkDir, 'lark_config.toml'), 'utf8');
  check(
    'the window size the GUI reports lands in the config file',
    config.window.width === 1234 &&
      config.window.height === 789 &&
      /width\s*=\s*1234/.test(toml) &&
      /height\s*=\s*789/.test(toml),
    `${config.window.width}×${config.window.height}`,
  );
  check(
    'the config file is still 0600 after the write (R14)',
    (statSync(join(copy.larkDir, 'lark_config.toml')).mode & 0o777) === 0o600,
  );
} finally {
  if (events) await events.cancel().catch(() => {});
  await stopChild(daemon);
  if (copy) {
    if (keep) console.log(`\ncopy kept at ${copy.nestDir}`);
    else rmSync(copy.nestDir, { recursive: true, force: true });
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
