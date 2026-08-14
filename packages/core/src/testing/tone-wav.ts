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

/**
 * 16-bit mono PCM WAV of a 440Hz tone.
 *
 * A tone rather than silence: silence encodes almost instantly, and the
 * cancellation tests need the child to still be running when the abort lands.
 */
export function toneWav(seconds: number, sampleRate = 22_050): Buffer {
  const samples = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12_000), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
