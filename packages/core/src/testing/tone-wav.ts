// Audio fixtures without an encoder (M7 T0).
//
// The suites that run a real ffmpeg used to synthesise their input with
// `-f lavfi ... -c:a aac`. The minimal LGPL profile carries no lavfi demuxer,
// on purpose. (0.3.0 T0a did add the AAC encoder — canonical audio is m4a now
// — but making the build under test produce its own input is the wrong shape
// of test either way: the fixture would fail exactly when the encoder does.)
//
// A PCM WAV needs nothing but a 44-byte header, so the fixture is written here
// and the build under test only has to do the thing it ships to do. Real
// containers are covered where they can be covered honestly: `just
// fetch-ffmpeg` and accept-pack run their closed loops against the checked-in
// fixtures in `scripts/fixtures/`.
//
// 0.3.0 T4 gave it the sample formats too. The import matrix supports a SUBSET
// of PCM (§4-a), so the tests need both a file the profile can decode and one
// it cannot — and the difference between them is a header field and a writer,
// not a container nobody here can produce.

/**
 * The PCM flavours a WAV header can declare, named as ffprobe reports them.
 *
 * `pcm_f64le` is the odd one out and the reason this is a union rather than a
 * bit depth: nothing in the vendored profile decodes it, so it is what an
 * unsupported-but-plausible file looks like.
 */
export type WavSampleFormat =
  | 'pcm_u8'
  | 'pcm_s16le'
  | 'pcm_s24le'
  | 'pcm_s32le'
  | 'pcm_f32le'
  | 'pcm_f64le';

/** WAVE_FORMAT_PCM / WAVE_FORMAT_IEEE_FLOAT, and how wide one sample is. */
const LAYOUT: Record<WavSampleFormat, { tag: 1 | 3; bytes: number }> = {
  pcm_u8: { tag: 1, bytes: 1 },
  pcm_s16le: { tag: 1, bytes: 2 },
  pcm_s24le: { tag: 1, bytes: 3 },
  pcm_s32le: { tag: 1, bytes: 4 },
  pcm_f32le: { tag: 3, bytes: 4 },
  pcm_f64le: { tag: 3, bytes: 8 },
};

/** Well under full scale, so no format's rounding can clip. */
const AMPLITUDE = 12_000 / 32_768;

/**
 * Mono PCM WAV of a 440Hz tone.
 *
 * A tone rather than silence: silence encodes almost instantly, and the
 * cancellation tests need the child to still be running when the abort lands.
 */
export function toneWav(
  seconds: number,
  sampleRate = 22_050,
  format: WavSampleFormat = 'pcm_s16le',
): Buffer {
  const { tag, bytes } = LAYOUT[format];
  const samples = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(samples * bytes);
  for (let i = 0; i < samples; i++) {
    writeSample(
      data,
      i * bytes,
      Math.sin((2 * Math.PI * 440 * i) / sampleRate) * AMPLITUDE,
      format,
    );
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(tag, 20);
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * bytes, 28); // byte rate
  header.writeUInt16LE(bytes, 32); // block align
  header.writeUInt16LE(bytes * 8, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** `value` is -1…1; integer formats scale it, and 8-bit PCM is UNSIGNED. */
function writeSample(out: Buffer, offset: number, value: number, format: WavSampleFormat): void {
  switch (format) {
    case 'pcm_u8':
      out.writeUInt8(Math.round(value * 127) + 128, offset);
      return;
    case 'pcm_s16le':
      out.writeInt16LE(Math.round(value * 32_767), offset);
      return;
    case 'pcm_s24le':
      out.writeIntLE(Math.round(value * 8_388_607), offset, 3);
      return;
    case 'pcm_s32le':
      out.writeInt32LE(Math.round(value * 2_147_483_647), offset);
      return;
    case 'pcm_f32le':
      out.writeFloatLE(value, offset);
      return;
    case 'pcm_f64le':
      out.writeDoubleLE(value, offset);
      return;
  }
}
