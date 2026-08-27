import { describe, expect, it } from 'vitest';
import { remoteTriggerOf } from './remote';

describe('remoteTriggerOf', () => {
  it('speaks the queue vocabulary, not the session one', () => {
    // 🔴 `previous` and `prev` are two different words for one thing, and this
    // is the only place they meet. Done at the call site instead, the mistake
    // would be a car stereo whose 上一首 does nothing.
    expect(remoteTriggerOf({ command: 'next' })).toBe('next');
    expect(remoteTriggerOf({ command: 'previous' })).toBe('prev');
  });

  it('ignores a command this build does not know', () => {
    // New JavaScript against the native code already installed is the shape an
    // OTA update lands in. Guessing here is how 上一首 skips forward.
    expect(remoteTriggerOf({ command: 'stop' })).toBeNull();
    expect(remoteTriggerOf({ command: 'prev' })).toBeNull();
    expect(remoteTriggerOf({ command: 'ended' })).toBeNull();
  });

  it('ignores a payload that is not one', () => {
    expect(remoteTriggerOf(undefined)).toBeNull();
    expect(remoteTriggerOf(null)).toBeNull();
    expect(remoteTriggerOf('next')).toBeNull();
    expect(remoteTriggerOf({})).toBeNull();
  });
});
