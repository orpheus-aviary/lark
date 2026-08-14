// Does the build we ship contain what lark says it accepts? (0.3.0 T4)
//
// Two lists make promises about one binary: `REQUIRED_CAPABILITIES` (what
// readiness means) and `IMPORT_AUDIO_*` (what the import picker offers). The
// binary is described by `vendor/ffmpeg.lock.json`, whose configure line
// accept-pack compares byte for byte against the shipped ffmpeg — so the lock
// is a trustworthy stand-in for the build, and this can run without one.
//
// It exists because the profile HAS been trimmed before: T1b removed LAME once
// nothing wrote mp3 any more. The next trim must not be able to take a decoder
// the import dialog is still offering to open — that failure would surface as
// one user's FLAC not importing, long after the commit that caused it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IMPORT_AUDIO_CODECS,
  IMPORT_AUDIO_EXTENSIONS,
  type ImportAudioExtension,
} from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../testing/audio-fixtures.js';
import { REQUIRED_CAPABILITIES } from './capabilities.js';

/** `--enable-decoder='aac,mp3'` and `--enable-encoder=aac` both parse here. */
function enabled(kind: string): ReadonlySet<string> {
  const lock = JSON.parse(readFileSync(join(repoRoot(), 'vendor', 'ffmpeg.lock.json'), 'utf8')) as {
    configure: string;
  };
  const match = lock.configure.match(new RegExp(`--enable-${kind}=(?:'([^']*)'|(\\S+))`));
  return new Set((match?.[1] ?? match?.[2] ?? '').split(',').filter((name) => name !== ''));
}

/** Which demuxer each offered extension needs. The claim, written down. */
const EXTENSION_DEMUXER: Record<ImportAudioExtension, string> = {
  m4a: 'mov',
  mp4: 'mov',
  aac: 'aac',
  mp3: 'mp3',
  flac: 'flac',
  wav: 'wav',
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'ogg',
};

describe('the vendored ffmpeg profile', () => {
  it('decodes every codec import offers to take', () => {
    const decoders = enabled('decoder');
    const missing = IMPORT_AUDIO_CODECS.filter((codec) => !decoders.has(codec));
    expect(missing).toEqual([]);
  });

  it('demuxes every extension the picker offers', () => {
    const demuxers = enabled('demuxer');
    const missing = IMPORT_AUDIO_EXTENSIONS.filter((ext) => !demuxers.has(EXTENSION_DEMUXER[ext]));
    expect(missing).toEqual([]);
  });

  it('carries everything readiness requires', () => {
    // `probeCapabilities` asks the binary the same question; this asks the
    // lock, so a profile trimmed in the lock fails here rather than at the
    // next `just fetch-ffmpeg` — which may be months away.
    for (const [kind, names] of Object.entries(REQUIRED_CAPABILITIES)) {
      const present = enabled(kind.slice(0, -1));
      expect({ kind, missing: names.filter((name) => !present.has(name)) }).toEqual({
        kind,
        missing: [],
      });
    }
  });

  it('has no mp3 encoder, and needs none', () => {
    // The other direction of the same guard: nothing has written an mp3 since
    // 0.3.0, and re-adding LAME would be a licence question, not a feature.
    const encoders = enabled('encoder');
    expect([...encoders]).toEqual(['aac']);
  });
});
