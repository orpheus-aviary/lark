// The sync bounds are only meaningful against skybridge's own limits, and
// those live in another repo — so they are restated here as constants and the
// relations are asserted. Raising one of ours past the server's would
// otherwise fail at runtime, on a push, against a real server, as a 413.

import { describe, expect, it } from 'vitest';
import {
  SYNC_CHANGE_BYTES_MAX,
  SYNC_FILE_OP_INLINE_MAX,
  SYNC_PULL_LIMIT,
  SYNC_PUSH_BATCH_MAX,
  SYNC_PUSH_BYTES_MAX,
} from './limits.js';

// skybridge 0.1.4, `packages/proto/openapi.yaml`.
const SERVER_PAYLOAD_MAX = 256 * 1024;
const SERVER_BODY_MAX = 4 * 1024 * 1024;
const SERVER_BATCH_MAX = 1000;
const SERVER_PULL_LIMIT_MAX = 1000;

describe('sync limits vs the skybridge server', () => {
  it('leaves room for the envelope inside the per-payload cap', () => {
    expect(SYNC_CHANGE_BYTES_MAX).toBeLessThan(SERVER_PAYLOAD_MAX);
  });

  it('closes a push batch below the body cap', () => {
    expect(SYNC_PUSH_BYTES_MAX).toBeLessThan(SERVER_BODY_MAX);
  });

  it('never asks the server for more than it allows', () => {
    expect(SYNC_PUSH_BATCH_MAX).toBeLessThanOrEqual(SERVER_BATCH_MAX);
    expect(SYNC_PULL_LIMIT).toBeLessThanOrEqual(SERVER_PULL_LIMIT_MAX);
  });

  it('needs both the count and the byte bound (neither implies the other)', () => {
    // A full batch of large changes blows the body cap long before the count
    // cap — which is exactly why the boxing loop checks both.
    expect(SYNC_PUSH_BATCH_MAX * SYNC_CHANGE_BYTES_MAX).toBeGreaterThan(SYNC_PUSH_BYTES_MAX);
  });

  it('can always inline lyrics that arrived inside a legal change', () => {
    // Staging + sha256 exists for locally produced oversize bodies. Anything
    // that got through the emit guard must fit in the journal row, or an
    // applied change would have nowhere to record its file effect.
    expect(SYNC_FILE_OP_INLINE_MAX).toBeGreaterThanOrEqual(SYNC_CHANGE_BYTES_MAX);
  });
});
