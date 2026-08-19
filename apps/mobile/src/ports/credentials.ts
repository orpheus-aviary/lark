// `CredentialStore` over SecureStore (N2c, decision l).
//
// The desktop keeps these in `skybridge.toml` at 0600, rewritten whole and
// atomically, excluded from every backup layer. The phone's equivalent of "not
// in any backup" is SecureStore itself (D16), so the store IS the exclusion —
// no file, no mode bits, no rules file to keep in step.
//
// The whole credential set is one JSON value under one key. Wholesale replace
// is the port's contract anyway ("never a merge — the caller holds the
// complete truth"), and one key is one thing for a converge to delete.
//
// STOPS HERE. N2 needs exactly two of these methods — `delete()` for converge
// and `read()` to prove converge worked — and nothing on this device logs in
// until N5. Implementing the rest now rather than leaving throws is the
// cheaper choice only because the port is small; nothing here is exercised by
// a real login yet, and it says so.
//
// KNOWN LIMIT, unverified: Android's SecureStore warns above ~2KB per value.
// A real credential set is a URL, an email, two JWTs and two ids — plausibly
// close. N5 is where a real token first lands here, and that is where this
// gets measured rather than assumed.

import type { CredentialStash, CredentialStore, SkybridgeCredentials } from '@lark/core/portable';
import { deleteItemAsync, getItem, setItem } from 'expo-secure-store';

const KEY = 'lark.skybridge';
const STASH_KEY = 'lark.skybridge.stash';
const OPTIONS = { requireAuthentication: false } as const;

function parse(raw: string | null): SkybridgeCredentials | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const server = (parsed as { server?: unknown }).server;
    // "Present but naming no server" is the port's definition of nothing to
    // speak of — same verdict as absent.
    if (typeof server !== 'object' || server === null) return null;
    if (typeof (server as { url?: unknown }).url !== 'string') return null;
    return parsed as SkybridgeCredentials;
  } catch {
    return null;
  }
}

/**
 * `deleteItemAsync` is the only async call in the port's neighbourhood, and
 * the interface is synchronous. Writing an empty string is the synchronous
 * erase — every reader here treats `''` as absent — and the async delete is
 * fired afterwards so the key does not linger. Order matters: the value is
 * gone before this returns either way.
 */
function eraseSync(key: string): void {
  setItem(key, '', OPTIONS);
  void deleteItemAsync(key, OPTIONS).catch(() => {
    // Already empty as far as every reader is concerned.
  });
}

export function createSecureCredentialStore(): CredentialStore {
  return {
    read(): SkybridgeCredentials | null {
      return parse(getItem(KEY, OPTIONS));
    },

    write(credentials: SkybridgeCredentials): void {
      setItem(KEY, JSON.stringify(credentials), OPTIONS);
    },

    delete(): boolean {
      const existed = getItem(KEY, OPTIONS);
      if (existed === null || existed === '') return false;
      eraseSync(KEY);
      return true;
    },

    stash(): CredentialStash {
      const raw = getItem(KEY, OPTIONS);
      const existed = raw !== null && raw !== '';
      if (existed) {
        setItem(STASH_KEY, raw as string, OPTIONS);
        eraseSync(KEY);
      }
      return {
        existed,
        restore(): void {
          if (existed) setItem(KEY, raw as string, OPTIONS);
          eraseSync(STASH_KEY);
        },
        discard(): void {
          eraseSync(STASH_KEY);
        },
      };
    },
  };
}
