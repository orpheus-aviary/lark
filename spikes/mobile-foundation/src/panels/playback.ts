// Criterion 19 — can Android play bilibili's raw fMP4 as it arrives (D17).
//
// The files under test were downloaded by `make-network-fixtures.mjs --audio`
// with NO remux: exactly the bytes `openAudio()` returns. If they play, D17's
// "store the stream directly" holds and N4 never needs a remux step; if they do
// not, the plan's fallbacks (JS remux → native remux → NO-GO) start.
//
// The truth every number is compared against is the DESKTOP's ffprobe reading
// of the same file, carried in the fixture — the device is not allowed to be
// its own reference.
//
// Two things this panel is careful about:
//
//   1. **pause before release.** expo-audio 57.0.3 does NOT contain the fix for
//      #47569 (release-and-keep-playing) — that was checked in N0b-1 against the
//      CHANGELOG, and there is no 57.0.4+. So `release()` is only ever called
//      after `pause()`, and there is a separate, explicitly labelled probe that
//      does it the wrong way round to find out whether this version really
//      leaks sound. Whether it does is N3's problem to design around; pretending
//      not to know is worse.
//   2. **Android needs the lock screen session for long background playback.**
//      expo-audio's own docs: `shouldPlayInBackground` alone stops after about
//      three minutes, and `setActiveForLockScreen` is what keeps the foreground
//      service alive. Criterion 19 asks for ≥5 minutes, which is on the far side
//      of that cliff — a soak that skipped it would fail for a reason that has
//      nothing to do with the platform's ability.

import {
  type AudioPlayer,
  type AudioPlaylist,
  createAudioPlayer,
  createAudioPlaylist,
  requestNotificationPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { type TrackFixture, loadFixtures } from '../fixtures';
import { reportToHost } from '../report';

export interface PlaybackRow {
  group: string;
  name: string;
  ok: boolean | null;
  detail: string;
}

/** Seek and duration both get the plan's ±1s. */
const TOLERANCE_SEC = 1;
/** A paused player that moved more than this is not paused. */
const DRIFT_TOLERANCE_SEC = 0.25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<{ ok: boolean; waitedMs: number }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return { ok: true, waitedMs: Date.now() - started };
    await sleep(100);
  }
  return { ok: false, waitedMs: Date.now() - started };
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * The audio session lark would use: exclusive focus (which is also what the
 * lock screen controls require) and allowed to keep going in the background.
 */
async function configureSession(): Promise<void> {
  await setAudioModeAsync({
    playsInSilentMode: true,
    // `doNotMix` is a requirement, not a preference: expo-audio's own note says
    // the lock screen controls need it.
    interruptionMode: 'doNotMix',
    shouldPlayInBackground: true,
  });
}

function fileUri(track: TrackFixture): string | null {
  return track.file === null ? null : `file://${track.file.devicePath}`;
}

async function tracksOrRows(): Promise<
  { tracks: Record<'short' | 'long', TrackFixture> } | { rows: PlaybackRow[] }
> {
  const { network, error } = await loadFixtures();
  if (network === null) {
    return {
      rows: [
        {
          group: 'fixtures',
          name: 'audio fixtures',
          ok: null,
          detail: error ?? 'no fixtures — run `just spike-mobile-fixtures-network --audio`',
        },
      ],
    };
  }
  const short = network.tracks.find((t) => t.key === 'short');
  const long = network.tracks.find((t) => t.key === 'long');
  if (short?.file == null || long?.file == null) {
    return {
      rows: [
        {
          group: 'fixtures',
          name: 'audio fixtures',
          ok: null,
          detail:
            'the fixture has no downloaded files — run `just spike-mobile-fixtures-network --audio`',
        },
      ],
    };
  }
  return { tracks: { short, long } };
}

/** Load a player and report what the platform made of the file. */
async function loadRows(
  player: AudioPlayer,
  track: TrackFixture,
  group: string,
): Promise<PlaybackRow[]> {
  const loaded = await waitFor(() => player.isLoaded, 20_000);
  const expected = track.file?.probe.durationSec ?? 0;
  const rows: PlaybackRow[] = [
    {
      group,
      name: 'the raw fMP4 loads at all',
      ok: loaded.ok,
      detail: loaded.ok
        ? `isLoaded after ${loaded.waitedMs}ms · ${track.file?.name} (${track.file?.bytes}B, no remux)`
        : `never loaded in 20s (${track.file?.name})`,
    },
  ];
  if (!loaded.ok) return rows;

  const reported = player.duration;
  rows.push({
    group,
    name: `duration within ${TOLERANCE_SEC}s of ffprobe`,
    ok: Math.abs(reported - expected) <= TOLERANCE_SEC,
    detail: `player says ${round(reported)}s, desktop ffprobe says ${round(expected)}s → off by ${round(Math.abs(reported - expected))}s`,
  });
  return rows;
}

async function seekRows(
  player: AudioPlayer,
  duration: number,
  group: string,
): Promise<PlaybackRow[]> {
  const rows: PlaybackRow[] = [];
  // Paused for the matrix: a seek measured while the clock is running reports
  // the seek plus however long the assertion took to read it.
  player.pause();
  await sleep(300);

  for (const fraction of [0, 0.25, 0.5, 0.95]) {
    const target = duration * fraction;
    await player.seekTo(target);
    await sleep(400);
    const actual = player.currentTime;
    rows.push({
      group,
      name: `seek to ${Math.round(fraction * 100)}% (${round(target)}s)`,
      ok: Math.abs(actual - target) <= TOLERANCE_SEC,
      detail: `landed at ${round(actual)}s → off by ${round(Math.abs(actual - target))}s`,
    });
  }

  // …and once while playing, because that is what a user does.
  player.play();
  await sleep(500);
  const target = duration * 0.5;
  const before = Date.now();
  await player.seekTo(target);
  await sleep(400);
  const elapsed = (Date.now() - before) / 1000;
  const actual = player.currentTime;
  rows.push({
    group,
    name: 'seek to 50% while playing',
    ok: Math.abs(actual - target) <= TOLERANCE_SEC + elapsed,
    detail: `landed at ${round(actual)}s, ${round(elapsed)}s of playback later → off by ${round(Math.abs(actual - target))}s`,
  });
  return rows;
}

async function pauseResumeRows(player: AudioPlayer, group: string): Promise<PlaybackRow[]> {
  player.pause();
  await sleep(300);
  const paused = player.currentTime;
  await sleep(2_000);
  const stillPaused = player.currentTime;

  const rows: PlaybackRow[] = [
    {
      group,
      name: 'paused for 2s without drifting',
      ok: Math.abs(stillPaused - paused) <= DRIFT_TOLERANCE_SEC,
      detail: `${round(paused)}s → ${round(stillPaused)}s (moved ${round(Math.abs(stillPaused - paused))}s)`,
    },
  ];

  player.play();
  await sleep(1_500);
  const resumed = player.currentTime;
  rows.push({
    group,
    name: 'resumes from where it paused',
    ok: resumed > stillPaused && resumed - stillPaused < 3,
    detail: `${round(stillPaused)}s → ${round(resumed)}s after 1.5s of play`,
  });
  return rows;
}

export async function runPlayerPanel(): Promise<PlaybackRow[]> {
  const found = await tracksOrRows();
  if ('rows' in found) return found.rows;
  const track = found.tracks.short;
  const uri = fileUri(track);
  if (uri === null) return [];

  await configureSession();
  const group = 'single player';
  const player = createAudioPlayer({ uri, name: track.title }, { updateInterval: 200 });
  try {
    const rows = await loadRows(player, track, group);
    if (rows.some((r) => r.ok === false)) return rows;

    player.play();
    const started = await waitFor(() => player.currentTime > 0.5, 10_000);
    rows.push({
      group,
      name: 'actually plays (the clock moves)',
      ok: started.ok,
      detail: started.ok
        ? `past 0.5s after ${started.waitedMs}ms · playing=${player.playing}`
        : `currentTime stuck at ${round(player.currentTime)}s`,
    });

    rows.push(...(await seekRows(player, player.duration, group)));
    rows.push(...(await pauseResumeRows(player, group)));

    // The supported order: pause, then release.
    player.pause();
    await sleep(300);
    player.remove();
    rows.push({
      group,
      name: 'pause → release (the supported order)',
      ok: true,
      detail:
        'released after pausing; whether any sound survives is checked from the host ' +
        '(`drive.mjs audio`), because JS cannot hear the speaker',
    });
    return rows;
  } catch (err) {
    player.pause();
    player.remove();
    throw err;
  }
}

export async function runPlaylistPanel(): Promise<PlaybackRow[]> {
  const found = await tracksOrRows();
  if ('rows' in found) return found.rows;
  const { short, long } = found.tracks;
  const shortUri = fileUri(short);
  const longUri = fileUri(long);
  if (shortUri === null || longUri === null) return [];

  await configureSession();
  const group = 'playlist';
  const playlist: AudioPlaylist = createAudioPlaylist({
    sources: [
      { uri: shortUri, name: short.title },
      { uri: longUri, name: long.title },
    ],
    updateInterval: 200,
  });

  try {
    const loaded = await waitFor(() => playlist.isLoaded, 20_000);
    const rows: PlaybackRow[] = [
      {
        group,
        name: 'two raw fMP4 tracks load as a playlist',
        ok: loaded.ok && playlist.trackCount === 2,
        detail: `isLoaded=${playlist.isLoaded} after ${loaded.waitedMs}ms · trackCount ${playlist.trackCount} · currentIndex ${playlist.currentIndex}`,
      },
    ];
    if (!loaded.ok) return rows;

    playlist.play();
    const started = await waitFor(() => playlist.currentTime > 0.5, 10_000);
    rows.push({
      group,
      name: 'plays track 0',
      ok: started.ok,
      detail: started.ok
        ? `past 0.5s after ${started.waitedMs}ms · duration ${round(playlist.duration)}s vs ffprobe ${round(short.file?.probe.durationSec ?? 0)}s`
        : `currentTime stuck at ${round(playlist.currentTime)}s`,
    });
    rows.push({
      group,
      name: `track 0 duration within ${TOLERANCE_SEC}s of ffprobe`,
      ok: Math.abs(playlist.duration - (short.file?.probe.durationSec ?? 0)) <= TOLERANCE_SEC,
      detail: `playlist says ${round(playlist.duration)}s`,
    });

    const target = playlist.duration * 0.25;
    await playlist.seekTo(target);
    await sleep(500);
    rows.push({
      group,
      name: 'seek inside track 0',
      ok: Math.abs(playlist.currentTime - target) <= TOLERANCE_SEC + 0.5,
      detail: `asked ${round(target)}s, landed ${round(playlist.currentTime)}s`,
    });

    playlist.next();
    const advanced = await waitFor(() => playlist.currentIndex === 1 && playlist.isLoaded, 15_000);
    await sleep(500);
    rows.push({
      group,
      name: 'next() moves to the 37-minute track',
      ok:
        advanced.ok &&
        Math.abs(playlist.duration - (long.file?.probe.durationSec ?? 0)) <= TOLERANCE_SEC,
      detail: `currentIndex ${playlist.currentIndex} after ${advanced.waitedMs}ms · duration ${round(playlist.duration)}s vs ffprobe ${round(long.file?.probe.durationSec ?? 0)}s`,
    });

    const deep = playlist.duration * 0.95;
    await playlist.seekTo(deep);
    await sleep(700);
    rows.push({
      group,
      name: 'seek to 95% of the long track',
      ok: Math.abs(playlist.currentTime - deep) <= TOLERANCE_SEC + 0.5,
      detail: `asked ${round(deep)}s, landed ${round(playlist.currentTime)}s`,
    });

    playlist.skipTo(0);
    const backAtZero = await waitFor(() => playlist.currentIndex === 0, 15_000);
    rows.push({
      group,
      name: 'skipTo(0) comes back',
      ok: backAtZero.ok,
      detail: `currentIndex ${playlist.currentIndex} after ${backAtZero.waitedMs}ms`,
    });

    playlist.pause();
    await sleep(300);
    playlist.destroy();
    rows.push({
      group,
      name: 'pause → destroy',
      ok: true,
      detail: 'destroyed after pausing; silence is verified from the host',
    });
    return rows;
  } catch (err) {
    playlist.pause();
    playlist.destroy();
    throw err;
  }
}

/**
 * The wrong order, on purpose: release WITHOUT pausing.
 *
 * expo/expo#47569 is "the native player keeps playing after release", and its
 * fix (#47828) is in no released SDK 57 version (N0b-1's check). This measures
 * whether 57.0.3 actually leaks the sound, because "we always pause first" is a
 * rule N3 has to know the cost of breaking. Recovery if it does leak: the
 * button is a one-shot and `adb shell am force-stop` ends it.
 */
export async function probeReleaseWithoutPause(): Promise<PlaybackRow[]> {
  const found = await tracksOrRows();
  if ('rows' in found) return found.rows;
  const uri = fileUri(found.tracks.long);
  if (uri === null) return [];

  await configureSession();
  const player = createAudioPlayer({ uri }, { updateInterval: 200 });
  await waitFor(() => player.isLoaded, 20_000);
  player.play();
  const started = await waitFor(() => player.currentTime > 1, 10_000);
  player.remove();
  await sleep(1_500);
  return [
    {
      group: 'release hazard (#47569)',
      name: 'release() while playing — did the sound stop?',
      ok: null,
      detail: started.ok
        ? 'released mid-playback without pausing. Ask the host: `drive.mjs audio` — an ' +
          'active player here means 57.0.3 still leaks and pause-before-release is mandatory.'
        : 'never got playing, so this probe proved nothing',
    },
  ];
}

export interface SoakSample {
  atMs: number;
  currentTime: number;
  playing: boolean;
}

/**
 * The ≥5 minute background/lock-screen run (criterion 19, behaviour — one pass).
 *
 * Samples its own clock every 5s and POSTs a snapshot every 30s, so a run that
 * ends with the process being killed still says WHEN it was killed. The verdict
 * is "did playback advance by about as much as the wall clock" — a foreground
 * service that got frozen shows up as a currentTime that stopped moving while
 * time kept going.
 */
export async function runBackgroundSoak(
  minutes: number,
  onProgress: (rows: PlaybackRow[]) => void,
): Promise<PlaybackRow[]> {
  const found = await tracksOrRows();
  if ('rows' in found) return found.rows;
  const track = found.tracks.long;
  const uri = fileUri(track);
  if (uri === null) return [];

  await configureSession();

  // MEASURED (N0b-4b): declaring POST_NOTIFICATIONS in the manifest is not the
  // same as having it. The first soak ran with `granted=false` — playback was
  // fine, but the lock screen showed nothing, because on Android 13+ the media
  // notification IS the lock screen controls and a denied permission keeps it
  // out of the drawer. The ask has to happen at run time, from JS.
  const permission = await requestNotificationPermissionsAsync();

  const player = createAudioPlayer({ uri, name: track.title }, { updateInterval: 500 });
  const loaded = await waitFor(() => player.isLoaded, 20_000);
  if (!loaded.ok) {
    player.remove();
    return [{ group: 'background soak', name: 'load', ok: false, detail: 'never loaded' }];
  }

  // Without this Android stops background playback after ~3 minutes (expo-audio
  // docs) — the criterion asks for five, so the session IS part of the setup.
  player.setActiveForLockScreen(true, {
    title: track.partTitle || track.title,
    artist: 'lark spike · N0b-4b',
    albumTitle: `${track.bvid} · raw fMP4, no remux`,
  });
  player.play();

  const startedAt = Date.now();
  const startedTime = player.currentTime;
  const samples: SoakSample[] = [];
  const durationMs = minutes * 60_000;

  const summarize = (final: boolean): PlaybackRow[] => {
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const playedSec = player.currentTime - startedTime;
    // Sampling stops when the JS thread is frozen; the gap is the evidence.
    let biggestGap = 0;
    for (let i = 1; i < samples.length; i += 1) {
      biggestGap = Math.max(biggestGap, samples[i].atMs - samples[i - 1].atMs);
    }
    return [
      {
        group: 'background soak',
        name: `${final ? 'finished' : 'in progress'}: playback kept up with the clock`,
        ok: final ? Math.abs(playedSec - elapsedSec) <= 5 && player.playing : null,
        detail: `${round(elapsedSec)}s elapsed · ${round(playedSec)}s played · playing=${player.playing} · ${samples.length} samples · biggest sampling gap ${round(biggestGap / 1000)}s`,
      },
      {
        group: 'background soak',
        name: 'notification permission (= the lock screen controls)',
        ok: permission.granted,
        detail: `status ${permission.status}${permission.granted ? '' : ' — the media notification stays out of the drawer, so the lock screen shows nothing'}`,
      },
    ];
  };

  let nextReport = 30_000;
  while (Date.now() - startedAt < durationMs) {
    await sleep(5_000);
    samples.push({
      atMs: Date.now() - startedAt,
      currentTime: player.currentTime,
      playing: player.playing,
    });
    if (Date.now() - startedAt >= nextReport) {
      nextReport += 30_000;
      const rows = summarize(false);
      onProgress(rows);
      reportToHost('playback-soak-progress', { rows, samples });
    }
  }

  const rows = summarize(true);
  // A distinct name from the panel wrapper's own POST (which carries the rows
  // and the runtime label but no samples): two files under one name is how an
  // analysis ends up reading the wrong one.
  reportToHost('playback-soak-samples', { rows, samples, minutes });
  player.pause();
  await sleep(200);
  player.clearLockScreenControls();
  player.remove();
  return rows;
}
