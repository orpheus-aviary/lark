import { describe, expect, it } from 'vitest';
import { isUuidV4 } from './uuid.js';

describe('isUuidV4 (R10)', () => {
  it('accepts a lowercase hyphenated v4', () => {
    expect(isUuidV4('9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001')).toBe(true);
  });

  it('rejects uppercase', () => {
    expect(isUuidV4('9B2ABF8A-6B31-40D4-A2F1-8E5C3D21A001')).toBe(false);
  });

  it('rejects other UUID versions (version nibble)', () => {
    expect(isUuidV4('9b2abf8a-6b31-10d4-a2f1-8e5c3d21a001')).toBe(false); // v1
    expect(isUuidV4('9b2abf8a-6b31-70d4-a2f1-8e5c3d21a001')).toBe(false); // v7
  });

  it('rejects a wrong variant nibble', () => {
    expect(isUuidV4('9b2abf8a-6b31-40d4-c2f1-8e5c3d21a001')).toBe(false);
  });

  it('rejects path-traversal and junk shapes', () => {
    expect(isUuidV4('../etc/passwd')).toBe(false);
    expect(isUuidV4('')).toBe(false);
    expect(isUuidV4('9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001/..')).toBe(false);
    expect(isUuidV4('9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001\n')).toBe(false);
  });
});
