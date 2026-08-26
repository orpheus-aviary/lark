// Criterion 111 (N7c), and criterion 93's surviving half. The rules are here
// rather than in either front end because both show this list, and a device
// one of them hides while the other shows it is a device nobody can reason
// about.

import { describe, expect, it } from 'vitest';
import { hiddenDevicesNote, isLarkDevice, splitLarkDevices } from './sync-devices.js';

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
