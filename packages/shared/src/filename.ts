// Turning a name into a filename (M5-12).
//
// Lives in the wire package because BOTH front-ends need the same answer: the
// GUI suggests a filename in a save dialog, and `lark playlist export -o <dir>`
// derives one from the playlist name. Two copies would drift, and the drift
// would be invisible until two exports of the same playlist landed side by side
// under different names.

/** Characters a filename cannot carry, plus the C0 range and DEL. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what has to go
const UNSAFE_FILENAME_CHARS = /[\/\\:*?"<>|\u0000-\u001f\u007f]/g;

/**
 * Strip what a filename cannot carry.
 *
 * The input is free text — a playlist name — so a `/` in it would silently
 * redirect the write and a leading `.` would hide the file. Playlist names are
 * capped at 500 characters, filenames at ~255 BYTES, hence the 80-char slice.
 *
 * Spaces survive: they are legal in a filename, and a playlist called
 * "Late Night" should not export as "LateNight".
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(UNSAFE_FILENAME_CHARS, '').replace(/^\.+/, '').trim().slice(0, 80);
  return cleaned === '' ? 'playlist' : cleaned;
}
