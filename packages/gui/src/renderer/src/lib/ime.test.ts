import { describe, expect, it } from 'vitest';
import { type ComposingKeyEvent, isComposingKey } from './ime.js';

function event(overrides: Partial<ComposingKeyEvent> = {}): ComposingKeyEvent {
  return { nativeEvent: { isComposing: false }, keyCode: 13, ...overrides };
}

describe('isComposingKey', () => {
  it('reads the standard signal', () => {
    expect(isComposingKey(event({ nativeEvent: { isComposing: true } }))).toBe(true);
  });

  // Some input methods report the composition only here.
  it('reads keyCode 229, which is all an older IME sends', () => {
    expect(isComposingKey(event({ keyCode: 229 }))).toBe(true);
  });

  it('lets a real Enter through', () => {
    expect(isComposingKey(event())).toBe(false);
  });

  // A native event that predates `isComposing` reports neither.
  it('treats a missing signal as not composing', () => {
    expect(isComposingKey(event({ nativeEvent: {} }))).toBe(false);
  });
});
