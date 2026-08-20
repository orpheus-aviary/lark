// HOST script — criterion 17's expected number (N3d, §2.5).
//
// The phone reports how many times it handed the system a new Now Playing
// title for one song (设置 → 蓝牙歌词发送). This works out what that number
// should be, on THIS machine, from the same `songs.db` and the same
// `lyrics.lrc` that were pushed to it, with the same `nowPlayingTitle` the app
// calls. A pass therefore means "the phone published what the desktop's own
// rules say it should", not "the phone agrees with itself" — the N2f
// cross-device shape.
//
// WHAT THE NUMBER IS, AND WHAT IT IS NOT. It is not the number of lyric lines
// and it is not the number of status ticks. Adjacent ticks that produce the
// same string are de-duplicated, and an interlude — a timed blank — produces
// the song name, so a song whose lyrics stop for eight seconds publishes the
// song name once in the middle. What is left is the number of TRANSITIONS in
// the sampled sequence, and the first segment is not one of them: the source
// already shows the song name by the time it starts playing.
//
// THE THROTTLE IS NOT SIMULATED, ON PURPOSE. Status arrives every 500ms and
// the minimum interval is 500ms, so on an even grid a publish is never
// refused; the throttle only bites when the tick jitters, and then only for a
// segment shorter than one tick. That is exactly what the PHASE SWEEP below
// looks for: the same count under five different tick phases means no segment
// is short enough for a tick to step over, and the number is therefore a fair
// thing to demand of the device. If the phases disagree, this says so and
// names the short segments rather than printing an average.
//
// THE THIRD ARGUMENT IS WHERE THE PHONE STOPPED. 设置's counter reports the
// playhead beside the count, in the same frame, so the honest comparison is
// over the same interval rather than over the whole song — and pausing is
// needed anyway, because `uiautomator dump` cannot read a screen whose clock
// is running (N3c). Leave it out to get the whole song.
//
//     just backup-nest /tmp/lark-fixture
//     just mobile-push-fixture /tmp/lark-fixture        (see that recipe)
//     just mobile-now-playing-expect /tmp/lark-fixture <歌名的一部分> [停在第几秒]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowPlayingTitle, parseLrc } from '@lark/shared';
import Database from 'better-sqlite3';

/** `driver.ts`'s `STATUS_INTERVAL_MS`. */
const TICK_MS = 500;
/** The phases a real tick stream can land on, relative to the song start. */
const PHASES_MS = [0, 100, 200, 300, 400];

const [nest, needle, untilArg] = process.argv.slice(2);
if (nest === undefined || needle === undefined) {
  console.error('usage: now-playing-expect.mjs <nest copy> <song name fragment> [stopped at]');
  process.exit(64);
}
const until = untilArg === undefined ? null : Number(untilArg);
if (until !== null && !Number.isFinite(until)) {
  console.error(`${untilArg} is not a number of seconds`);
  process.exit(64);
}

const lark = join(nest, 'lark');
const db = new Database(join(lark, 'songs.db'), { readonly: true });
const matches = db
  .prepare('SELECT id, name, artist, lyrics_offset, duration FROM songs WHERE name LIKE ?')
  .all(`%${needle}%`);

if (matches.length === 0) {
  console.error(`no song in ${lark} whose name contains ${needle}`);
  process.exit(1);
}
if (matches.length > 1) {
  console.error(`${matches.length} songs match ${needle}:`);
  for (const row of matches) console.error(`  ${row.name}`);
  process.exit(1);
}

const song = matches[0];
let lyrics = [];
try {
  lyrics = parseLrc(readFileSync(join(lark, 'songs', song.id, 'lyrics.lrc'), 'utf-8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const titleAt = (seconds) =>
  nowPlayingTitle({
    songName: song.name,
    lyrics,
    timeSeconds: seconds,
    offsetSeconds: song.lyrics_offset,
    mode: 'lyrics',
  });

/**
 * The publishes one tick phase would produce.
 *
 * The first tick lands one interval after the song starts, and what the source
 * is already showing at that point is the song name (`driver.load` publishes
 * it with `setActiveForLockScreen`).
 */
const end = Math.min(until ?? song.duration, song.duration);

function walk(phaseMs) {
  const segments = [];
  let showing = song.name;
  for (let ms = TICK_MS + phaseMs; ms <= end * 1000; ms += TICK_MS) {
    const title = titleAt(ms / 1000);
    if (title === showing) continue;
    segments.push({ at: ms / 1000, title });
    showing = title;
  }
  return segments;
}

const runs = PHASES_MS.map(walk);
const counts = runs.map((segments) => segments.length);
const agree = counts.every((count) => count === counts[0]);
const timeline = runs[0];

console.log(`歌曲    ${song.name}${song.artist === '' ? '' : ` · ${song.artist}`}`);
console.log(`id      ${song.id}`);
console.log(`时长    ${song.duration.toFixed(1)}s · offset ${song.lyrics_offset}s`);
console.log(`歌词    ${lyrics.length} 行（含间奏空行）`);
console.log(`算到    ${end.toFixed(1)}s${until === null ? '（整首）' : ''}`);
console.log('');

const spans = timeline.map(({ at, title }, index) => ({
  at,
  title,
  span: (timeline[index + 1]?.at ?? end) - at,
}));

for (const { at, span, title } of spans) {
  console.log(`  ${at.toFixed(1).padStart(7)}s → ${span.toFixed(1).padStart(5)}s  ${title}`);
}
console.log('');

if (agree) {
  const last = spans.at(-1);
  if (last !== undefined && last.span <= TICK_MS / 1000) {
    console.log(`⚠️  最后一段只有 ${last.span.toFixed(1)}s——停得离一次切换太近，换个位置暂停`);
    process.exitCode = 1;
  }
  console.log(`期望 updateLockScreenMetadata 调用 ${counts[0]} 次（五个 tick 相位一致）`);
  console.log('设备上：设置 → 蓝牙歌词发送（本首），并且最短间隔必须 ≥500ms');
} else {
  console.log(`⚠️  五个 tick 相位算出 ${counts.join(' / ')} 次——这首歌不能用来判判据 17`);
  console.log('   有段落短于一个 tick（500ms），设备漏掉哪一个取决于它的 tick 落在哪里。');
  // A segment exactly one tick long counts as short: whether a tick lands
  // inside it or exactly on its end is a coin toss on the phase.
  for (const segment of spans.filter((one) => one.span <= TICK_MS / 1000)) {
    console.log(
      `   ${segment.at.toFixed(1)}s 起只有 ${segment.span.toFixed(1)}s：${segment.title}`,
    );
  }
  console.log('   换一首歌词行间隔更宽的。');
  process.exitCode = 1;
}
