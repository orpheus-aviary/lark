// What `POST /songs/import` accepts (0.3.0 T4).
//
// The library holds ONE format from 0.3.0 — AAC in an MP4 — so importing is a
// conversion, and what can be imported is exactly what the shipped ffmpeg can
// read. Both lists below are derived from the vendored profile's configure
// line (`vendor/ffmpeg.lock.json`), not from what ffmpeg can do in general:
// a Homebrew build decodes WMA, and accepting it on the machines that happen
// to have one would make "can lark import this?" a question about the user's
// $PATH.
//
// They live in @lark/shared because three places have to agree: core's import
// gate, the GUI's native file dialog (main process), and the capabilities
// endpoint that tells any other client what to offer.
//
// The extensions are a CHEAP FILTER, never the decision. A `.mp3` holding an
// AAC-in-MP4 imports fine — the probe is what classifies a file, and it is the
// only thing that can (M3-11, fifth review ⑨).

/**
 * Extensions the import picker offers, without the dot (Electron's filter
 * shape). Every one maps to a demuxer the profile enables:
 *
 *   m4a mp4 → mov · aac → aac · mp3 → mp3 · flac → flac · wav → wav
 *   ogg oga opus → ogg
 *
 * `.mp4` is here because audio-only MP4 exists and is common (it is what a
 * DASH stream saves as). A real video answers `IMPORT_HAS_VIDEO`, which is a
 * better thing to tell someone than greying out the file they picked.
 */
export const IMPORT_AUDIO_EXTENSIONS = [
  'm4a',
  'mp4',
  'aac',
  'mp3',
  'flac',
  'wav',
  'ogg',
  'oga',
  'opus',
] as const;

export type ImportAudioExtension = (typeof IMPORT_AUDIO_EXTENSIONS)[number];

/**
 * Audio codecs the import gate accepts, spelled as ffprobe's `codec_name`.
 *
 * Only codecs that can actually ARRIVE. The profile's decoder list is longer:
 * `aac_fixed` and `mp3float` are alternative decoders for codecs already named
 * here and are never a stream's `codec_name`, and `aac_latm` needs a demuxer
 * (LOAS/MPEG-TS) the profile does not build.
 *
 * The PCM subset is deliberate (§4-a): the profile decodes six of the twenty
 * or so PCM flavours, so `pcm_f64le` is rejected HERE, with a sentence about
 * the format, rather than by ffmpeg two steps later with "no decoder found".
 *
 * An upper bound, not a promise: in `system` mode lark runs whatever ffmpeg
 * the machine has, and one built without a FLAC decoder fails the conversion
 * instead — as `FFMPEG_FAILED`, which is what happened. These codecs are NOT
 * in `REQUIRED_CAPABILITIES` for the same reason in reverse: an ffmpeg that
 * cannot import a FLAC can still download, convert and play everything lark
 * makes, and calling it unusable would be a lie about what lark needs.
 */
export const IMPORT_AUDIO_CODECS = [
  'aac',
  'alac',
  'mp3',
  'flac',
  'vorbis',
  'opus',
  'pcm_u8',
  'pcm_s16le',
  'pcm_s16be',
  'pcm_s24le',
  'pcm_s32le',
  'pcm_f32le',
] as const;

export type ImportAudioCodec = (typeof IMPORT_AUDIO_CODECS)[number];

/**
 * Codecs that carry every bit of the original, so re-encoding them to AAC is
 * a one-way loss worth saying out loud. The rest are already lossy — the
 * warning there is about a SECOND generation, which is a different sentence.
 */
const LOSSLESS: ReadonlySet<string> = new Set([
  'alac',
  'flac',
  'pcm_u8',
  'pcm_s16le',
  'pcm_s16be',
  'pcm_s24le',
  'pcm_s32le',
  'pcm_f32le',
]);

const EXTENSIONS: ReadonlySet<string> = new Set(IMPORT_AUDIO_EXTENSIONS);
const CODECS: ReadonlySet<string> = new Set(IMPORT_AUDIO_CODECS);

/** `ext` with or without its leading dot, case-insensitive. */
export function isImportAudioExtension(ext: string): boolean {
  const bare = ext.startsWith('.') ? ext.slice(1) : ext;
  return EXTENSIONS.has(bare.toLowerCase());
}

/** ffprobe's `codec_name` for the selected stream. */
export function isImportAudioCodec(codec: string): boolean {
  return CODECS.has(codec);
}

/** Does this codec lose nothing, so that converting it to AAC loses the rest? */
export function isLosslessAudioCodec(codec: string): boolean {
  return LOSSLESS.has(codec);
}
