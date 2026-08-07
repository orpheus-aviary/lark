// Request guardrails for the download surface (M3-11), shared so the CLI can
// pre-check a paste locally against the exact numbers the daemon enforces
// (M6-11).
//
// These are bounds on the work ONE request may cause, not product limits: a
// CLI that chunks a 900-line file has to split on the same boundaries the
// daemon would reject on, and a second copy of the numbers would drift into
// "the CLI says 200 lines, the daemon says 150" the first time either moves.

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
 * Pages walked while expanding a favourites folder / collection. A 953-item
 * folder needs 48 pages, so the original 50 sat right on top of a real
 * library; 200 pages is ~12s of sequential requests (M3 acceptance).
 */
export const FETCH_LIST_PAGES_MAX = 200;

/** Videos returned by one `POST /download/fetch-list` call. */
export const FETCH_LIST_ITEMS_MAX = 5000;
