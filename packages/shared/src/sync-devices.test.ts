// Criterion 111 (N7c), and criterion 93's surviving half. The rules are here
// rather than in either front end because both show this list, and a device
// one of them hides while the other shows it is a device nobody can reason
// about.

import { describe, expect, it } from 'vitest';
import {
  REVOKED_DEVICES_NOTE,
  hiddenDevicesNote,
  isLarkDevice,
  revokedDevicesLabel,
  splitLarkDevices,
  splitRevokedDevices,
} from './sync-devices.js';

describe('whose device is this', () => {
  it('is ours when it says so', () => {
    for (const version of ['lark 0.3.0', 'lark', 'Lark 1.0', 'LARK 0.2.0']) {
      expect(isLarkDevice(version)).toBe(true);
    }
  });

  it('is not ours when another tool says so', () => {
    for (const version of ['owl 0.5.0', 'jay 0.1', 'skybridge-cli', 'larkspur 1.0', 'larkx']) {
      expect(isLarkDevice(version)).toBe(false);
    }
  });

  it('is shown when nobody said — this list is where you go to revoke', () => {
    // The careful half: an unknown app cannot be proven not to be ours (an
    // older client, a build predating the convention), and hiding it would
    // hide the thing somebody came here for.
    expect(isLarkDevice(null)).toBe(true);
  });
});

describe('splitting a list', () => {
  const rows = [
    { id: 'a', app_version: 'lark 0.3.0' },
    { id: 'b', app_version: 'owl 0.5.0' },
    { id: 'c', app_version: null },
    { id: 'd', app_version: 'owl 0.4.0' },
  ];

  it('shows ours and the unknown, counts the rest', () => {
    const split = splitLarkDevices(rows, (row) => row.app_version);
    expect(split.shown.map((row) => row.id)).toEqual(['a', 'c']);
    expect(split.hidden).toBe(2);
  });

  it('reads either spelling of the field — the two hosts differ', () => {
    // The desktop's wire shape is `app_version`; the SDK the phone talks to
    // says `appVersion`. Same judgement, handed the value.
    const mobile = [{ appVersion: 'lark 0.3.0' }, { appVersion: 'owl 0.5.0' }];
    expect(splitLarkDevices(mobile, (row) => row.appVersion)).toEqual({
      shown: [{ appVersion: 'lark 0.3.0' }],
      hidden: 1,
    });
  });

  it('hides nothing when there is nothing to hide', () => {
    expect(splitLarkDevices([], () => null)).toEqual({ shown: [], hidden: 0 });
  });
});

describe('what the screen says about what it is not showing', () => {
  it('says nothing when it hides nothing', () => {
    expect(hiddenDevicesNote(0)).toBeNull();
  });

  it('says how many, whose they are, and where to revoke them', () => {
    const note = hiddenDevicesNote(2) as string;
    expect(note).toContain('2');
    expect(note).toContain('凭证');
    // Without this half the count reads as a defect rather than a fact.
    expect(note).toContain('撤销');
  });
});

// N7g-3: revoked devices are tombstones the server cannot delete, and
// `resolveDevice` mints a fresh one every time — so the list only ever grows.
// The fold is what keeps that growth from burying the devices somebody came to
// look at.
describe('the revoked fold', () => {
  const row = (id: string, revokedAt: number | null) => ({ id, revokedAt });

  it('keeps the active ones out front and the tombstones behind', () => {
    const split = splitRevokedDevices(
      [row('a', null), row('b', 1000), row('c', null), row('d', 2000)],
      (r) => r.revokedAt,
    );

    expect(split.active.map((r) => r.id)).toEqual(['a', 'c']);
    expect(split.revoked.map((r) => r.id)).toEqual(['b', 'd']);
  });

  // The order within each half is the server's (`ORDER BY created_at`), and
  // both front ends render it as given — a fold that also reordered would make
  // "which one is the new registration" unanswerable.
  it('preserves the order it was given', () => {
    const split = splitRevokedDevices([row('x', 3), row('y', 1), row('z', 2)], (r) => r.revokedAt);

    expect(split.revoked.map((r) => r.id)).toEqual(['x', 'y', 'z']);
  });

  it('has no fold to show when nothing is revoked', () => {
    expect(revokedDevicesLabel(0, false)).toBeNull();
    expect(splitRevokedDevices([row('a', null)], (r) => r.revokedAt).revoked).toEqual([]);
  });

  it('says which way the fold goes', () => {
    expect(revokedDevicesLabel(3, false)).toBe('显示已撤销的 3 台');
    expect(revokedDevicesLabel(3, true)).toBe('收起已撤销的 3 台');
  });

  // Opening the fold raises "can I delete these?", and the answer is no. The
  // note has to carry the reason, or somebody goes hunting for a button that
  // does not exist.
  it('explains why they cannot be removed', () => {
    expect(REVOKED_DEVICES_NOTE).toContain('哪台设备写的');
    expect(REVOKED_DEVICES_NOTE).toContain('多条');
  });
});
