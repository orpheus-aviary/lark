// Request guardrails for the download surface (M3-11), shared so the CLI can
// pre-check a paste locally against the exact numbers the daemon enforces
// (M6-11).
//
// These are bounds on the work ONE request may cause, not product limits: a
// CLI that chunks a 900-line file has to split on the same boundaries the
// daemon would reject on, and a second copy of the numbers would drift into
// "the CLI says 200 lines, the daemon says 150" the first time either moves.
//
// v0.2 adds two more groups below: the entity string bounds (they now have a
// second enforcer — the sync payload validator has to reject a remote change
// the local API would have refused, or a peer could write a 4KB artist into
// this library through the back door) and the sync protocol numbers.

/** Longest single `input` string a parse / download request may carry. */
export const DOWNLOAD_INPUT_MAX = 8 * 1024;

/** Lines per `POST /download/parse` call — the CLI chunks a file to fit. */
export const DOWNLOAD_PARSE_LINES_MAX = 200;

/** Target groups per `POST /download/batch` call. */
export const DOWNLOAD_BATCH_GROUPS_MAX = 20;

/** Items across all groups of one batch request. */
export const DOWNLOAD_BATCH_ITEMS_MAX = 1000;

/** Longest keyword query a batch item may carry. */
export const DOWNLOAD_BATCH_KEYWORD_MAX = 500;

/** Longest playlist name a batch target may carry. */
export const DOWNLOAD_PLAYLIST_NAME_MAX = 200;

/**
 * The list a batch group came from (0.5.0 ④). Bounded like everything else on
 * the wire, and for one extra reason: it is copied onto every task of the
 * group and repeated in a download record for as long as that record is kept.
 */
export const DOWNLOAD_SOURCE_TITLE_MAX = 500;
export const DOWNLOAD_SOURCE_URL_MAX = 2048;

/**
 * Pages walked while expanding a favourites folder / collection. A 953-item
 * folder needs 48 pages, so the original 50 sat right on top of a real
 * library; 200 pages is ~12s of sequential requests (M3 acceptance).
 */
export const FETCH_LIST_PAGES_MAX = 200;

/** Videos returned by one `POST /download/fetch-list` call. */
export const FETCH_LIST_ITEMS_MAX = 5000;

// ─── Entity string bounds (sunk here in v0.2 T0) ───────
//
// Two enforcers now share them: the daemon's request validators (`POST /songs`,
// `PUT /songs/:id`, the playlist routes) and the sync payload validator that
// screens every inbound change. Same numbers or a peer running an older build
// could land a value this machine's own API would have rejected.

export const SONG_NAME_MAX = 500;
export const SONG_ARTIST_MAX = 500;
export const SONG_SOURCE_URL_MAX = 2048;
export const SONG_SOURCE_PROVIDER_MAX = 64;
export const SONG_SOURCE_KEY_MAX = 256;
export const PLAYLIST_NAME_MAX = 500;

// ─── sync v1 protocol bounds (v0.2) ────────────────────

/**
 * Serialized UTF-8 bytes one emitted change may occupy (§3.9). Sits under
 * skybridge's 256KB payload cap with room for the envelope, and is checked at
 * EMIT time rather than at push time: a change that cannot be pushed must
 * never enter the outbox, or the queue head blocks forever.
 */
export const SYNC_CHANGE_BYTES_MAX = 240 * 1024;

/**
 * Lyrics inlined into a `sync_file_ops.arg` (§3.6). Larger bodies go to a
 * staging file plus sha256 — the journal is a control record, not a blob
 * store, and a 1MB LRC would be rewritten on every attempt.
 */
export const SYNC_FILE_OP_INLINE_MAX = 256 * 1024;

/** Changes per push request — skybridge's own per-batch limit. */
export const SYNC_PUSH_BATCH_MAX = 1000;

/**
 * Bytes per push request. The server refuses bodies over 4MB, so the boxing
 * loop closes a batch at 3.5MB and keeps the rest for the next one — count and
 * bytes are independent limits and either one can be the binding constraint.
 */
export const SYNC_PUSH_BYTES_MAX = 3.5 * 1024 * 1024;

/** Changes requested per pull (server default 500, hard cap 1000). */
export const SYNC_PULL_LIMIT = 500;

/**
 * The same, for a phone (N0b-3, frozen by R5).
 *
 * Not a guess and not a safety margin: 500 changes per apply measured a p50 of
 * 164ms on the frozen device — past the frame budget, and visible as a stall
 * while a round runs. 200 measured 72.98ms. The desktop keeps 500 because
 * nothing there was ever close to dropping a frame.
 *
 * A pull page size is a LATENCY decision rather than a protocol one, which is
 * why the two hosts may differ at all: the server caps it at 1000 and does not
 * care which side of that a client picks.
 */
export const SYNC_PULL_LIMIT_MOBILE = 200;

/**
 * Memberships a playlist may hold and still express a normalization as one
 * `reorder` (§3.5). Past it the emit degrades to per-row `set_rank` — the
 * reorder payload is a full id list, and 4000 uuids is already ~150KB.
 */
export const REORDER_SYNC_MAX = 4000;

/**
 * Attempts a file op gets before it stops retrying itself and waits for the
 * user (`POST /sync/file-ops/retry` or `/discard`, §3.6). Also the gate on
 * discard: only a permanently failed row may be abandoned.
 */
export const SYNC_FILE_OP_MAX_ATTEMPTS = 5;
