#!/usr/bin/env node
// `just accept-pack <bundled|system> <dmg> <tgz>` — the M7 acceptance matrix
// (plan §3.5), run against the artifacts that are about to be published.
//
// THE DMG-ONLY RULE (M7-19/H3). Criteria 2–5 and 10 touch ONE app: the copy
// inside the .dmg passed on the command line, mounted read-only. Not
// `release/<mode>/mac-arm64/Lark.app`, which is where electron-builder left a
// staging copy — verifying that one and shipping the other is how a release
// gets signed off on something nobody tested. The mount is asserted to hold
// exactly one Lark.app, and the dmg's SHA-256 is taken before and after the
// whole run to prove nothing here modified what gets uploaded.
//
// THE CLI IS THE INSTALLED ONE. Criteria 6, 7 and 10 run the copy `npm i -g`
// put in a temp prefix, never `apps/cli/dist-publish/index.js`. Measured the
// hard way (§8.6): run the bundle from inside the repo and the workspace walk
// still succeeds, so `LARK_APP_PATH` is ignored and the packaged locators are
// never reached — the criterion silently measures the dev branch.
//
// ABI ORDER IS THE CONTRACT (E11). Phase ① is everything that needs
// better-sqlite3 loadable by Node (the nest copy, the tarball's own smoke).
// Phase ② switches to the Electron ABI and never switches back — the caller
// runs `just unpackage` afterwards, which every recipe here assumes.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForLibraryReady } from './lib/library-ready.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The wire version the release is supposed to carry.
 *
 * A LITERAL on purpose: `§9` compares it against the source constant, so
 * reading the source into both sides would only prove the file equals itself.
 * Bumping it is the deliberate act — 6 → 7 when N7 added `GET /workspaces` and
 * `POST /workspaces/switch`.
 */
const EXPECTED_API_VERSION = 7;
const DAEMON_URL = 'http://127.0.0.1:47100';
const CDP_PORT = 9334;

const [mode, dmgArg, tgzArg] = process.argv.slice(2);
if (!['bundled', 'system'].includes(mode) || !dmgArg || !tgzArg) {
  console.error('usage: accept-pack.mjs <bundled|system> <dmg> <tgz>');
  process.exit(2);
}
const DMG = join(ROOT, dmgArg.startsWith('/') ? '' : '.', dmgArg);
const TGZ = join(ROOT, tgzArg.startsWith('/') ? '' : '.', tgzArg);

const keep = process.argv.includes('--keep');
const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function sh(command, args, options = {}) {
  const res = spawnSync(command, args, { encoding: 'utf8', ...options });
  return { code: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/**
 * The environment every child in this script gets.
 *
 * `LARK_MEDIA_TOOLS_DIR` is scrubbed on purpose: the justfile exports the
 * repo's vendored toolchain for dev runs, and inheriting it here would let a
 * `system` build resolve ffmpeg through the developer's checkout — the one
 * thing this acceptance is supposed to be able to tell apart.
 */
function cleanEnv(extra = {}) {
  // Destructured away rather than `delete`d: Biome bans the operator, and
  // assigning `undefined` would put the STRING "undefined" in the environment.
  const {
    LARK_MEDIA_TOOLS_DIR: _tools,
    LARK_FFMPEG_PATH: _ffmpeg,
    LARK_FFPROBE_PATH: _ffprobe,
    ...rest
  } = { ...process.env, ...extra };
  return rest;
}

// ─── The mounted DMG ───────────────────────────────────

function mountDmg(path) {
  const res = sh('hdiutil', [
    'attach',
    path,
    '-readonly',
    '-nobrowse',
    '-mountrandom',
    '/tmp',
    '-plist',
  ]);
  if (res.code !== 0) throw new Error(`hdiutil attach failed: ${res.out}`);
  // Parse the `mount-point` key, not "any /tmp-looking string": macOS answers
  // with the resolved `/private/tmp/...`, and -mountrandom's argument is only
  // the parent directory.
  const point = res.out.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  if (!point) throw new Error(`could not find the mount point in:\n${res.out}`);
  return point;
}

function unmountDmg(point) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (sh('hdiutil', ['detach', point]).code === 0) return;
    execFileSync('/bin/sleep', ['1']);
  }
  sh('hdiutil', ['detach', point, '-force']);
}

// ─── Criteria ──────────────────────────────────────────

function judge1(point, before) {
  const named = /^Lark-\d+\.\d+\.\d+-arm64\.dmg$/.test(dmgArg.split('/').pop());
  const apps = readdirSync(point).filter((entry) => entry.endsWith('.app'));
  check(
    '§1 · the dmg is named for a release and holds exactly one Lark.app',
    named && apps.length === 1 && apps[0] === 'Lark.app',
    `${dmgArg.split('/').pop()} → ${apps.join(', ') || '(no app)'}`,
  );
  return { before };
}

function judge2(app) {
  const info = sh('codesign', ['-dv', '--verbose=2', app]).out;
  const verified = sh('codesign', ['--verify', '--deep', '--strict', app]).code === 0;
  check(
    '§2 · the mounted app is ad-hoc signed and verifies',
    verified && /flags=0x2\(adhoc\)/.test(info) && /Identifier=com\.orpheusaviary\.lark/.test(info),
    `${verified ? 'verified' : 'VERIFY FAILED'}; ${info.match(/flags=[^\s]+/)?.[0] ?? 'no flags'}`,
  );
}

function judge3(app) {
  const resources = join(app, 'Contents/Resources');
  const appDir = join(resources, 'app');

  // "Path A": the workspace packages are REAL directories in the bundle, not
  // symlinks into a checkout that will not exist on the user's machine.
  const core = join(appDir, 'node_modules/@lark/core/dist/index.js');
  const daemon = join(appDir, 'node_modules/@lark/daemon/dist/cli.js');
  const binding = join(appDir, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
  const realDirs =
    existsSync(core) &&
    existsSync(daemon) &&
    !statSync(join(appDir, 'node_modules/@lark/core')).isSymbolicLink();

  check(
    '§3a · workspace dist and the native binding are real files in the bundle',
    realDirs && existsSync(binding),
    `core=${existsSync(core)} daemon=${existsSync(daemon)} node=${existsSync(binding)}`,
  );

  const license = join(resources, 'LICENSE');
  const notices = join(resources, 'THIRD-PARTY-NOTICES.md');
  check(
    '§3b · the licence and the third-party notices ship inside the app',
    existsSync(license) && existsSync(notices),
    `LICENSE=${existsSync(license)} NOTICES=${existsSync(notices)}`,
  );

  // The drift guard, against the SHIPPED file: a dependency added since the
  // notice was generated is an obligation nobody delivered.
  const coverage = sh('node', [join(ROOT, 'scripts/gen-notices.mjs'), mode, '--check', notices]);
  check(
    '§3c · every production dependency appears in the shipped notice',
    coverage.code === 0,
    coverage.out.trim().split('\n').pop() ?? '',
  );

  return { resources, notices };
}

/** bundled: the toolchain is there, is what the lock says, and actually works. */
function judge3Bundled(resources, work) {
  const dir = join(resources, 'ffmpeg');
  const ffmpeg = join(dir, 'ffmpeg');
  const ffprobe = join(dir, 'ffprobe');
  if (!existsSync(ffmpeg) || !existsSync(ffprobe)) {
    check('§3d · bundled: Resources/ffmpeg carries both tools', false, `${dir} is incomplete`);
    return;
  }
  const executable = [ffmpeg, ffprobe].every((p) => (statSync(p).mode & 0o111) !== 0);
  check('§3d · bundled: Resources/ffmpeg carries both tools, executable', executable);

  const lock = JSON.parse(readFileSync(join(ROOT, 'vendor/ffmpeg.lock.json'), 'utf8'));
  const version = sh(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_program_version']);
  let configuration = '';
  try {
    configuration = JSON.parse(version.out).program_version.configuration;
  } catch {
    configuration = '';
  }
  check(
    '§3e · bundled: configure matches the lock byte for byte, and is not nonfree',
    configuration === lock.configure && !configuration.includes('--enable-nonfree'),
    configuration === lock.configure ? 'matches' : `differs:\n  ${configuration}`,
  );

  // The one thing a stub cannot fake. Run with the binaries taken out of the
  // MOUNTED app, on the mp3 a 0.2.x library is full of, and read the result
  // back with its own ffprobe — this is the migration's conversion, performed
  // by the binaries about to ship.
  const out = join(work, 'closed-loop.m4a');
  const transcode = sh(ffmpeg, [
    '-nostdin',
    '-v',
    'error',
    '-i',
    join(ROOT, 'scripts/fixtures/tone-1s.mp3'),
    '-map',
    '0:0',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-f',
    'ipod',
    '-y',
    out,
  ]);
  const probe = sh(ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'format=duration,format_name:stream=codec_name',
    '-of',
    'json',
    out,
  ]);
  let format = null;
  let codec = null;
  try {
    const parsed = JSON.parse(probe.out);
    format = parsed.format;
    codec = parsed.streams?.[0]?.codec_name;
  } catch {
    format = null;
  }
  check(
    '§3f · bundled: the shipped binaries really convert MP3 → m4a → ffprobe json',
    transcode.code === 0 &&
      String(format?.format_name).split(',').includes('m4a') &&
      codec === 'aac' &&
      Number(format?.duration) > 0.5,
    format
      ? `${format.format_name} ${codec} ${format.duration}s`
      : transcode.out.trim().slice(0, 120),
  );

  const notices = readFileSync(join(resources, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  check(
    '§3g · bundled: the notice carries FFmpeg and every statically linked library',
    notices.includes('## FFmpeg') &&
      lock.sources.every((s) => notices.includes(`### ${s.name} ${s.version}`)),
  );
}

/** system: no toolchain at all, and a notice that does not pretend otherwise. */
function judge3System(resources) {
  const dir = join(resources, 'ffmpeg');
  check('§3d · system: the app carries no ffmpeg', !existsSync(dir), dir);

  const notices = readFileSync(join(resources, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  check(
    '§3e · system: the notice has no FFmpeg section but the common one is complete',
    !notices.includes('## FFmpeg') && notices.includes('### react '),
  );
}

function judge9() {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const manifests = [
    'package.json',
    'packages/shared/package.json',
    'packages/core/package.json',
    'packages/daemon/package.json',
    'packages/gui/package.json',
    'apps/cli/package.json',
  ].map((p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8')).version);

  const constants = [
    readFileSync(join(ROOT, 'packages/daemon/src/version.ts'), 'utf8').match(
      /DAEMON_VERSION = '([^']+)'/,
    )?.[1],
    readFileSync(join(ROOT, 'apps/cli/src/version.ts'), 'utf8').match(/'([\d.]+)'/)?.[1],
    readFileSync(join(ROOT, 'packages/gui/src/shared/version.ts'), 'utf8').match(/'([\d.]+)'/)?.[1],
  ];

  const engines = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines.node;
  const apiVersion = readFileSync(join(ROOT, 'packages/shared/src/api-paths.ts'), 'utf8').match(
    /LOCAL_API_VERSION = (\d+)/,
  )?.[1];

  check(
    '§9 · every manifest and constant carries the release version',
    manifests.every((v) => v === version) && constants.every((v) => v === version),
    `${version}: manifests ${[...new Set(manifests)].join('/')}, constants ${[...new Set(constants)].join('/')}`,
  );
  check('§9 · root engines require Node 24', engines === '>=24', engines);
  check(
    `§9 · LOCAL_API_VERSION is ${EXPECTED_API_VERSION}`,
    apiVersion === String(EXPECTED_API_VERSION),
    apiVersion ?? '(not found)',
  );
}

/** Criterion 8, which is also how criteria 6/7/10 get a CLI to drive. */
function installCli(work) {
  const prefix = join(work, 'npm-prefix');
  const install = sh('npm', ['i', '-g', '--prefix', prefix, TGZ], { env: cleanEnv() });
  const bin = join(prefix, 'bin');
  const bothBins = existsSync(join(bin, 'lark')) && existsSync(join(bin, 'lark-cli'));

  const version = sh(join(bin, 'lark'), ['--version'], { env: cleanEnv() });
  check(
    '§8 · the tarball installs into a clean prefix and puts both bins on PATH',
    install.code === 0 && bothBins && version.code === 0,
    bothBins ? `lark --version → ${version.out.trim()}` : install.out.trim().slice(-200),
  );
  return join(bin, 'lark');
}

// ─── Runtime criteria ──────────────────────────────────
//
// NOTHING here flips the repo's better-sqlite3 ABI, and it does not need to.
// Every runtime under test brings its own binding: the daemon runs the app
// bundle's, and the installed CLI runs the one `npm i -g` built for the host
// Node. "The other ABI" is produced by running the INSTALLED CLI under the
// app's Electron, which is a real mismatch and needs no repo surgery.

const larkDirOf = (nest) => join(nest, 'lark');

function larkRun(cli, args, nest, extraEnv = {}) {
  const res = spawnSync(cli, args, {
    encoding: 'utf8',
    env: cleanEnv({ LARK_NEST_DIR: nest, ...extraEnv }),
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** The same CLI, run by the app bundle's Electron — i.e. on the other ABI. */
function larkUnderElectron(app, cliEntry, args, nest, extraEnv = {}) {
  const res = spawnSync(join(app, 'Contents/MacOS/Lark'), [cliEntry, ...args], {
    encoding: 'utf8',
    env: cleanEnv({ LARK_NEST_DIR: nest, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }),
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const envelope = (run) => {
  try {
    return JSON.parse((run.stdout || run.stderr).trim());
  } catch {
    return null;
  }
};

async function waitForDaemon(up, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${DAEMON_URL}/status`, { signal: AbortSignal.timeout(1000) });
      if (up && res.ok) {
        // The nest copy may still be at schema v2: this daemon answers while it
        // converts the library's audio, and refuses everything else (§3.2-3).
        const data = await waitForLibraryReady(DAEMON_URL, { log: (line) => console.log(line) });
        return { data };
      }
    } catch {
      if (!up) return null;
    }
    await sleep(300);
  }
  return up ? null : 'still listening';
}

const tokenOf = (nest) => readFileSync(join(larkDirOf(nest), 'daemon-token'), 'utf8').trim();

async function capabilities(nest) {
  const res = await fetch(`${DAEMON_URL}/api/capabilities`, {
    headers: { Authorization: `Bearer ${tokenOf(nest)}` },
  });
  return (await res.json()).data;
}

/** Criterion 6: the CLI's own contract, on both runtimes. */
async function judge6(cli, cliEntry, app, nest) {
  for (const [label, run] of [
    ['node', (args) => larkRun(cli, args, nest)],
    ['electron', (args) => larkUnderElectron(app, cliEntry, args, nest)],
  ]) {
    const help = run(['--help']);
    const status = run(['status', '--json']);
    check(
      `§6 · ${label}: --help exits 0, and status with no daemon is exit 4 + DAEMON_UNAVAILABLE`,
      help.code === 0 && status.code === 4 && envelope(status)?.error_code === 'DAEMON_UNAVAILABLE',
      `help=${help.code} status=${status.code} ${envelope(status)?.error_code ?? ''}`,
    );
  }
}

/** Criterion 7: --direct on the runtime the binding was not built for. */
function judge7(app, cliEntry, nest) {
  const run = larkUnderElectron(app, cliEntry, ['songs', 'list', '--direct', '--json'], nest);
  check(
    '§7 · --direct on the wrong ABI is exit 3 + ABI_MISMATCH, not a dlopen stack',
    run.code === 3 && envelope(run)?.error_code === 'ABI_MISMATCH',
    `${run.code} ${envelope(run)?.error_code ?? (run.stdout || run.stderr).trim().slice(0, 90)}`,
  );
}

/** Criterion 4: a cold start out of the mounted app, over a copy of the nest. */
async function judge4(cli, app, nest) {
  const start = larkRun(cli, ['daemon', '--json'], nest, { LARK_APP_PATH: app });
  const status = await waitForDaemon(true);
  const fromBundle = sh('/bin/ps', [
    '-p',
    String(envelope(start)?.data?.pid ?? 0),
    '-o',
    'command=',
  ]).out;

  check(
    '§4a · the daemon starts from inside the mounted app and answers /status',
    start.code === 0 &&
      status?.data?.local_api_version === EXPECTED_API_VERSION &&
      fromBundle.includes(app),
    `pid=${envelope(start)?.data?.pid} api=${status?.data?.local_api_version}`,
  );

  const caps = await capabilities(nest);
  const tools = caps?.media_tools;
  const expectedSource = mode === 'bundled' ? 'bundle' : 'homebrew';
  check(
    `§4b · capabilities carries media_tools, ready, source=${expectedSource}`,
    tools?.state === 'ready' &&
      tools.ffmpeg?.source === expectedSource &&
      (mode !== 'bundled' || tools.ffmpeg.path.startsWith(app)),
    JSON.stringify(tools),
  );

  larkRun(cli, ['stop-daemon'], nest, { LARK_APP_PATH: app });
  await waitForDaemon(false, 8000);
}

/**
 * Criterion 4, the other two states.
 *
 * Produced honestly: the bundle's own boot-child is started with its media
 * search path pointed at an empty directory, so a REAL packaged daemon reports
 * `missing` without anything on this machine being moved. The shipped daemon
 * has no such switch — this is the same containment M2 used for its test knobs.
 */
async function judge4Missing(cli, app, nest) {
  const empty = mkdtempSync(join(tmpdir(), 'lark-no-tools-'));
  const bootChild = join(
    app,
    'Contents/Resources/app/node_modules/@lark/daemon/dist/testing/boot-child.js',
  );
  const child = spawn(join(app, 'Contents/MacOS/Lark'), [bootChild], {
    env: cleanEnv({
      LARK_NEST_DIR: nest,
      ELECTRON_RUN_AS_NODE: '1',
      LARK_DAEMON_TEST_PORT: '47100',
      LARK_TEST_MEDIA_TOOL_DIRS: empty,
      PATH: '/nonexistent',
    }),
    stdio: 'ignore',
  });

  try {
    const status = await waitForDaemon(true, 20_000);
    const tools = (await capabilities(nest))?.media_tools;
    check(
      '§4c · a daemon that can find no ffmpeg reports missing, with a reason and no paths',
      status !== null && tools?.state === 'missing' && tools.ffmpeg === null && !!tools.detail,
      JSON.stringify(tools),
    );

    // And the refusal reaches the surfaces a user touches — as its own code,
    // never as "this file is bad" (M7-18).
    const importRes = await fetch(`${DAEMON_URL}/songs/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOf(nest)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_paths: [join(ROOT, 'scripts/fixtures/tone-1s.m4a')] }),
    });
    const importBody = await importRes.json();
    check(
      '§4d · import refuses with MEDIA_TOOLS_UNAVAILABLE (503) instead of blaming the file',
      importRes.status === 503 && importBody.error_code === 'MEDIA_TOOLS_UNAVAILABLE',
      `${importRes.status} ${importBody.error_code}`,
    );

    const download = larkRun(cli, ['download', 'BV1GJ411x7h7', '--wait', '--json'], nest, {
      LARK_APP_PATH: app,
    });
    const failure = envelope(download);
    check(
      '§4e · a download fails for the same reason, before it fetches anything',
      download.code !== 0 && JSON.stringify(failure ?? {}).includes('MEDIA_TOOLS_UNAVAILABLE'),
      `${download.code} ${JSON.stringify(failure)?.slice(0, 140)}`,
    );
  } finally {
    child.kill('SIGTERM');
    await waitForDaemon(false, 8000);
    rmSync(empty, { recursive: true, force: true });
  }
}

/** Criterion 10: the packaged locators, driven by the INSTALLED cli. */
async function judge10(cli, app, nest) {
  const bad = larkRun(cli, ['daemon', '--json'], nest, { LARK_APP_PATH: '/tmp/not-an-app.app' });
  check(
    '§10a · an invalid LARK_APP_PATH fails immediately instead of falling back',
    bad.code === 2 && envelope(bad)?.error_code === 'USAGE_ERROR',
    `${bad.code} ${envelope(bad)?.error_code ?? ''}`,
  );

  const start = larkRun(cli, ['daemon', '--json'], nest, { LARK_APP_PATH: app });
  await waitForDaemon(true);
  const gui = larkRun(cli, ['gui', '--json'], nest, { LARK_APP_PATH: app });
  const guiOk = gui.code === 0 && envelope(gui)?.data?.gui_online === true;

  check(
    '§10b · `lark daemon` and `lark gui` really start out of the mounted app',
    start.code === 0 && guiOk,
    `daemon=${start.code} gui=${gui.code} ${JSON.stringify(envelope(gui)?.data ?? {})}`,
  );

  // The window is a real app; close it before anything else runs.
  sh('/usr/bin/osascript', ['-e', 'tell application "Lark" to quit']);
  await sleep(1500);
  larkRun(cli, ['stop-daemon'], nest, { LARK_APP_PATH: app });
  await waitForDaemon(false, 8000);
}

// ─── Criterion 5: the media criteria, against the packaged renderer ────
//
// M7-17: the DRIVER may change, the OBJECT may not. `open` gives no way to
// pass a debugging port, so the app binary is spawned directly — still the app
// inside the mounted dmg, never a bare Electron pointed at a source tree.

async function connectCdp() {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return await openSocket(page.webSocketDebuggerUrl);
    } catch {
      // devtools not listening yet
    }
    await sleep(500);
  }
  throw new Error('no renderer target appeared on the debugging port');
}

async function openSocket(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const waiters = new Map();
  const errors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiters.has(msg.id)) {
      const waiter = waiters.get(msg.id);
      waiters.delete(msg.id);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
      return;
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(msg.params.entry.text);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiters.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result.value;
  };
  await send('Runtime.enable');
  await send('Log.enable');
  return { evaluate, errors, close: () => ws.close() };
}

/** The daemon's own `audio range` debug lines, out of the copy's log. */
function audioLog(nest) {
  const dir = join(larkDirOf(nest), 'logs');
  let raw = '';
  try {
    // pino-roll writes `lark.log.1`, `lark.log.2`, … — never a bare `lark.log`,
    // even though that is the path the daemon prints.
    for (const name of readdirSync(dir)
      .filter((f) => f.startsWith('lark.log'))
      .sort()) {
      raw += readFileSync(join(dir, name), 'utf8');
    }
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.includes('"msg":"audio range"'))
    .map((line) => JSON.parse(line));
}

/** Debug level in the COPY, so those lines exist at all. */
function enableDebugLog(nest) {
  const path = join(larkDirOf(nest), 'lark_config.toml');
  const current = readFileSync(path, 'utf8');
  const next = current.includes('[log]')
    ? current.replace(/\[log\][\s\S]*?(?=\n\[|$)/, '[log]\nlevel = "debug"\n')
    : `${current}\n[log]\nlevel = "debug"\n`;
  writeFileSync(path, next, { mode: 0o600 });
}

const player = (nest, path, body) =>
  fetch(`${DAEMON_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenOf(nest)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const AUDIO_STATE = `(() => {
  const el = document.querySelector('audio');
  return el && { src: el.src, paused: el.paused, time: el.currentTime,
                 duration: el.duration, error: el.error ? el.error.code : null };
})()`;

async function judge5(cli, app, nest) {
  enableDebugLog(nest);
  larkRun(cli, ['daemon'], nest, { LARK_APP_PATH: app });
  await waitForDaemon(true);

  const songs = await fetch(`${DAEMON_URL}/songs?limit=100`, {
    headers: { Authorization: `Bearer ${tokenOf(nest)}` },
  }).then((r) => r.json());
  const playable = (songs.data ?? []).find((s) => s.has_file === true && s.duration > 30);
  if (playable === undefined) {
    check('§5 · the nest copy has a playable song to exercise the media path', false);
    larkRun(cli, ['stop-daemon'], nest, { LARK_APP_PATH: app });
    await waitForDaemon(false, 8000);
    return;
  }

  // The app from the MOUNT, spawned directly rather than through `open`: the
  // driver may change, the object may not (M7-17).
  const gui = spawn(join(app, 'Contents/MacOS/Lark'), [`--remote-debugging-port=${CDP_PORT}`], {
    env: cleanEnv({ LARK_NEST_DIR: nest }),
    stdio: 'ignore',
  });

  let cdp = null;
  try {
    cdp = await connectCdp();
    await sleep(4000);
    const token = tokenOf(nest);

    // Playback is driven through the daemon's player command, the same way
    // accept-gui does it — the renderer is the thing under test, not the
    // script's ability to poke a DOM element.
    await player(nest, '/player/play', { song_id: playable.id });
    await sleep(5000);
    const playing = await cdp.evaluate(AUDIO_STATE);
    check(
      '§5a · lark-media:// plays out of the packaged app',
      playing?.src?.startsWith('lark-media://song/') === true &&
        playing.error === null &&
        playing.time > 0.5,
      `t=${playing?.time?.toFixed?.(1)} err=${playing?.error ?? 'none'}`,
    );

    const before = audioLog(nest).length;
    await player(nest, '/player/seek', { position: Math.floor(playable.duration * 0.9) });
    await sleep(5000);
    const fresh = audioLog(nest).slice(before);
    // The log records the Range HEADER, not a parsed offset — a seek is a
    // request whose start is past the beginning.
    const startOf = (line) => Number(/bytes=(\d+)-/.exec(line.range ?? '')?.[1] ?? -1);
    check(
      '§5b · a seek produces a fresh Range request answered with 206',
      fresh.length > 0 && fresh.some((line) => line.status === 206 && startOf(line) > 0),
      `${fresh.length} range lines; ${fresh
        .map((l) => `${l.status}@${startOf(l)}`)
        .slice(0, 3)
        .join(' ')}`,
    );

    const tokenInDom = await cdp.evaluate(
      `document.documentElement.outerHTML.includes(${JSON.stringify(token)}) || document.documentElement.outerHTML.includes('Bearer')`,
    );
    const violations = cdp.errors.filter(
      (text) => text.includes('Content Security Policy') || text.includes('Refused to'),
    );
    check(
      '§5c · the production CSP is silent and the token is nowhere in the page',
      tokenInDom === false && violations.length === 0,
      violations.slice(0, 2).join(' | '),
    );

    // Rotation: a restart mints a new token, and the main process re-reads it
    // per request — so the SAME renderer keeps streaming without a reload.
    larkRun(cli, ['stop-daemon'], nest, { LARK_APP_PATH: app });
    await waitForDaemon(false, 8000);
    larkRun(cli, ['daemon'], nest, { LARK_APP_PATH: app });
    await waitForDaemon(true);
    const rotated = tokenOf(nest) !== token;
    await sleep(9000);
    const recovered = await cdp.evaluate(AUDIO_STATE);
    check(
      '§5d · the token rotated and playback survived it without a reload',
      rotated && recovered?.error === null,
      `rotated=${rotated} err=${recovered?.error ?? 'none'} t=${recovered?.time?.toFixed?.(1)}`,
    );
  } finally {
    cdp?.close();
    gui.kill('SIGTERM');
    await sleep(2000);
    if (gui.exitCode === null) gui.kill('SIGKILL');
    larkRun(cli, ['stop-daemon'], nest, { LARK_APP_PATH: app });
    await waitForDaemon(false, 8000);
  }
}

// ─── The run ───────────────────────────────────────────

const work = mkdtempSync(join(tmpdir(), 'lark-accept-pack-'));
let mountPoint = null;
let nest = null;

try {
  if (!existsSync(DMG)) throw new Error(`no dmg at ${DMG}`);
  if (!existsSync(TGZ)) throw new Error(`no tarball at ${TGZ}`);

  const shaBefore = sha256(DMG);
  console.log(`[1/5] mounting ${DMG} read-only…`);
  mountPoint = mountDmg(DMG);
  const app = join(mountPoint, 'Lark.app');

  judge1(mountPoint, shaBefore);
  judge2(app);
  const { resources } = judge3(app);
  if (mode === 'bundled') judge3Bundled(resources, work);
  else judge3System(resources);
  judge9();

  console.log('[2/5] installing the tarball into a clean prefix…');
  const cli = installCli(work);
  const cliEntry = join(work, 'npm-prefix/lib/node_modules/@orpheus-aviary/lark-cli/index.js');

  console.log('[3/5] copying the nest…');
  const { backupNest } = await import('../packages/core/dist/index.js');
  const copy = await backupNest({ target: join(work, 'nest-copy') });
  nest = copy.nestDir;

  await judge6(cli, cliEntry, app, nest);
  judge7(app, cliEntry, nest);

  console.log('[4/5] cold start out of the mounted app…');
  await judge4(cli, app, nest);
  await judge4Missing(cli, app, nest);

  console.log('[5/5] the media criteria, and the packaged locators…');
  await judge5(cli, app, nest);
  await judge10(cli, app, nest);

  const shaAfter = sha256(DMG);
  check(
    '§1 · the dmg is byte-identical before and after this run',
    shaBefore === shaAfter,
    shaBefore.slice(0, 16),
  );
  console.log(`\ndmg sha256: ${shaAfter}`);
  console.log(`tgz sha256: ${sha256(TGZ)}`);
} finally {
  if (mountPoint) unmountDmg(mountPoint);
  if (keep) console.log(`\nwork kept at ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
console.log(
  'manual: GUI cold start makes sound · Finder drag-install + right-click open · skill usability',
);
process.exit(passed === results.length ? 0 : 1);
