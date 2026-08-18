// Registry conformance (M6-6).
//
// The two shared registries are hand-kept, so something has to notice when a
// new error class ships without an entry. That is what this file is: it
// REFLECTS over the exported error classes instead of restating a list, so a
// class added tomorrow is checked tomorrow — a hand-written list here would
// have exactly the blind spot the registry is supposed to remove.

import {
  DAEMON_ENVELOPE_ERROR_CODES,
  type DaemonEnvelopeErrorCode,
  TASK_ERROR_CODES,
  type TaskErrorCode,
} from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { describeTaskError } from './download/task-data.js';
import * as errors from './errors.js';
import { CodedError, InvalidSourceError, NotFoundError, SourceKeyConflictError } from './errors.js';
import * as portableErrors from './portable/errors.js';

/** Every exported class extending CodedError, with a throwaway instance. */
function codedErrorInstances(): { name: string; instance: CodedError }[] {
  const out: { name: string; instance: CodedError }[] = [];
  for (const [name, value] of Object.entries(errors)) {
    if (typeof value !== 'function' || value === CodedError) continue;
    if (!(value.prototype instanceof CodedError)) continue;
    // Constructor shapes differ (message / id / id+stage / capacity), but
    // every one of them tolerates two spare strings, and only `code` matters.
    const Ctor = value as unknown as new (...args: unknown[]) => CodedError;
    out.push({ name, instance: new Ctor('probe', 'probe') });
  }
  return out;
}

// The whole vocabulary lives in `portable/errors.ts` since N1a and is
// re-exported from here. That only holds together because a re-export is not a
// redefinition: a second class object with the same name would pass every
// `err.name` check in the CLI and fail every `instanceof` in the daemon, which
// is the worst possible failure mode — it looks fine until a route has to
// decide a status code.
describe('the portable re-export', () => {
  it('hands back the SAME class objects, one for one', () => {
    const names = Object.keys(portableErrors);
    expect(names.length).toBeGreaterThanOrEqual(45);
    for (const name of names) {
      expect(errors[name as keyof typeof errors]).toBe(
        portableErrors[name as keyof typeof portableErrors],
      );
    }
  });

  it('is identical across all three kinds of error', () => {
    // One thrown by portable code since N0a, one desktop-only, one coded.
    expect(errors.SchemaMismatchError).toBe(portableErrors.SchemaMismatchError);
    expect(errors.WriterLockBusyError).toBe(portableErrors.WriterLockBusyError);
    expect(errors.SyncUnavailableError).toBe(portableErrors.SyncUnavailableError);
    // …and an instance built through one path answers `instanceof` on the other.
    expect(new portableErrors.NotFoundError('song', 'x')).toBeInstanceOf(errors.NotFoundError);
  });
});

describe('coded error registries', () => {
  it('finds the coded error classes at all', () => {
    // Guards the reflection itself: a refactor that stops exporting the
    // classes would otherwise turn every assertion below into a no-op.
    expect(codedErrorInstances().length).toBeGreaterThanOrEqual(16);
  });

  it.each(codedErrorInstances().map(({ name, instance }) => [name, instance.code]))(
    '%s (%s) is a registered envelope code',
    (_name, code) => {
      // Every CodedError can reach a client through `mapCoreError`: a queued
      // task is not the only way to hit ffprobe or the LLM — `POST
      // /songs/import` and `PUT /songs/:id` do it inside the request.
      expect(DAEMON_ENVELOPE_ERROR_CODES as readonly string[]).toContain(code);
    },
  );

  it.each(codedErrorInstances().map(({ name, instance }) => [name, instance.code]))(
    '%s (%s) is a registered task code',
    (_name, code) => {
      // `describeTaskError` passes any CodedError through verbatim, so the
      // task registry has to cover them too.
      expect(TASK_ERROR_CODES as readonly string[]).toContain(code);
    },
  );

  it('registers every code describeTaskError can produce for a non-coded error', () => {
    const produced = [
      describeTaskError(new InvalidSourceError('bad source')).code,
      describeTaskError(new SourceKeyConflictError('song-id', 'bilibili', 'BV1:2')).code,
      describeTaskError(new NotFoundError('song', 'song-id')).code,
      describeTaskError(new Error('something nobody classified')).code,
    ];
    expect(produced).toEqual([
      'INVALID_SOURCE',
      'SOURCE_KEY_CONFLICT',
      'NOT_FOUND',
      'INTERNAL_ERROR',
    ]);
    for (const code of produced) {
      expect(TASK_ERROR_CODES as readonly string[]).toContain(code);
    }
  });

  it('keeps both registries duplicate-free', () => {
    const unique = (codes: readonly string[]) => new Set(codes).size === codes.length;
    expect(unique(DAEMON_ENVELOPE_ERROR_CODES)).toBe(true);
    expect(unique(TASK_ERROR_CODES)).toBe(true);
  });

  it('models the intersection rather than pretending the sets are disjoint', () => {
    // FFMPEG_FAILED is the canonical double-domain code: a transcode dying
    // inside a queued task, and `POST /songs/import` rejecting a file, are the
    // same condition on two channels (M6-6).
    const envelope: readonly DaemonEnvelopeErrorCode[] = DAEMON_ENVELOPE_ERROR_CODES;
    const task: readonly TaskErrorCode[] = TASK_ERROR_CODES;
    expect(envelope).toContain('FFMPEG_FAILED');
    expect(task).toContain('FFMPEG_FAILED');
    // …and codes that exist on only one side stay on one side.
    expect(envelope).toContain('UNAUTHORIZED');
    expect(task as readonly string[]).not.toContain('UNAUTHORIZED');
  });
});
