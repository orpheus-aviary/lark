// Criteria 5, 6 and 7 (N2b). One case per cell of §2.4's matrix, plus the
// zero-write assertion every refusal owes.
//
// These build their libraries with better-sqlite3 and hand them over as
// `SqliteLike`, which is the whole reason the policy sits in portable: the six
// shapes an Android boot can meet are six shapes a desktop test runner can
// produce. The expo-sqlite shim satisfies the same interface, so what passes
// here is what runs there — not a second implementation that agrees for a
// while.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ForwardMigrationUnsupportedError,
  GoMigrationRequiredError,
  IncompatibleDbError,
} from './errors.js';
import { LATEST_KNOWN_VERSION, applyForwardMigrations } from './migrate.js';
import { classifyLibrary, prepareLibrary } from './open-library.js';
import { AUDIO_MIGRATION_PENDING_KEY } from './pending.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-open-library-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const path = (name = 'songs.db') => join(dir, name);

/** A connection with the same connection-level pragmas a host would set. */
function open(file: string): BetterSqlite3.Database {
  const sqlite = new BetterSqlite3(file);
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  return sqlite;
}

/** Build a library at `version`, close it, return the path. */
function libraryAt(version: number, file = path()): string {
  const sqlite = open(file);
  try {
    if (version > 0) applyForwardMigrations(sqlite, 0, Math.min(version, LATEST_KNOWN_VERSION));
    if (version > LATEST_KNOWN_VERSION) sqlite.pragma(`user_version = ${version}`);
  } finally {
    sqlite.close();
  }
  return file;
}

/** Run one statement of raw DDL on a fresh connection to `file`. */
function ddl(file: string, sql: string): void {
  const sqlite = open(file);
  try {
    sqlite.prepare(sql).run();
  } finally {
    sqlite.close();
  }
}

const version = (sqlite: BetterSqlite3.Database) =>
  sqlite.pragma('user_version', { simple: true }) as number;

const pendingRow = (sqlite: BetterSqlite3.Database) =>
  sqlite
    .prepare('SELECT value FROM local_metadata WHERE key = ?')
    .get(AUDIO_MIGRATION_PENDING_KEY) as { value: string } | undefined;

describe('§2.4 — the six cells', () => {
  it('user_version > LATEST is refused', () => {
    const sqlite = open(libraryAt(LATEST_KNOWN_VERSION + 1));
    try {
      expect(() => classifyLibrary(sqlite, 'db')).toThrow(IncompatibleDbError);
    } finally {
      sqlite.close();
    }
  });

  it('an empty file is fresh', () => {
    const sqlite = open(path());
    try {
      expect(classifyLibrary(sqlite, 'db')).toBe('fresh');
    } finally {
      sqlite.close();
    }
  });

  it('the Go-era fingerprint is refused by name', () => {
    const file = path();
    // user_version stays 0 (the Go app never set it) and `playlists` carries
    // the column the TS schema dropped — that pair IS the fingerprint.
    ddl(file, 'CREATE TABLE playlists (id TEXT PRIMARY KEY, is_system INTEGER)');
    const sqlite = open(file);
    try {
      expect(() => classifyLibrary(sqlite, 'db')).toThrow(GoMigrationRequiredError);
    } finally {
      sqlite.close();
    }
  });

  it('some other non-empty v0 schema is refused', () => {
    const file = path();
    ddl(file, 'CREATE TABLE somebody_elses (id TEXT PRIMARY KEY)');
    const sqlite = open(file);
    try {
      expect(() => classifyLibrary(sqlite, 'db')).toThrow(IncompatibleDbError);
    } finally {
      sqlite.close();
    }
  });

  it.each([1, 2])('v%i is refused rather than migrated (decision m)', (v) => {
    const sqlite = open(libraryAt(v));
    try {
      expect(version(sqlite)).toBe(v);
      expect(() => classifyLibrary(sqlite, 'db')).toThrow(ForwardMigrationUnsupportedError);
      // The message has to point the right way: this library is too OLD, and
      // telling its owner to upgrade the app would send them nowhere.
      expect(() => classifyLibrary(sqlite, 'db')).toThrow(/from an older lark/);
    } finally {
      sqlite.close();
    }
  });

  it('v3 is current, and the signature is checked rather than the number', () => {
    const file = libraryAt(LATEST_KNOWN_VERSION);
    const sqlite = open(file);
    try {
      expect(classifyLibrary(sqlite, 'db')).toBe('current');
    } finally {
      sqlite.close();
    }
    // Same version number, different schema. If the number were enough, this
    // would still read as 'current'.
    ddl(file, 'DROP TABLE sync_changes');
    const tampered = open(file);
    try {
      expect(() => classifyLibrary(tampered, 'db')).toThrow();
    } finally {
      tampered.close();
    }
  });
});

describe('criterion 5 — refusals write nothing', () => {
  const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

  // Byte-for-byte, not "is there a -wal beside it". A connection that is closed
  // checkpoints and removes its sidecars, so looking for them afterwards is an
  // assertion that is always true (MEASURED, N0b-5a). The main file's digest is
  // not: `journal_mode = WAL` alone rewrites the header.
  it.each([
    ['a future version', () => libraryAt(LATEST_KNOWN_VERSION + 1)],
    ['a v1 library', () => libraryAt(1)],
    [
      'a stranger’s schema',
      () => {
        const file = path();
        ddl(file, 'CREATE TABLE somebody_elses (id TEXT PRIMARY KEY)');
        return file;
      },
    ],
  ])('%s comes out byte-identical', (_label, build) => {
    const file = build();
    const before = { digest: digest(file), size: statSync(file).size };

    const sqlite = open(file);
    try {
      expect(() => classifyLibrary(sqlite, file)).toThrow();
    } finally {
      sqlite.close();
    }

    expect(statSync(file).size).toBe(before.size);
    expect(digest(file)).toBe(before.digest);
  });
});

describe('criterion 6 — the pending flag', () => {
  it('a fresh library reaches v3 with the flag cleared, row intact', () => {
    const sqlite = open(path());
    try {
      expect(prepareLibrary(sqlite, 'db')).toBe('fresh');
      expect(version(sqlite)).toBe(LATEST_KNOWN_VERSION);
      // The row stays and reads '0'. "We cleared this" and "this was never
      // set" are different facts about a library, and only one of them is true.
      expect(pendingRow(sqlite)).toEqual({ value: '0' });
    } finally {
      sqlite.close();
    }
  });

  it('an existing v3 library is not touched', () => {
    const file = libraryAt(LATEST_KNOWN_VERSION);
    // A library that genuinely still owes the conversion — the state a desktop
    // 0.2.x library lands in the moment it reaches v3.
    const seed = open(file);
    seed
      .prepare('UPDATE local_metadata SET value = ? WHERE key = ?')
      .run('1', AUDIO_MIGRATION_PENDING_KEY);
    seed.close();

    const sqlite = open(file);
    try {
      expect(prepareLibrary(sqlite, 'db')).toBe('current');
      // Still owed. Clearing it here would tell a later boot that `songs/`
      // holds no mp3 — something this host has never looked at.
      expect(pendingRow(sqlite)).toEqual({ value: '1' });
    } finally {
      sqlite.close();
    }
  });
});

describe('the onVerdict hook — where WAL is allowed to happen', () => {
  it('runs after the verdict and before the first write', () => {
    const sqlite = open(path());
    try {
      let versionAtHook: number | undefined;
      let verdictAtHook: string | undefined;
      prepareLibrary(sqlite, 'db', {
        onVerdict: (verdict) => {
          verdictAtHook = verdict;
          versionAtHook = version(sqlite);
        },
      });
      expect(verdictAtHook).toBe('fresh');
      // Nothing migrated yet — which is what makes this the safe moment to
      // turn on WAL, and the whole reason the hook exists rather than each
      // host re-deriving the ordering.
      expect(versionAtHook).toBe(0);
      expect(version(sqlite)).toBe(LATEST_KNOWN_VERSION);
    } finally {
      sqlite.close();
    }
  });

  it('is not called at all when the library is refused', () => {
    const sqlite = open(libraryAt(1));
    try {
      let called = 0;
      expect(() =>
        prepareLibrary(sqlite, 'db', {
          onVerdict: () => {
            called += 1;
          },
        }),
      ).toThrow(ForwardMigrationUnsupportedError);
      expect(called).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});

describe('what prepareLibrary deliberately does NOT do', () => {
  // §2.2 puts `ensureDeviceUuid` at step ⑨, after converge — so a library that
  // has only been through step ⑦ carries no local identity yet. Folding it in
  // here would look like a tidy-up and would silently move a step the D16 gate
  // has to own. MEASURED on the phone: the first version of the mobile panel
  // assumed the opposite and went red for exactly this reason.
  it('does not mint a device_uuid', () => {
    const sqlite = open(path());
    try {
      prepareLibrary(sqlite, 'db');
      const row = sqlite.prepare("SELECT value FROM local_metadata WHERE key='device_uuid'").get();
      expect(row).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });
});
