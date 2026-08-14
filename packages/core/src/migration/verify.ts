// "验证 m4a" — what the migration's reconciliation table means by a valid
// conversion result (0.3.0 T2, master plan §3.2-9).
//
// This exists because of a measured surprise: ffmpeg's exit code does not tell
// you whether the conversion kept the song. Fed an mp3 truncated to half its
// bytes, the vendored build prints one decoder complaint, EXITS 0, and writes
// a perfectly valid m4a holding 0.47 of the original 1.0 seconds. Same for an
// mp3 with a corrupted middle: exit 0, 0.29 seconds, valid container. A
// migration that trusted the exit code would unlink the mp3 and keep a third
// of the song.
//
// So the check is on the OUTPUT, and length is part of it. Growth is expected
// — an AAC encoder adds priming samples — but loss is the failure this is here
// to catch, so only loss is refused, and only past a tolerance that no honest
// re-encode reaches.

import { type AudioProbe, isMp4Container } from '../download/ffmpeg.js';

/** Floor, for clips too short for the ratio to mean anything. */
const DURATION_LOSS_FLOOR_SECONDS = 0.25;
/** And a proportional allowance for everything else. */
const DURATION_LOSS_RATIO = 0.01;

export interface AudioAssessment {
  ok: boolean;
  /** Empty when ok; a user-facing sentence otherwise (it reaches the report). */
  reason: string;
}

/**
 * Is this probe a canonical `song.m4a` that still holds the whole song?
 *
 * `expected` is the duration the source declared, when it is known — the mp3's
 * own probe during a conversion, or the library row's duration when a restart
 * finds an m4a and no mp3 (协调表 "mp3 无、m4a 在"). Pass null when there is
 * nothing to compare against; the format checks still apply.
 */
export function assessCanonicalAudio(probe: AudioProbe, expected: number | null): AudioAssessment {
  if (probe.selected_stream_global_index < 0) {
    return fail('转换结果里没有音频流');
  }
  if (probe.codec !== 'aac') {
    return fail(`转换结果的编码是 ${probe.codec || '未知'}，不是 aac`);
  }
  if (!isMp4Container(probe.container)) {
    return fail(`转换结果的容器是 ${probe.container || '未知'}，不是 mp4`);
  }
  // A valid MP4 always declares one. Zero here means the moov never got
  // written — the file is the wreckage of an interrupted run.
  if (probe.duration <= 0) {
    return fail('转换结果没有时长（文件不完整）');
  }
  if (expected !== null && expected > 0) {
    const allowed = Math.max(DURATION_LOSS_FLOOR_SECONDS, expected * DURATION_LOSS_RATIO);
    if (probe.duration + allowed < expected) {
      return fail(
        `转换结果只有 ${probe.duration.toFixed(1)} 秒，源文件是 ${expected.toFixed(1)} 秒（源文件已损坏）`,
      );
    }
  }
  return { ok: true, reason: '' };
}

function fail(reason: string): AudioAssessment {
  return { ok: false, reason };
}
