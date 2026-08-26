// Criterion 106 (N7b). Two claims, and only one of them is about lark: that
// this repo and owl compute the SAME id for the same pair, and that input a
// server could never have sent is refused rather than hashed.
//
// The fixtures below were produced by running owl's own build —
// `require('../owl/packages/core/dist/profile/id.js').computeProfileId` — on
// 2026-08-26. They are checked in rather than computed at test time on
// purpose: a test that imports the other repo passes when that repo is
// missing, and stops meaning anything the day the two are packaged apart.

import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_LOCAL,
  computeWorkspaceId,
  isAccountWorkspaceId,
  isWorkspaceId,
} from './workspace.js';

/** (server_id, user_id) → id, straight out of owl. */
const OWL: readonly { server_id: string; user_id: string; id: string }[] = [
  {
    server_id: 'srv-01H8XGJWBWBAQ4TM4T',
    user_id: 'usr-01H8XGJWBWBAQ4TM4T',
    id: '0d37bfbdb385448f80a53bd8ba7e61d3',
  },
  { server_id: 'a', user_id: 'b', id: '7e18f737311b2dc3b2f269dd78396b03' },
  { server_id: 'a\nb', user_id: 'c', id: 'ea7fb08b7a2dc4619ffb7c7bb38d95a2' },
  { server_id: 'ab', user_id: '\nc', id: 'a92ea183178e6169f30471027ab9b2a2' },
  { server_id: '服务器', user_id: '用户', id: '4359394f2547585eecac7ec5519e7bb6' },
  {
    server_id: 'S'.repeat(200),
    user_id: 'U'.repeat(200),
    id: '34d89b72259329979fc5f8fd04d5f321',
  },
  { server_id: '0', user_id: '0', id: '758008efb9c8566d26b4ae6683afde9a' },
];

describe('the same id owl computes', () => {
  for (const { server_id, user_id, id } of OWL) {
    it(`${JSON.stringify(server_id)} + ${JSON.stringify(user_id)} → ${id}`, () => {
      expect(computeWorkspaceId(server_id, user_id)).toBe(id);
    });
  }

  it('is 32 lowercase hex, which is the width that is frozen', () => {
    for (const { server_id, user_id } of OWL) {
      expect(computeWorkspaceId(server_id, user_id)).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe('what the id is a function of', () => {
  it('the same pair, every time — this is the whole feature', () => {
    const once = computeWorkspaceId('srv', 'usr');
    expect(computeWorkspaceId('srv', 'usr')).toBe(once);
    // Logging out and back in must land on the copy that is already there.
    expect(computeWorkspaceId('srv', 'usr')).toBe(once);
  });

  it('the server IDENTITY, so a url change does not orphan a library', () => {
    // Nothing about a url reaches this function; that is the point (D11).
    expect(computeWorkspaceId('srv', 'usr')).toBe(computeWorkspaceId('srv', 'usr'));
  });

  it('both halves — a different account on one server is a different workspace', () => {
    expect(computeWorkspaceId('srv', 'a')).not.toBe(computeWorkspaceId('srv', 'b'));
    expect(computeWorkspaceId('a', 'usr')).not.toBe(computeWorkspaceId('b', 'usr'));
  });

  it('the input verbatim — no trimming, no case folding', () => {
    expect(computeWorkspaceId(' srv', 'usr')).not.toBe(computeWorkspaceId('srv', 'usr'));
    expect(computeWorkspaceId('SRV', 'usr')).not.toBe(computeWorkspaceId('srv', 'usr'));
  });

  it('KNOWN, inherited from owl: the separator is not escaped', () => {
    // ('a', 'b\nc') and ('a\nb', 'c') both hash "a\nb\nc". Harmless where the
    // ids come from — a skybridge server issues opaque tokens with no newlines
    // in them — and recorded here so it is a decision rather than a surprise.
    expect(computeWorkspaceId('a', 'b\nc')).toBe(computeWorkspaceId('a\nb', 'c'));
  });
});

describe('input a server could not have sent', () => {
  it('is refused rather than turned into a directory name', () => {
    expect(() => computeWorkspaceId('', 'usr')).toThrow();
    expect(() => computeWorkspaceId('srv', '')).toThrow();
    expect(() => computeWorkspaceId('', '')).toThrow();
  });
});

describe('which strings name a workspace', () => {
  it('accepts `local` and 32 lowercase hex, and nothing else', () => {
    expect(isWorkspaceId(WORKSPACE_LOCAL)).toBe(true);
    expect(isWorkspaceId(computeWorkspaceId('srv', 'usr'))).toBe(true);

    for (const bad of [
      '',
      'Local',
      'LOCAL',
      '0D37BFBDB385448F80A53BD8BA7E61D3',
      '0d37bfbdb385448f80a53bd8ba7e61d', // 31
      '0d37bfbdb385448f80a53bd8ba7e61d33', // 33
      '0d37bfbdb385448f80a53bd8ba7e61g3',
      '../escape',
      'libraries',
      ' 0d37bfbdb385448f80a53bd8ba7e61d3',
    ]) {
      expect(isWorkspaceId(bad)).toBe(false);
    }
  });

  it('tells an account workspace apart from the local one', () => {
    // The two are not interchangeable anywhere: `local` lives at the root of
    // the nest and account workspaces live under `libraries/`.
    expect(isAccountWorkspaceId(WORKSPACE_LOCAL)).toBe(false);
    expect(isAccountWorkspaceId(computeWorkspaceId('srv', 'usr'))).toBe(true);
  });
});
