#!/usr/bin/env node
// `just accept-cli [--keep]` — the M6 acceptance matrix (plan §6), run against
// a REAL daemon on a COPY of the nest, driving the REAL `lark` binary.
//
// Everything here goes through the CLI's own process boundary, because that is
// where its contract lives: the exit code, what landed on stdout, what landed
// on stderr. Asserting the same things by calling the command functions would
// test the code and skip the promise.
//
// Left to a person (§6): the ABI-mismatch exit 3 (it needs an Electron-built
// binding), the GUI cold-start chain (a window, and sound), and whether an
// agent can actually use the exported skill (M7).

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireWriterLock,
  backupNest,
  nestFingerprint,
  realpathMissingOk,
} from '../packages/core/dist/index.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'apps/cli/dist/index.js');
const DAEMON_URL = 'http://127.0.0.1:47100';

/** A live single-part video: no LLM needed, and its cid is stable. */
const VIDEO_URL = 'https://www.bilibili.com/video/BV1GJ411x7h7';
/** The test favourites folder (§8.10): 4 items, one page, anonymous. */
const FAVOURITES_URL = 'https://space.bilibili.com/667092648/favlist?fid=3975154248&ftype=create';

const keep = process.argv.includes('--keep');
const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ─── Driving the CLI ───────────────────────────────────

function parse(text) {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

/** Run `lark <args>` against a nest, and report everything it produced. */
function lark(args, nest, options = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, LARK_NEST_DIR: nest },
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 240_000,
  });
  const out = res.stdout ?? '';
  const err = res.stderr ?? '';
  return { code: res.status, signal: res.signal, out, err, json: parse(out), errJson: parse(err) };
}

/** The error code the CLI reported, whichever mode it was in. */
const codeOf = (res) =>
  res.errJson?.error_code ?? /\(([A-Z_]+)\)\s*$/.exec(res.err.trim())?.[1] ?? null;

/** Start a CLI invocation without waiting for it (for signals and races). */
function larkAsync(args, nest) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, LARK_NEST_DIR: nest },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  const done = new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal, out, err, json: parse(out) })),
  );
  return { child, done };
}

// ─── Fixtures ──────────────────────────────────────────

/** Every file under a nest, with size + mtime — the zero-write comparison. */
function treeSnapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const info = statSync(full);
      out[relative(root, full)] = `${info.size}:${info.mtimeMs}`;
    }
  };
  walk(root);
  return out;
}

/** WAL sidecars are the documented exemption (M4): a read-only connection makes them. */
const withoutWal = (snapshot) =>
  Object.fromEntries(Object.entries(snapshot).filter(([p]) => !/-wal$|-shm$/.test(p)));

/**
 * A `/status` stub, for the identity states no real daemon can produce.
 *
 * It runs in a CHILD PROCESS, and that is not incidental: every CLI call here
 * goes through `spawnSync`, which blocks this process's event loop — an
 * in-process server would never get to answer the probe, and every state would
 * come back as "nothing is listening".
 */
const STUB_SOURCE = `
const { createServer } = require('node:http');
const body = JSON.parse(process.argv[1]);
const server = createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: body }));
    return;
  }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, error_code: 'UNAUTHORIZED', message: 'no' }));
});
server.listen(47100, '127.0.0.1', () => console.log('ready'));
`;

function statusStub(body) {
  const child = spawn(process.execPath, ['-e', STUB_SOURCE, JSON.stringify(body)], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve(child));
    child.once('exit', () => reject(new Error('the /status stub never came up')));
  });
}

async function closeStub(child) {
  if (!child) return;
  child.kill('SIGKILL');
  await sleep(200);
}

async function daemonIsUp() {
  try {
    const res = await fetch(`${DAEMON_URL}/status`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForDaemonGone(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await daemonIsUp())) return true;
    await sleep(200);
  }
  return false;
}

let copy = null;
let second = null;
let fresh = null;
let gui = null;
let stub = null;

try {
  if (await daemonIsUp()) {
    throw new Error('something is already listening on 47100 — stop it before the acceptance run');
  }

  console.log('[1/8] copying the nest…');
  copy = await backupNest();
  const nest = copy.nestDir;
  console.log(`      ${nest}`);
  fresh = join(mkdtempSync(join(tmpdir(), 'lark-accept-fresh-')), 'nest');

  // The copy comes from a library that may still be at schema v1, and from
  // v0.2 a READ-ONLY open refuses to migrate — it writes nothing, by design.
  // So the copy is brought to the current schema the same way a user does it:
  // one daemon start. Without this the whole "no daemon" phase below fails
  // with MIGRATION_PENDING and says nothing about the CLI.
  console.log('      upgrading the copy to the current schema (one daemon start)…');
  lark(['daemon'], nest);
  lark(['stop-daemon'], nest);
  await waitForDaemonGone();

  // ── 2 · no daemon: direct, refusals, and the zero-write promise ──

  console.log('[2/8] with no daemon…');

  const statusAbsent = lark(['--json', 'status'], nest);
  check(
    '§6-18 · status with no daemon: stdout empty, one error envelope on stderr, exit 4',
    statusAbsent.code === 4 &&
      statusAbsent.out === '' &&
      statusAbsent.errJson?.error_code === 'DAEMON_UNAVAILABLE' &&
      statusAbsent.errJson?.details?.identity?.state === 'absent',
    `${statusAbsent.code} ${codeOf(statusAbsent)}`,
  );

  const freshWrite = lark(['playlist', 'create', '新歌单'], fresh);
  const freshDirect = lark(['--direct', 'playlist', 'create', '新歌单'], fresh);
  const freshRead = lark(['--json', '--direct', 'playlist', 'list'], fresh);
  check(
    '§6-3 · a fresh nest: a write needs --direct spelled out, and then initialises the library',
    freshWrite.code === 4 &&
      freshDirect.code === 0 &&
      freshRead.code === 0 &&
      freshRead.json?.data?.some((p) => p.name === '新歌单'),
    `${freshWrite.code} → ${freshDirect.code} → ${freshRead.code}`,
  );

  // A stale pid file must survive a read untouched: a CLI does not tidy up a
  // nest it may not own (M6-9).
  const pidFile = join(copy.larkDir, 'daemon.pid');
  writeFileSync(pidFile, '999999');
  const before = treeSnapshot(nest);
  const reads = [
    ['--direct', 'songs', 'list'],
    ['--direct', 'playlist', 'list'],
    ['--direct', 'cache', 'status'],
    ['--direct', 'songs', 'search', '晴'],
  ].map((args) => lark(args, nest));
  const after = treeSnapshot(nest);
  check(
    '§6-11 · direct reads write nothing — the whole tree is unchanged, stale pid file included',
    reads.every((r) => r.code === 0) &&
      JSON.stringify(withoutWal(after)) === JSON.stringify(withoutWal(before)) &&
      readFileSync(pidFile, 'utf8') === '999999',
    `${reads.map((r) => r.code).join('/')}`,
  );
  rmSync(pidFile);

  const held = acquireWriterLock({ dbPath: join(copy.larkDir, 'songs.db') });
  const busy = lark(['--direct', 'playlist', 'create', '抢锁'], nest);
  held.release();
  check(
    '§6-4 · a second direct writer is refused while the lock is held',
    busy.code === 5 && codeOf(busy) === 'WRITER_BUSY',
    `${busy.code} ${codeOf(busy)}`,
  );

  const songsDirect = lark(['--json', '--direct', 'songs', 'list'], nest);
  const anySong = songsDirect.json?.data?.[0];
  const noYes = lark(['--json', '--direct', 'songs', 'delete', anySong.id], nest);
  check(
    '§6-12 · --json without --yes refuses to prompt, and deletes nothing',
    noYes.code === 2 && noYes.errJson?.error_code === 'USAGE_ERROR',
    `${noYes.code} ${codeOf(noYes)}`,
  );

  // The direct half of the two-backend comparison; the HTTP half runs below.
  //
  // Note what is NOT here: `INVALID_ID`. Every id argument on the CLI surface
  // is a `<name|id>` that goes through resolution first, so a malformed one is
  // simply a name nothing matches — `NOT_FOUND`, on both backends. The id gate
  // still exists underneath (it is what the direct backend had to grow in T3),
  // it just has no reachable caller here.
  const MISSING_UUID = '11111111-2222-4333-8444-555555555555';
  const directCodes = {
    missingUuid: codeOf(lark(['--direct', 'songs', 'get', MISSING_UUID], nest)),
    notAUuid: codeOf(lark(['--direct', 'songs', 'get', 'nope'], nest)),
    virtualPlaylist: codeOf(lark(['--direct', 'playlist', 'delete', 'all', '--yes'], nest)),
    unknownName: codeOf(lark(['--direct', 'songs', 'get', '不存在的歌'], nest)),
    ambiguousLimit: codeOf(lark(['--direct', 'songs', 'list', '--limit', '0'], nest)),
  };
  const directPlaylists = lark(['--json', '--direct', 'playlist', 'list'], nest).json?.data ?? [];

  const help = lark(['--help'], nest);
  const version = lark(['--version'], nest);
  check(
    '§6-23 · --help / --version are plain text at exit 0 (the documented envelope exception)',
    help.code === 0 && help.out.includes('lark') && version.code === 0 && version.json === null,
    `${help.code}/${version.code}`,
  );

  // ── 3 · our daemon, started by the CLI ──

  console.log('[3/8] starting the daemon through `lark daemon`…');

  const startedAt = Date.now();
  const started = lark(['--json', 'daemon'], nest);
  const startElapsed = Date.now() - startedAt;
  const again = lark(['--json', 'daemon'], nest);
  check(
    '§6-16 · `lark daemon` starts one, returns promptly, and is idempotent',
    started.code === 0 &&
      started.json?.data?.started === true &&
      startElapsed < 8000 &&
      again.json?.data?.started === false &&
      again.json?.data?.pid === started.json?.data?.pid,
    `${startElapsed}ms, pid ${started.json?.data?.pid}`,
  );

  const statusCurrent = lark(['--json', 'status'], nest);
  check(
    '§6-18 · status with our daemon: exactly one success envelope on stdout, exit 0',
    statusCurrent.code === 0 &&
      statusCurrent.err === '' &&
      statusCurrent.out.trim().split('\n').length === 1 &&
      statusCurrent.json?.data?.identity === 'current',
    `pid ${statusCurrent.json?.data?.pid}`,
  );

  const blocked = lark(['--direct', 'playlist', 'create', '不该建'], nest);
  const readThrough = lark(['--json', '--direct', 'songs', 'list'], nest);
  check(
    '§6-2 · R31: a direct WRITE is refused next to a running daemon, a direct READ is not',
    blocked.code === 5 && codeOf(blocked) === 'DAEMON_RUNNING_BLOCKED' && readThrough.code === 0,
    `${codeOf(blocked)} / read ${readThrough.code}`,
  );

  const tokenPath = join(copy.larkDir, 'daemon-token');
  const tokenBefore = readFileSync(tokenPath, 'utf8');
  lark(['stop-daemon'], nest);
  await waitForDaemonGone();
  lark(['daemon'], nest);
  const tokenAfter = readFileSync(tokenPath, 'utf8');
  const afterRotation = lark(['--json', 'songs', 'list'], nest);
  check(
    '§6-1 · a restarted daemon rotates its token, and the next command just works',
    tokenBefore !== tokenAfter && afterRotation.code === 0,
    `${afterRotation.code}`,
  );

  // ── 4 · the library over HTTP, and the two backends compared ──

  console.log('[4/8] library round trip…');

  const httpCodes = {
    missingUuid: codeOf(lark(['songs', 'get', MISSING_UUID], nest)),
    notAUuid: codeOf(lark(['songs', 'get', 'nope'], nest)),
    virtualPlaylist: codeOf(lark(['playlist', 'delete', 'all', '--yes'], nest)),
    unknownName: codeOf(lark(['songs', 'get', '不存在的歌'], nest)),
    ambiguousLimit: codeOf(lark(['songs', 'list', '--limit', '0'], nest)),
  };
  check(
    '§6-10 · the same domain errors from both backends',
    JSON.stringify(httpCodes) === JSON.stringify(directCodes),
    `http ${JSON.stringify(httpCodes)} direct ${JSON.stringify(directCodes)}`,
  );

  const httpPlaylists = lark(['--json', 'playlist', 'list'], nest).json?.data ?? [];
  check(
    '§6-10 · both backends list the same playlists, virtual `all` first',
    httpPlaylists[0]?.id === 'all' &&
      directPlaylists[0]?.id === 'all' &&
      JSON.stringify(httpPlaylists.map((p) => p.name)) ===
        JSON.stringify(directPlaylists.map((p) => p.name)),
    `${httpPlaylists.length} vs ${directPlaylists.length}`,
  );

  lark(['playlist', 'create', '重名'], nest);
  lark(['playlist', 'create', '重名'], nest);
  const ambiguous = lark(['--json', 'playlist', 'rename', '重名', '改名'], nest);
  check(
    '§6-10 · an ambiguous name is refused with the candidates, never resolved for the user',
    ambiguous.code === 5 &&
      ambiguous.errJson?.error_code === 'AMBIGUOUS_PLAYLIST' &&
      (ambiguous.errJson?.details?.candidates?.length ?? 0) >= 2,
    `${ambiguous.code} ${ambiguous.errJson?.details?.candidates?.length} candidates`,
  );

  const exportDir = join(nest, 'exports');
  const exported = lark(['--json', 'playlist', 'export', 'all', '-o', `${exportDir}/`], nest);
  const exportPath = exported.json?.data?.path;
  const imported = lark(
    ['--json', '--yes', 'playlist', 'import', exportPath, '--new', '导入回来'],
    nest,
  );
  const overwrite = lark(['--json', 'playlist', 'export', 'all', '-o', exportPath], nest);
  check(
    '§6-12 · export writes into a directory that did not exist, import brings it back, overwrite asks',
    exported.code === 0 &&
      existsSync(exportPath) &&
      imported.code === 0 &&
      imported.json?.data?.total > 0 &&
      overwrite.code === 2,
    `${exportPath} → ${imported.json?.data?.total} songs, overwrite ${overwrite.code}`,
  );

  // ── 5 · downloading, for real ──

  console.log('[5/8] downloading (real bilibili)…');

  const single = lark(['--json', 'download', VIDEO_URL], nest);
  check(
    '§6-13 · a single download is followed to its terminal state',
    single.code === 0 && single.json?.data?.state === 'succeeded' && single.json?.data?.result,
    `${single.code} ${single.json?.data?.state}`,
  );

  const tooLong = lark(['download', 'x'.repeat(9000)], nest);
  const bothSources = lark(['download', VIDEO_URL, '--batch', '-'], nest);
  check(
    '§6-13 · the local pre-checks refuse before any request',
    tooLong.code === 2 && bothSources.code === 2,
    `${tooLong.code}/${bothSources.code}`,
  );

  const favourites = lark(['--json', '--yes', 'download', FAVOURITES_URL, '--wait'], nest, {
    timeoutMs: 600_000,
  });
  const batch = favourites.json?.data;
  check(
    '§6-13 · a favourites folder expands, asks, and every item reaches a terminal state',
    favourites.code === 0 &&
      batch?.items?.length === 4 &&
      batch.items.every((item) => item.final?.state === 'succeeded'),
    `${favourites.code} ${batch?.items?.filter((i) => i.final?.state === 'succeeded').length}/4`,
  );

  const waiting = larkAsync(['download', VIDEO_URL], nest);
  await sleep(1200);
  waiting.child.kill('SIGINT');
  const interrupted = await waiting.done;
  check(
    '§6-21 · Ctrl-C during a --wait ends the CLI (the shell reports 130); the task stays behind',
    interrupted.signal === 'SIGINT' || interrupted.code === 130,
    `${interrupted.code} ${interrupted.signal}`,
  );

  // ── 6 · playback, against the GUI simulator ──

  console.log('[6/8] player commands…');

  const library = lark(['--json', 'songs', 'list'], nest).json?.data ?? [];
  const playable = library.find((song) => song.has_file);

  const noGui = lark(['play', playable.id, '--no-launch'], nest);
  const noArgs = lark(['play'], nest);
  check(
    '§6-15 · `play --no-launch` reports instead of starting anything, and `play` alone is a usage error',
    noGui.code === 4 && codeOf(noGui) === 'GUI_OFFLINE' && noArgs.code === 2,
    `${noGui.code}/${noArgs.code}`,
  );

  gui = spawn(process.execPath, [join(ROOT, 'scripts/demo-gui-sim.mjs')], {
    cwd: ROOT,
    env: { ...process.env, LARK_NEST_DIR: nest },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await sleep(1500);

  const played = lark(['--json', 'play', playable.id], nest);
  const nowPlaying = lark(['--json', 'now-playing'], nest);
  check(
    '§6-15 · a command the GUI acknowledges is exit 0, and now-playing sees it online',
    played.code === 0 &&
      played.json?.data?.request_id &&
      nowPlaying.json?.data?.gui_online === true,
    `${played.code} gui_online=${nowPlaying.json?.data?.gui_online}`,
  );

  gui.kill('SIGTERM');
  gui = null;
  await sleep(1000);
  const afterGuiGone = lark(['pause'], nest);
  check(
    '§6-15 · with the GUI gone, a player command is exit 4 rather than a hang',
    afterGuiGone.code === 4 && codeOf(afterGuiGone) === 'GUI_OFFLINE',
    `${afterGuiGone.code} ${codeOf(afterGuiGone)}`,
  );

  // ── 7 · cache, lyrics, skill ──

  console.log('[7/8] cache, lyrics, skill…');

  const cacheHttp = lark(['--json', 'cache', 'status'], nest);
  const evicted = lark(['--json', '--yes', 'cache', 'evict'], nest, { timeoutMs: 300_000 });
  const importedStillThere = (lark(['--json', 'songs', 'list'], nest).json?.data ?? []).filter(
    (song) => song.file_origin === 'imported',
  );
  check(
    '§6-14 · cache status reports, eviction runs, and imported files are never touched (R1)',
    cacheHttp.code === 0 && evicted.code === 0 && importedStillThere.every((song) => song.has_file),
    `freed ${evicted.json?.data?.freed_bytes} bytes, ${importedStillThere.length} imported intact`,
  );

  const downloaded = (lark(['--json', 'songs', 'list'], nest).json?.data ?? []).find(
    (song) => song.source_key !== null && song.has_file,
  );
  const lyricsGone = lark(['--json', '--yes', 'lyrics', 'delete', downloaded.id], nest);
  const lyricsAgain = lark(['--json', '--yes', 'lyrics', 'delete', downloaded.id], nest);
  check(
    '§6-19 · a destructive command with --yes goes through, and the second one finds nothing left',
    lyricsGone.code === 0 && lyricsAgain.code === 1 && codeOf(lyricsAgain) === 'LYRICS_NOT_FOUND',
    `${lyricsGone.code} → ${lyricsAgain.code}`,
  );

  const skill = lark(['--json', 'skill', 'export'], nest);
  const skillPath = skill.json?.data?.path;

  // ── 8 · the identity states ──

  console.log('[8/8] identity states…');

  lark(['stop-daemon'], nest);
  await waitForDaemonGone();

  // The backup has to come AFTER the daemon is down: `backupNest` refuses to
  // copy a nest somebody is still writing to (M4-14⑧).
  const skillCopy = await backupNest({
    target: join(tmpdir(), `lark-accept-skillcopy-${process.pid}`),
  });
  const copiedSkill = existsSync(join(skillCopy.larkDir, 'lark-skill.md'));
  rmSync(skillCopy.nestDir, { recursive: true, force: true });
  check(
    '§6-20 · skill export lands in the nest, and a backup never carries it along',
    skill.code === 0 && existsSync(skillPath) && !copiedSkill,
    `${skillPath}`,
  );
  const stoppedTwice = lark(['--json', 'stop-daemon'], nest);
  check(
    '§6-16 · stop-daemon is idempotent: nothing running is a success with a null pid',
    stoppedTwice.code === 0 && stoppedTwice.json?.data?.stopped === false,
    `${stoppedTwice.code}`,
  );

  // Another nest's daemon holds the port: HTTP is refused by fingerprint, a
  // read still works directly, and a direct WRITE is allowed because our own
  // pid file is clean (§6-7).
  second = await backupNest({ target: join(tmpdir(), `lark-accept-second-${process.pid}`) });
  lark(['daemon'], second.nestDir);
  const otherStatus = lark(['--json', 'status'], nest);
  const otherRead = lark(['--json', 'songs', 'list'], nest);
  const otherWrite = lark(['--direct', 'playlist', 'create', '本地写'], nest);
  const otherDownload = lark(['download', VIDEO_URL], nest);
  check(
    '§6-7 · another nest on the port: HTTP refused, direct read fine, direct write allowed',
    otherStatus.code === 5 &&
      codeOf(otherStatus) === 'DAEMON_OTHER_NEST' &&
      otherRead.code === 0 &&
      otherWrite.code === 0 &&
      otherDownload.code === 5 &&
      codeOf(otherDownload) === 'DAEMON_OTHER_NEST',
    `${codeOf(otherStatus)} / read ${otherRead.code} / write ${otherWrite.code}`,
  );

  lark(['stop-daemon'], second.nestDir);
  await waitForDaemonGone();

  const fingerprint = nestFingerprint(realpathMissingOk(copy.larkDir));
  stub = await statusStub({
    status: 'ok',
    pid: process.pid,
    version: '0.0.9',
    uptime: 1,
    nest_fingerprint: fingerprint,
    local_api_version: 2,
  });
  const incompatible = lark(['--json', 'status'], nest);
  const incompatibleWrite = lark(['--direct', 'playlist', 'create', '不该建'], nest);
  await closeStub(stub);

  stub = await statusStub({
    status: 'ok',
    pid: process.pid,
    version: '0.0.9',
    uptime: 1,
    nest_fingerprint: 'not-a-fingerprint',
    local_api_version: 3,
  });
  const unverifiable = lark(['--json', 'status'], nest);
  await closeStub(stub);
  stub = null;

  check(
    '§6-8/9 · our nest but the wrong protocol is INCOMPATIBLE; a malformed fingerprint is UNVERIFIED',
    incompatible.code === 5 &&
      codeOf(incompatible) === 'DAEMON_INCOMPATIBLE' &&
      incompatibleWrite.code === 5 &&
      unverifiable.code === 5 &&
      codeOf(unverifiable) === 'DAEMON_UNVERIFIED',
    `${codeOf(incompatible)} / ${codeOf(unverifiable)}`,
  );
} finally {
  if (gui) gui.kill('SIGKILL');
  await closeStub(stub);
  for (const target of [copy, second]) {
    if (target) {
      lark(['stop-daemon'], target.nestDir);
      await waitForDaemonGone(4000);
    }
  }
  if (keep) {
    console.log(`\ncopy kept at ${copy?.nestDir}`);
  } else {
    for (const dir of [copy?.nestDir, second?.nestDir, fresh && dirname(fresh)]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
console.log('manual (§6): ABI mismatch exit 3 · the GUI cold-start chain · skill usability (M7)');
process.exit(passed === results.length ? 0 : 1);
