// v0.1 LWW stamping (M1-4): row-local monotonic local timestamps. R32 parks
// server-normalized HLC as a v0.2 topic — swapping the algorithm later means
// changing THIS ONE function, nothing else.

export interface LwwStamp {
  updated_at: number;
  lww_counter: number;
}

/**
 * Next (updated_at, lww_counter) for a business write to a row currently
 * stamped `prev`. Wall clock moved forward → fresh (now, 0); same-ms writes
 * (or a clock that jumped backwards) keep the timestamp and bump the counter,
 * so consecutive writes to one row always stay totally ordered.
 */
export function nextLwwStamp(prev: LwwStamp, now = Date.now()): LwwStamp {
  if (now > prev.updated_at) {
    return { updated_at: now, lww_counter: 0 };
  }
  return { updated_at: prev.updated_at, lww_counter: prev.lww_counter + 1 };
}
