// source_* invariant enforcement (T4, aligned with master plan §3.1 — the
// first-draft "all three together" rule was wrong and would reject hand-typed
// non-bilibili links):
//
//   - source_provider and source_key are set TOGETHER or not at all (the
//     CHECK enforces it too; core rejects first with a typed error);
//   - source_url is independent: url-only rows (copy/open, can't drive a
//     download, R8) and key-without-url rows are both legal;
//   - missing is stored as NULL. '' for url normalizes to NULL; '' (or
//     whitespace) for provider/key is REJECTED — ('','') would pass the
//     same-null CHECK while squatting on a unique key;
//   - v0.1 provider whitelist: 'bilibili' only;
//   - bilibili keys must LOOK like an identity — `BV…:<cid>` (R30). Whether
//     the cid really belongs to that bvid is M3's online normalization; core
//     only holds the syntax line.

import { InvalidSourceError } from '../errors.js';

export interface SourceFields {
  source_url: string | null;
  source_provider: string | null;
  source_key: string | null;
}

export interface SourceInput {
  source_url?: string | null;
  source_provider?: string | null;
  source_key?: string | null;
}

const PROVIDERS: ReadonlySet<string> = new Set(['bilibili']);
const BILIBILI_KEY_RE = /^BV[0-9A-Za-z]+:\d+$/;

function normUrl(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function normIdentityField(v: string | null | undefined, field: string): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  if (t === '') {
    throw new InvalidSourceError(`${field} must be NULL when absent, not an empty string`);
  }
  return t;
}

/** Validate + normalize the source triple; throws InvalidSourceError. */
export function normalizeSource(input: SourceInput): SourceFields {
  const source_url = normUrl(input.source_url);
  const source_provider = normIdentityField(input.source_provider, 'source_provider');
  const source_key = normIdentityField(input.source_key, 'source_key');

  if ((source_provider === null) !== (source_key === null)) {
    throw new InvalidSourceError('source_provider and source_key must be set together');
  }
  if (source_provider !== null && source_key !== null) {
    if (!PROVIDERS.has(source_provider)) {
      throw new InvalidSourceError(`unknown source_provider: ${source_provider}`);
    }
    if (!BILIBILI_KEY_RE.test(source_key)) {
      throw new InvalidSourceError(
        `source_key for bilibili must look like 'BV…:<cid>', got: ${source_key}`,
      );
    }
  }
  return { source_url, source_provider, source_key };
}
