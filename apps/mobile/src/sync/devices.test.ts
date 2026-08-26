// Criterion 93's logic half (N6c).
//
// A device shows one confirmation — the one for the row that was tapped — so
// "the current device is asked differently" cannot be observed there without
// revoking something for real. Here it costs nothing.

import { describe, expect, it } from 'vitest';
import { canRevoke, larkDevices, revokePrompt } from './devices';

const OTHER = { name: 'jay 的 MacBook', isCurrent: false, revokedAt: null };
const SELF = { name: 'vivo V2408A', isCurrent: true, revokedAt: null };

describe('canRevoke', () => {
  it('offers nothing on a device that is already revoked', () => {
    expect(canRevoke({ ...OTHER, revokedAt: 1_700_000_000_000 })).toBe(false);
    expect(canRevoke(OTHER)).toBe(true);
  });
});

describe('revokePrompt', () => {
  it('names the device when it is somebody else, and says this phone is safe', () => {
    const prompt = revokePrompt(OTHER);

    expect(prompt.title).toContain('jay 的 MacBook');
    expect(prompt.message).toContain('这台手机不受影响');
  });

  it('warns that THIS phone goes offline when the target is this phone', () => {
    const prompt = revokePrompt(SELF);

    // The distinguishing claim, and the reason the two are not one string with
    // a name substituted in: what happens to the screen you are holding.
    expect(prompt.message).toContain('重新登录');
    expect(prompt.message).not.toContain('这台手机不受影响');
    expect(prompt.confirm).not.toBe(revokePrompt(OTHER).confirm);
  });

  it('promises the same thing about the library either way — revoking is not a delete', () => {
    expect(revokePrompt(SELF).message).toContain('曲库');
    expect(revokePrompt(OTHER).message).not.toContain('删');
  });
});

describe('larkDevices', () => {
  // The list the measurement phone actually returned on 2026-08-26.
  const REAL = [
    { name: 'owl-cloud@iZbp13vw6ketn1heedyi64Z', appVersion: 'owl 0.5.0' },
    { name: 'jayncpdeMacBook-Pro.local (owl)', appVersion: 'owl 0.5.0' },
    { name: 'vivo V2408A', appVersion: 'lark 0.1.0' },
    { name: 'jayncpdeMacBook-Pro.local', appVersion: 'lark 0.3.0' },
    { name: 'vivo V2408A', appVersion: 'lark 0.1.0' },
  ];

  it('keeps lark and counts what it dropped', () => {
    const { shown, hidden } = larkDevices(REAL);

    expect(shown.map((d) => d.appVersion)).toEqual(['lark 0.1.0', 'lark 0.3.0', 'lark 0.1.0']);
    // Counted, not silently gone: those two hold this account's credentials.
    expect(hidden).toBe(2);
  });

  it('keeps a device whose app is unknown', () => {
    // The direction that matters: this list is where somebody goes to revoke
    // a device they no longer trust, so an unprovable row stays visible.
    const { shown, hidden } = larkDevices([{ appVersion: null }]);

    expect(shown).toHaveLength(1);
    expect(hidden).toBe(0);
  });

  it('does not mistake another tool whose name starts with lark', () => {
    const { shown, hidden } = larkDevices([{ appVersion: 'larkbird 2.0' }]);

    expect(shown).toHaveLength(0);
    expect(hidden).toBe(1);
  });
});
