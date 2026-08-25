// One import file, and the one digest three implementations have to agree on
// (N6a, criterion 87).
//
// PROVENANCE. The JSON is `buildExport`'s shape, serialised the way both
// desktop writers serialise it — `JSON.stringify(data, null, 2)`, no trailing
// newline (`TopBar.tsx`, `services/playlist-export.ts`). The digest was taken
// with `shasum -a 256`, which is neither of the implementations under test: a
// constant produced by one of them would be that one marking its own homework.
//
// SHARED with `library/import.test.ts` on purpose, and that sharing IS the
// criterion. The claim is "`expo-crypto` on the phone and `node:crypto` on the
// desktop return the same hex for the same bytes"; two constants living in two
// files could drift apart and both stay green.
//
// The Chinese names are load bearing. They make the file multi-byte, so a
// `TextEncoder` that got UTF-8 wrong changes the digest rather than passing —
// and `TextEncoder` is the one piece of this path that is native on the
// desktop and a Hermes built-in on the phone (N0b §9).
//
// EDITING THIS STRING CHANGES THE DIGEST. That is not a fragility to work
// around; it is the only reason the constant below means anything.

/** A two-song export. 604 bytes as UTF-8. */
export const IMPORT_FIXTURE_JSON = `{
  "format": "lark-playlist",
  "version": 1,
  "exported_at": 1755000000000,
  "playlist": {
    "name": "晚风"
  },
  "songs": [
    {
      "name": "半岛铁盒",
      "artist": "周杰伦",
      "source_url": "https://www.bilibili.com/video/BV1xx411c7mD",
      "source_provider": "bilibili",
      "source_key": "BV1xx411c7mD:12345",
      "lyrics_offset": 0,
      "duration": 372
    },
    {
      "name": "安静",
      "artist": "周杰伦",
      "source_url": null,
      "source_provider": null,
      "source_key": null,
      "lyrics_offset": -250,
      "duration": 335
    }
  ]
}`;

/** `shasum -a 256` over those bytes. */
export const IMPORT_FIXTURE_DIGEST =
  '488d8fc764f41e8ff14955af78984d1645ce744b847d10c8fee18ea2ddad669d';

/** What the fixture parses to, for the assertions that are about parsing. */
export const IMPORT_FIXTURE_PLAYLIST_NAME = '晚风';
export const IMPORT_FIXTURE_SONG_COUNT = 2;
