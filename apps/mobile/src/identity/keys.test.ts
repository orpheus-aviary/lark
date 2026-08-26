// Criterion 113 (N7d), at the level where it is decidable: two workspaces
// never name the same SecureStore key, and `local` never stops naming the keys
// an existing install already has.
//
// The stores themselves reach SecureStore and cannot be loaded under Node.
// What can be — and what the failure actually is — is arithmetic on strings:
// a collision here means converging one library logs the other out, or worse,
// reads a committed id that belongs to somebody else and wipes.

import { WORKSPACE_LOCAL, computeWorkspaceId } from '@lark/core/portable';
import { describe, expect, it } from 'vitest';
import {
  COMMITTED_KEY,
  CREDENTIALS_KEY,
  DEVICE_SCOPED_KEYS,
  WORKSPACE_SCOPED_KEYS,
  workspaceKey,
  workspaceKeys,
} from './keys';

const A = computeWorkspaceId('srv', 'usr-a');
const B = computeWorkspaceId('srv', 'usr-b');

describe('the local workspace', () => {
  it('keeps the keys an existing install already has', () => {
    // 🔴 §2.4. If these moved, an upgraded phone would find no committed
    // identity, see a library claiming one, and converge — throwing away the
    // outbox of a library nobody touched.
    for (const base of WORKSPACE_SCOPED_KEYS) {
      expect(workspaceKey(base, WORKSPACE_LOCAL)).toBe(base);
    }
  });

  it('names the four keys the phone has always used', () => {
    expect([...WORKSPACE_SCOPED_KEYS]).toEqual([
      'lark.install_id',
      'lark.install_intent',
      'lark.skybridge',
      'lark.skybridge.stash',
    ]);
  });
});

describe('an account workspace', () => {
  it('gets its own key for everything it owns', () => {
    for (const base of WORKSPACE_SCOPED_KEYS) {
      expect(workspaceKey(base, A)).toBe(`${base}.${A}`);
    }
  });

  it('never collides with another workspace', () => {
    const a = new Set(workspaceKeys(A));
    const b = workspaceKeys(B);
    expect(b.some((key) => a.has(key))).toBe(false);
    expect(workspaceKeys(WORKSPACE_LOCAL).some((key) => a.has(key))).toBe(false);
  });

  it('never collides with an unscoped key, whatever bases arrive later', () => {
    // A 32-hex suffix cannot be produced by adding a base name, so a future
    // `lark.something` can never spell an existing scoped key.
    for (const key of workspaceKeys(A)) {
      expect(WORKSPACE_SCOPED_KEYS.some((base) => base === key)).toBe(false);
      expect(key.endsWith(`.${A}`)).toBe(true);
    }
  });

  it('refuses an id that is not one, before it becomes a key', () => {
    for (const bad of ['', 'Local', '../elsewhere', `${A}x`]) {
      expect(() => workspaceKey(COMMITTED_KEY, bad)).toThrow();
    }
  });
});

describe('what stays on the device', () => {
  it('leaves the model key alone — every workspace talks to the same one', () => {
    // §4 puts the model on the device; the key cannot join `device.json`
    // because a secret does not belong in a plain file.
    expect([...DEVICE_SCOPED_KEYS]).toEqual(['lark.llm.api_key']);
    // `tsc` already refuses to compare the two literal unions, which is the
    // stronger version of this claim; the widened compare is what a future
    // base name added to either list would still have to pass.
    const scopedBases: readonly string[] = WORKSPACE_SCOPED_KEYS;
    for (const key of DEVICE_SCOPED_KEYS) expect(scopedBases.includes(key)).toBe(false);
  });

  it('does not scope it even by accident', () => {
    const scoped = new Set([...workspaceKeys(A), ...workspaceKeys(B)]);
    for (const key of DEVICE_SCOPED_KEYS) expect(scoped.has(key)).toBe(false);
  });

  it('names the same key `settings/llm.ts` uses', () => {
    // Spelled out because the two files cannot import each other — that one
    // reaches SecureStore. A mismatch would be a key nobody reads.
    expect(DEVICE_SCOPED_KEYS[0]).toBe('lark.llm.api_key');
  });
});

describe('the credentials key in particular', () => {
  it('is what converge deletes, so it must be per library', () => {
    // `convergeLibrary` calls `credentials.delete()` on the workspace it is
    // claiming. Sharing this key would log the other workspace out.
    expect(workspaceKey(CREDENTIALS_KEY, A)).not.toBe(workspaceKey(CREDENTIALS_KEY, B));
  });
});
