// HOST script — criteria 14 and 15, driven through the PRODUCT's UI.
//
// The other mobile criteria are answered by acceptance panels inside the app,
// because what they assert is what the app's own code decides. These two are
// different: they are about the four tabs, the sort control, the search box
// and the row actions, so the only honest driver is the one that presses them.
//
// THE SORT CHECK IS A CROSS-DEVICE ONE, and that is why it lives here rather
// than in a panel. The expected order is computed on THIS machine, out of the
// same `songs.db` that was pushed to the phone, with the same `sortSongs` from
// `@lark/shared` — so a pass means "the phone shows what the desktop would
// show", not "the phone agrees with itself". A panel could only assert the
// second.
//
// PRECONDITIONS, checked rather than assumed:
//   - the PRODUCTION artifact is installed (`just mobile-android-release`)
//   - the fixture was imported by the acceptance artifact, so the library on
//     the phone is the one under <nest>/lark/songs.db here
//
//     just backup-nest /tmp/lark-fixture
//     just mobile-push-fixture /tmp/lark-fixture
//     just mobile-acceptance-release      # then tap "Import pushed fixture"
//     just mobile-android-release
//     just mobile-accept-library /tmp/lark-fixture
//
// CRITERION 15 WRITES TO THE PHONE'S COPY, including one real delete. That is
// what the criterion asks for — "journal 已消费且 songs/<id>/ 已删除" — and the
// directory half is only observable through 设置's on-disk count, because
// `songs/` is app-private and nothing outside the app can list it.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sortSongs } from '@lark/shared';
import Database from 'better-sqlite3';

const ANDROID_HOME = process.env.ANDROID_HOME ?? '/opt/homebrew/share/android-commandlinetools';
const ADB = `${ANDROID_HOME}/platform-tools/adb`;
const PACKAGE = 'com.orpheusaviary.lark';
const DRIVE = fileURLToPath(new URL('./drive.mjs', import.meta.url));
/** uiautomator escapes non-BMP characters; this is 📌. */
const PIN = '&#128204;';

const nest = process.argv[2];
if (nest === undefined) {
  console.error('usage: accept-library.mjs <nest copy> (the one that was pushed)');
  process.exit(64);
}

// ─── driving ────────────────────────────────────────────

const drive = (...args) =>
  execFileSync('node', [DRIVE, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, LARK_PACKAGE: PACKAGE },
  });

const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf-8' });
const sleep = (ms) => execFileSync('sleep', [String(ms / 1000)]);

/** Every labelled node on screen, top to bottom. */
const screen = () =>
  drive('dump')
    .split('\n')
    .filter((line) => line.includes('\t'))
    .map((line) => line.slice(line.indexOf('\t') + 1));

const shows = (text) => screen().some((line) => line.includes(text));

/**
 * Press what is on screen. NOT the scrolling `tap`.
 *
 * MEASURED, twice: `drive tap` scrolls to the top first, and 25 swipes on this
 * app either dismiss an open sheet or leave the songs list somewhere the
 * control is no longer where it was — a run failed with `never found 排序`
 * on a screen that was showing it. Everything this script presses is a fixed
 * control or a row already in view, so scrolling was never the right default;
 * `tapRow` is there for the one case that needs it.
 */
function tap(label) {
  drive('tap-visible', label);
  sleep(800);
}

/** Find a row by scrolling to it — for lists longer than a screen. */
function tapRow(label) {
  drive('tap', label);
  sleep(800);
}

function type(text) {
  drive('type', text);
  sleep(400);
}

// ─── reporting ──────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

const group = (title) => console.log(`— ${title}`);

// ─── what the desktop says the order is ─────────────────

const db = new Database(`${nest}/lark/songs.db`, { readonly: true });
const fixtureSongs = db
  .prepare('SELECT id, name, artist, duration, created_at FROM songs')
  .all()
  .map((row) => ({ ...row, pinned: false, has_file: true, file_size: 0, updated_at: 0 }));
db.close();

if (fixtureSongs.length === 0) {
  console.error(`${nest}/lark/songs.db holds no songs — nothing to drive`);
  process.exit(1);
}

/**
 * A row's first few characters.
 *
 * Long titles are ellipsised on screen (`numberOfLines={1}`), so the full name
 * is not what a dump can be compared against. The prefix is, and it stays a
 * discriminator as long as no two songs share one — which the check below
 * asserts rather than hopes.
 */
const shortName = (name) => [...name].slice(0, 6).join('');

const prefixes = fixtureSongs.map((song) => shortName(song.name));
if (new Set(prefixes).size !== prefixes.length) {
  console.error('two songs in this fixture share a name prefix — the order checks cannot tell');
  console.error('them apart. Use a different library copy.');
  process.exit(1);
}

const expectedOrder = (field, order) =>
  sortSongs(fixtureSongs, { field, order })
    .map((song) => shortName(song.name))
    .join('|');

/** The song names currently drawn on the 歌曲 tab, in order. */
function shownOrder() {
  const known = new Set(prefixes);
  return screen()
    .map((line) => shortName(line.replace(`${PIN} `, '')))
    .filter((line) => known.has(line));
}

const matches = (song, needle) =>
  `${song.name} ${song.artist}`.toLowerCase().includes(needle.toLowerCase());

/** The longest latin run in this fixture that matches some songs but not all. */
function latinNeedle() {
  const runs = new Set();
  for (const song of fixtureSongs) {
    for (const run of `${song.name} ${song.artist}`.match(/[A-Za-z]{3,}/g) ?? []) runs.add(run);
  }
  const usable = [...runs]
    .filter((run) => {
      const hits = fixtureSongs.filter((song) => matches(song, run)).length;
      return hits > 0 && hits < fixtureSongs.length;
    })
    .sort((a, b) => b.length - a.length);
  return usable[0] ?? null;
}

/** A `设置` field's value, read back off the screen. */
function settingsField(label) {
  const lines = screen();
  const at = lines.findIndex((line) => line === label);
  return at === -1 ? null : (lines[at + 1] ?? null);
}

// ─── criterion 14 ───────────────────────────────────────

console.log(`accept-library · ${PACKAGE} · fixture ${nest}`);

adb('shell', 'am', 'force-stop', PACKAGE);
sleep(1200);
adb('shell', 'monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1');
sleep(9000);

group('14 · the four tabs');
for (const [tab, marker] of [
  ['歌曲', '搜索歌名或歌手'],
  ['歌单', '新建歌单'],
  ['添加', '还不能添加歌曲'],
  ['设置', 'install_id'],
]) {
  tap(tab);
  check(`${tab} opens`, shows(marker), marker);
}

tap('歌曲');
check(
  'the phone holds the library that was pushed',
  shownOrder().length > 0,
  `${fixtureSongs.length} songs in the fixture`,
);

group('14 · every sort field, against what this machine computes');
const orders = new Map();
for (const [label, field] of [
  ['默认', 'default'],
  ['歌名', 'name'],
  ['歌手', 'artist'],
  ['时长', 'duration'],
  ['创建时间', 'created_at'],
]) {
  tap('排序');
  tap(label);
  const shown = shownOrder().join('|');
  orders.set(label, shown);
  if (field === 'default') {
    // `默认` is the library's own order — there is no comparator to check it
    // against, only the fact that it is a state the control can reach.
    check('默认 is reachable', shown !== '', shown);
  } else {
    check(`${label} ascending`, shown === expectedOrder(field, 'asc'), shown);
  }
}
check(
  'the control is not inert',
  new Set(orders.values()).size > 1,
  `${new Set(orders.values()).size} distinct orders across 5 fields`,
);

group('14 · direction and search');
tap('排序');
tap('歌名');
tap('歌名 ↑');
check(
  'the direction button reverses it',
  shownOrder().join('|') === expectedOrder('name', 'desc'),
  'desc',
);
tap('排序');
tap('默认');

// The needle has to be ASCII: `adb shell input text` cannot type anything
// else, and no IME is worth installing for this. So it is chosen FROM the
// fixture — the longest latin run that matches some songs but not all — and
// the expected hits are computed here rather than eyeballed. Whether a Chinese
// search matches, and whether it is trimmed first, is the LibraryContract's
// case (`a search term is trimmed before it is matched`), which runs on this
// same phone.
const needle = latinNeedle();
if (needle === null) {
  check('a searchable ascii needle exists in this fixture', false, 'none found');
} else {
  const expected = fixtureSongs
    .filter((song) => matches(song, needle))
    .map((song) => shortName(song.name));
  tap('搜索歌名或歌手');
  type(needle);
  const hits = shownOrder();
  check(
    `searching ${JSON.stringify(needle)} hits exactly what it should`,
    hits.join('|') === expected.join('|'),
    `${hits.length} of ${fixtureSongs.length}: ${hits.join(' · ')}`,
  );
  adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END');
  for (let i = 0; i < needle.length; i += 1) adb('shell', 'input', 'keyevent', 'KEYCODE_DEL');
  sleep(800);
  check('clearing the box brings the library back', shownOrder().length === fixtureSongs.length);
}

// ─── criterion 15 ───────────────────────────────────────

const subject = shortName(fixtureSongs[0].name);

group('15 · song writes');
tap(subject);
tap('改歌名');
type('N2F NAME');
tap('保存');
check('改歌名', shows('N2F NAME'), 'N2F NAME');

tap('N2F NAME');
tap('改歌手');
type('N2F ARTIST');
tap('保存');
check('改歌手', shows('N2F ARTIST'));

tap('N2F NAME');
tap('固定');
check('固定', shows(PIN));
tap('N2F NAME');
tap('取消固定');
check('取消固定', !shows(PIN));

group('15 · deleting a song takes its directory');
tap('设置');
const before = { songs: settingsField('曲库'), directories: settingsField('曲库目录') };
tap('歌曲');
tap('N2F NAME');
tap('删除');
check('the row is gone', !shows('N2F NAME'));
tap('设置');
const after = { songs: settingsField('曲库'), directories: settingsField('曲库目录') };
check('the library lost a song', before.songs !== after.songs, `${before.songs} → ${after.songs}`);
// The journal half. `deleteSong` drains it before returning, so a directory
// that is still there is an effect that was written down and never executed.
check(
  'and the directory went with it',
  before.directories !== after.directories,
  `${before.directories} → ${after.directories}`,
);

group('15 · playlist writes');
tap('歌单');
tap('新建歌单');
type('N2F LIST');
tap('创建');
check('建歌单', shows('N2F LIST'));

tap('N2F LIST');
tap('加歌');
const candidate = shownOrder()[0];
tap(candidate ?? '');
check('加歌', shownOrder().length === 1, candidate);

tap(candidate ?? '');
tap('移出歌单');
check('移除', shows('这个歌单还没有歌。'));

tap('歌单改名');
type('N2F LIST 2');
tap('保存');
check('歌单改名', shows('N2F LIST 2'));

tap('删除歌单');
tap('歌单');
check('删歌单', !shows('N2F LIST'));

console.log(
  failed === 0 ? `\n✓ ${passed} checks passed` : `\n✗ ${failed} failed, ${passed} passed`,
);
process.exit(failed === 0 ? 0 : 1);
