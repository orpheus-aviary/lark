// Multi-device sync against a REAL skybridge server (v0.2 T6, §6 L1–L20).
//
// Three lark libraries (A / B / C), each an in-memory core database with its
// own registered device id, one account, one workspace, one in-process
// skybridge server. What this proves that the unit tests cannot: the wire is
// the real one. `engine.test.ts` drives a fake client whose idea of the
// protocol is ours; here the server assigns the `server_seq`, enforces the
// limits, and hands back envelopes nobody in this repo wrote.
//
// METADATA ONLY, on purpose. No `FileEffectRuntime` is passed, so a change
// that would touch a file leaves its row in `sync_file_ops` and the test reads
// THAT — three devices in one process cannot each own a nest directory
// (`LARK_NEST_DIR` is process-global). Files are the multi-process suite's job
// (`sync.files.e2e.ts`), which is why that one exists.
//
// Two layers of gating, following owl:
//
//   ① the filename. `*.e2e.ts` is outside the `src/**/*.test.ts` glob, so a
//      normal `just test-daemon` never picks it up.
//   ② resolution. `@orpheus-aviary/skybridge-server` is a PRIVATE package —
//      it is not on npm and lark does not depend on it. It is looked up at
//      run time (installed package → `LARK_SKYBRIDGE_SERVER` → the sibling
//      checkout), and the suite skips when none of those answer. Set
//      `LARK_SYNC_E2E_REQUIRED=1` (as `just test-sync-e2e` does) to turn that
//      skip into a failure, so the recipe cannot be quietly green.

import { randomUUID } from 'node:crypto';
import {
  FileEffectRuntime,
  type LarkDatabase,
  type LyricsSnapshot,
  type RunSyncResult,
  addSongsToPlaylist,
  countUnresolvedConflicts,
  createDatabase,
  createPlaylist,
  createSong,
  deleteSong,
  ensureDeviceUuid,
  getPlaylistSongs,
  listConflicts,
  listPlaylists,
  listSongs,
  markBackfillDone,
  normalizeRanksInTx,
  readLocalDeviceUuid,
  readSkybridgeDeviceId,
  rebaseLocalKeys,
  removeSongFromPlaylist,
  reorderSong,
  runFullBackfillInTx,
  runSync,
  setPinned,
  setServerTimeOffset,
  setSkybridgeDeviceId,
  stampDeviceIdInTx,
  updateSong,
  writeBindingInTx,
} from '@lark/core';
import { SYNC_WORKSPACE_NAME, SYNC_WORKSPACE_TOOL, type SongData } from '@lark/shared';
import { CLIENT_VERSION, createSkybridgeClient, login } from '@orpheus-aviary/skybridge-client';
import type BetterSqlite3 from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type RunningSkybridgeServer,
  type SkybridgeServerModule,
  resolveSkybridgeServer,
  startSkybridgeServer,
} from '../testing/skybridge-server.js';

const serverModule = await resolveSkybridgeServer();

// ─── Devices ───────────────────────────────────────────

interface Device {
  label: string;
  db: LarkDatabase;
  sqlite: BetterSqlite3.Database;
  client: ReturnType<typeof createSkybridgeClient>;
  serverId: string;
  workspaceId: string;
  skybridgeDeviceId: string;
  localUuid: string;
}

const APP_VERSION = 'lark 0.2.0';

/**
 * Everything `performSyncLogin` does, minus the parts that need a daemon.
 *
 * The order is the plan's frozen one (§3.7): register → ensureWorkspace →
 * (one transaction) binding → backfill → rebase → device stamp → generation.
 * It is duplicated here rather than imported because the daemon's version also
 * writes `skybridge.toml`, installs a session and starts timers — none of
 * which a three-library-in-one-process test can have.
 */
async function createDevice(
  label: string,
  server: RunningSkybridgeServer,
  email: string,
  password: string,
  lyrics: LyricsSnapshot = new Map(),
): Promise<Device> {
  const auth = await login(server.baseUrl, email, password);

  const { db, sqlite } = createDatabase({ dbPath: ':memory:' });
  ensureDeviceUuid(sqlite);
  const localUuid = readLocalDeviceUuid(sqlite);

  const bootstrap = createSkybridgeClient({ authContext: auth });
  const device = await bootstrap.registerDevice({
    name: `e2e-${label}`,
    appVersion: APP_VERSION,
    clientVersion: CLIENT_VERSION,
  });
  const client = createSkybridgeClient({ authContext: auth, deviceId: device.id });
  const workspace = await client.ensureWorkspace(SYNC_WORKSPACE_TOOL, SYNC_WORKSPACE_NAME);

  sqlite
    .transaction(() => {
      writeBindingInTx(sqlite, {
        server_id: server.baseUrl,
        user_id: auth.user.id,
        workspace_id: workspace.id,
        schema_version: workspace.schemaVersion,
      });
      setServerTimeOffset(sqlite, 0);
      runFullBackfillInTx(sqlite, lyrics);
      rebaseLocalKeys(sqlite, Date.now());
      stampDeviceIdInTx(sqlite, {
        deviceId: device.id,
        previousId: readSkybridgeDeviceId(sqlite),
        localUuid,
      });
      setSkybridgeDeviceId(sqlite, device.id);
      markBackfillDone(sqlite);
    })
    .immediate();

  return {
    label,
    db,
    sqlite,
    client,
    serverId: server.baseUrl,
    workspaceId: workspace.id,
    skybridgeDeviceId: device.id,
    localUuid,
  };
}

function sync(device: Device): Promise<RunSyncResult> {
  return runSync({
    sqlite: device.sqlite,
    client: device.client,
    serverId: device.serverId,
    workspaceId: device.workspaceId,
  });
}

/** Push then pull, for the device that has to both publish and catch up. */
async function syncTwice(device: Device): Promise<RunSyncResult> {
  await sync(device);
  return sync(device);
}

function songNames(device: Device): string[] {
  return listSongs(device.db, device.sqlite)
    .songs.map((song) => song.name)
    .sort();
}

function songByName(device: Device, name: string): SongData {
  const found = listSongs(device.db, device.sqlite).songs.find((song) => song.name === name);
  if (found === undefined) throw new Error(`${device.label} has no song named ${name}`);
  return found;
}

function pendingOps(device: Device): { op: string; entity_type: string; entity_id: string }[] {
  return device.sqlite
    .prepare(
      'SELECT op, entity_type, entity_id FROM sync_changes WHERE synced_at IS NULL ORDER BY local_seq',
    )
    .all() as { op: string; entity_type: string; entity_id: string }[];
}

// ─── The journey ───────────────────────────────────────

describe.skipIf(serverModule === null)('sync against a real skybridge server', () => {
  let server: RunningSkybridgeServer;
  let a: Device;
  let b: Device;
  let c: Device;

  const email = 'e2e@lark.test';
  const password = 'correct-horse-battery';

  beforeAll(async () => {
    const sb = serverModule as SkybridgeServerModule;
    server = await startSkybridgeServer(sb);
    await sb.createUser(server.db, { email, password });

    // A is the device with a library: two songs and a playlist that predate
    // sync, which is what makes its first login a real backfill (⑩).
    a = await createDevice('A', server, email, password);
  }, 60_000);

  afterAll(async () => {
    a?.sqlite.close();
    b?.sqlite.close();
    c?.sqlite.close();
    await server?.close();
  });

  // L1 · bootstrap
  it('binds every device to the same workspace under one account', async () => {
    b = await createDevice('B', server, email, password);

    expect(b.workspaceId).toBe(a.workspaceId);
    expect(b.skybridgeDeviceId).not.toBe(a.skybridgeDeviceId);
    // Two identity domains, never mixed (R18): the entity `device_id` is the
    // skybridge registration, the local one is the nest's own uuid.
    expect(b.localUuid).not.toBe(b.skybridgeDeviceId);
  });

  // L2 / L3 · client_change_id is a real UUIDv4, and the server's seq only grows
  it('publishes a library and gets back monotonic sequence numbers', async () => {
    const song = createSong(a.db, a.sqlite, {
      name: '温柔',
      artist: '五月天',
      source_url: 'https://www.bilibili.com/video/BV1',
      source_provider: 'bilibili',
      source_key: 'BV1:100',
    });
    const playlist = createPlaylist(a.db, a.sqlite, '晚上听');
    addSongsToPlaylist(a.db, a.sqlite, playlist.id, [song.id]);

    const cids = a.sqlite.prepare('SELECT client_change_id FROM sync_changes').all() as {
      client_change_id: string;
    }[];
    expect(cids.length).toBeGreaterThan(0);
    for (const row of cids) {
      expect(row.client_change_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }

    const first = await sync(a);
    expect(first.pushed).toBeGreaterThan(0);
    expect(first.cursor.pushedSeq).toBeGreaterThan(0);

    updateSong(a.db, a.sqlite, song.id, { artist: '五月天 Mayday' });
    const second = await sync(a);
    expect(second.cursor.pushedSeq).toBeGreaterThan(first.cursor.pushedSeq);
  });

  // L4 · a device skips the echo of its own LWW put
  it('does not re-apply its own changes when they come back', async () => {
    const before = songByName(a, '温柔');

    const round = await sync(a);

    expect(round.applied).toBe(0);
    const after = songByName(a, '温柔');
    expect(after.updated_at).toBe(before.updated_at);
  });

  // L5 · a new device pulls the whole history and reconstructs the library
  it('replays the whole log onto a device that has never seen it', async () => {
    const round = await sync(b);

    expect(round.applied).toBeGreaterThan(0);
    expect(songNames(b)).toEqual(['温柔']);
    const playlists = listPlaylists(b.db, b.sqlite).filter((p) => p.name === '晚上听');
    expect(playlists).toHaveLength(1);
    expect(getPlaylistSongs(b.db, b.sqlite, playlists[0]?.id ?? '')).toHaveLength(1);
    // The row carries the ORIGINATING device, not the receiver's (§3.10).
    const row = b.sqlite.prepare('SELECT device_id FROM songs WHERE name = ?').get('温柔') as {
      device_id: string | null;
    };
    expect(row.device_id).toBe(a.skybridgeDeviceId);
  });

  // L6 / L7 · B edits A's song; the winner carries B's device id
  it('lets the other device edit, and flips the attribution', async () => {
    const song = songByName(b, '温柔');
    updateSong(b.db, b.sqlite, song.id, { name: '温柔（现场）' });
    await sync(b);
    await sync(a);

    expect(songByName(a, '温柔（现场）').id).toBe(song.id);
    const row = a.sqlite.prepare('SELECT device_id FROM songs WHERE id = ?').get(song.id) as {
      device_id: string | null;
    };
    expect(row.device_id).toBe(b.skybridgeDeviceId);
  });

  // L8 · two devices add the same source key while apart: both survive (D8)
  it('keeps both songs when two devices claim the same source key', async () => {
    createSong(a.db, a.sqlite, {
      name: '晴天 A',
      artist: '周杰伦',
      source_url: 'https://www.bilibili.com/video/BV2',
      source_provider: 'bilibili',
      source_key: 'BV2:200',
    });
    createSong(b.db, b.sqlite, {
      name: '晴天 B',
      artist: '周杰伦',
      source_url: 'https://www.bilibili.com/video/BV2',
      source_provider: 'bilibili',
      source_key: 'BV2:200',
    });

    await sync(a);
    await syncTwice(b);
    await sync(a);

    for (const device of [a, b]) {
      const duplicates = device.sqlite
        .prepare(
          "SELECT count(*) AS n FROM songs WHERE source_provider = 'bilibili' AND source_key = 'BV2:200'",
        )
        .get() as { n: number };
      expect(duplicates.n, `${device.label} kept both`).toBe(2);
    }
  });

  // L9 · a delete beats a concurrent edit, permanently (D6)
  it('lets a delete win over an edit that never met it', async () => {
    const doomed = createSong(a.db, a.sqlite, { name: '要删掉的', artist: '' });
    await sync(a);
    await sync(b);

    // B edits it while A deletes it — neither has seen the other.
    updateSong(b.db, b.sqlite, doomed.id, { name: '改过名字的' });
    await deleteSong(a.db, a.sqlite, doomed.id, {
      fileOps: new FileEffectRuntime({ sqlite: a.sqlite }),
    });
    await sync(a);
    await syncTwice(b);
    await sync(a);

    expect(songNames(b)).not.toContain('改过名字的');
    expect(songNames(a)).not.toContain('改过名字的');
    // The tombstone is what keeps it dead on the next round too.
    const tombstone = b.sqlite
      .prepare(
        "SELECT count(*) AS n FROM sync_tombstones WHERE entity_type = 'song' AND entity_id = ?",
      )
      .get(doomed.id) as { n: number };
    expect(tombstone.n).toBe(1);
  });

  // L10 · a membership can be removed and added back (D6: LWW resurrection)
  it('resurrects a membership that was removed and added again', async () => {
    const playlist = listPlaylists(a.db, a.sqlite).find((p) => p.name === '晚上听');
    const song = songByName(a, '温柔（现场）');
    if (playlist === undefined) throw new Error('playlist missing');

    removeSongFromPlaylist(a.db, a.sqlite, playlist.id, song.id);
    await sync(a);
    await sync(b);
    expect(getPlaylistSongs(b.db, b.sqlite, playlist.id)).toHaveLength(0);

    addSongsToPlaylist(a.db, a.sqlite, playlist.id, [song.id]);
    await sync(a);
    await sync(b);
    expect(getPlaylistSongs(b.db, b.sqlite, playlist.id)).toHaveLength(1);
  });

  // L12 · rank travels on its own channel; the two devices agree on the order
  it('converges the order after a normalisation and a drag', async () => {
    const playlist = listPlaylists(a.db, a.sqlite).find((p) => p.name === '晚上听');
    if (playlist === undefined) throw new Error('playlist missing');
    const extra = createSong(a.db, a.sqlite, { name: '第二首', artist: '' });
    addSongsToPlaylist(a.db, a.sqlite, playlist.id, [extra.id]);

    // Normalise first, and check the ranks came out DISTINCT: a re-added
    // membership takes `max(rank) + 1024` on whichever device saw it first, so
    // two members can legitimately arrive holding the same rank — and a drag
    // between two equal ranks has nothing to land between. One `reorder` is
    // what makes the two devices agree on the starting line.
    a.sqlite.transaction(() => normalizeRanksInTx(a.db, playlist.id)).immediate();
    await sync(a);
    await sync(b);

    const ranks = (device: Device) =>
      (
        device.sqlite
          .prepare('SELECT rank FROM playlist_songs WHERE playlist_id = ? ORDER BY rank')
          .all(playlist.id) as { rank: number }[]
      ).map((row) => row.rank);
    expect(new Set(ranks(a)).size).toBe(ranks(a).length);
    const order = getPlaylistSongs(a.db, a.sqlite, playlist.id).map((song) => song.id);
    expect(order).toHaveLength(2);
    expect(getPlaylistSongs(b.db, b.sqlite, playlist.id).map((song) => song.id)).toEqual(order);

    // The drag is rank-only plus one `set_rank` — the LWW triple is untouched
    // (D7), which is exactly why the other device can replay it verbatim.
    reorderSong(a.db, a.sqlite, playlist.id, order[1] as string, {
      before_song_id: order[0] as string,
    });
    const published = a.sqlite
      .prepare("SELECT op FROM sync_changes WHERE op = 'set_rank' AND synced_at IS NULL")
      .all() as { op: string }[];
    expect(published).toHaveLength(1);

    // TWO rounds on A, and the reason is a real property of the ⚡ channel: a
    // round pulls before it pushes, so the first one replays A's own earlier
    // `reorder` echo — which puts the order back where it was — while the
    // `set_rank` that supersedes it is still sitting in the outbox. It takes
    // its own echo coming back, at a higher `server_seq`, to settle. The drag
    // is durable throughout; what flickers is only the order, for one round.
    await syncTwice(a);
    await sync(b);

    const afterA = getPlaylistSongs(a.db, a.sqlite, playlist.id).map((song) => song.id);
    expect(afterA).toEqual([order[1], order[0]]);
    expect(getPlaylistSongs(b.db, b.sqlite, playlist.id).map((song) => song.id)).toEqual(afterA);
  });

  // L13 · lyrics travel as metadata ops; the receiver queues a file write
  it('carries lyrics to the other device as a queued file effect', async () => {
    const song = songByName(a, '温柔（现场）');
    a.sqlite
      .prepare(
        `INSERT INTO sync_changes (client_change_id, entity_type, entity_id, op, payload, local_seq, created_at, device_id)
         VALUES (?, 'song', ?, 'set_lyrics', ?, (SELECT COALESCE(MAX(local_seq), 0) + 1 FROM sync_changes), ?, ?)`,
      )
      .run(
        randomUUID(),
        song.id,
        JSON.stringify({ lrc: '[00:01.00]一句歌词' }),
        Date.now(),
        a.localUuid,
      );

    await sync(a);
    await sync(b);

    const queued = b.sqlite
      .prepare("SELECT kind, song_id, arg FROM sync_file_ops WHERE kind = 'write_lyrics'")
      .all() as { kind: string; song_id: string; arg: string }[];
    expect(queued).toHaveLength(1);
    expect(queued[0]?.song_id).toBe(song.id);
    expect(JSON.parse(queued[0]?.arg ?? '{}').inline).toContain('一句歌词');
  });

  // L14 · local-only fields never leave the device
  it('never publishes a pin', async () => {
    const song = songByName(a, '温柔（现场）');
    setPinned(a.db, a.sqlite, song.id, true);

    expect(pendingOps(a)).toHaveLength(0);
    await sync(a);
    await sync(b);
    expect(songByName(b, '温柔（现场）').pinned).toBe(false);
  });

  // L11 · a concurrent edit both ways records a conflict on the loser
  it('records a conflict when two devices edit the same song at once', async () => {
    const song = songByName(a, '温柔（现场）');
    // B edits FIRST, so its key is the older one; A then edits and pushes.
    // A conflict is recorded on the side that LOSES, which has to be B.
    updateSong(b.db, b.sqlite, song.id, { artist: 'B 写的' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    updateSong(a.db, a.sqlite, song.id, { artist: 'A 写的' });

    await sync(a);
    await syncTwice(b);

    expect(countUnresolvedConflicts(b.sqlite)).toBe(1);
    const conflict = listConflicts(b.sqlite)[0];
    expect(conflict?.entity_id).toBe(song.id);
    expect(JSON.parse(conflict?.local_payload ?? '{}').artist).toBe('B 写的');
    expect(JSON.parse(conflict?.remote_payload ?? '{}').artist).toBe('A 写的');
  });

  // L18 · a change nobody can parse is filed, not swallowed, and the cursor moves
  it('dead-letters an unparseable change and keeps going', async () => {
    const before = (
      b.sqlite.prepare('SELECT count(*) AS n FROM sync_dead_letters').get() as { n: number }
    ).n;

    a.sqlite
      .prepare(
        `INSERT INTO sync_changes (client_change_id, entity_type, entity_id, op, payload, local_seq, created_at, device_id)
         VALUES (?, 'song', ?, 'create', ?, (SELECT COALESCE(MAX(local_seq), 0) + 1 FROM sync_changes), ?, ?)`,
      )
      .run(randomUUID(), randomUUID(), JSON.stringify({ nonsense: true }), Date.now(), a.localUuid);
    await sync(a);
    const round = await sync(b);

    expect(round.deadLettered).toBe(1);
    const rows = b.sqlite
      .prepare('SELECT direction, payload, reason FROM sync_dead_letters ORDER BY id DESC LIMIT 1')
      .all() as { direction: string; payload: string; reason: string }[];
    expect(
      (b.sqlite.prepare('SELECT count(*) AS n FROM sync_dead_letters').get() as { n: number }).n,
    ).toBe(before + 1);
    expect(rows[0]?.direction).toBe('in');
    // The WHOLE envelope is kept, not the three fields that identify it — the
    // point of the table is that a human can see what actually arrived.
    const envelope = JSON.parse(rows[0]?.payload ?? '{}');
    expect(envelope.server_seq).toBeGreaterThan(0);
    expect(envelope.client_change_id).toBeDefined();
    expect(envelope.payload).toEqual({ nonsense: true });
    // And the round did not stop: the cursor is past it.
    expect(round.cursor.pulledSeq).toBeGreaterThanOrEqual(envelope.server_seq);
  });

  // L15 · a third device joins late and ends up identical to the others
  it('brings a third device to the same library from history alone', async () => {
    c = await createDevice('C', server, email, password);
    await syncTwice(c);
    await sync(a);
    await sync(b);

    expect(songNames(c)).toEqual(songNames(a));
    expect(songNames(c)).toEqual(songNames(b));
    const playlistOf = (device: Device) =>
      listPlaylists(device.db, device.sqlite)
        .map((p) => p.name)
        .sort();
    expect(playlistOf(c)).toEqual(playlistOf(a));
  });

  // L19 · a device whose clock ran ahead has its unpushed keys rebased
  it('rebases a far-future clock onto the server time at bind', async () => {
    const future = await createDevice('D', server, email, password);
    try {
      const song = createSong(future.db, future.sqlite, { name: '未来的歌', artist: '' });
      // Push the row and its pending op a year into the future, the way a
      // wrong system clock would.
      const ahead = Date.now() + 365 * 86_400_000;
      future.sqlite.prepare('UPDATE songs SET updated_at = ? WHERE id = ?').run(ahead, song.id);
      future.sqlite
        .prepare(
          "UPDATE sync_changes SET payload = json_set(payload, '$.updated_at_ms', CAST(? AS INTEGER)) WHERE entity_id = ?",
        )
        .run(ahead, song.id);

      const rebased = future.sqlite
        .transaction(() => rebaseLocalKeys(future.sqlite, Date.now()))
        .immediate();
      expect(rebased.entities).toBeGreaterThan(0);

      const row = future.sqlite
        .prepare('SELECT updated_at FROM songs WHERE id = ?')
        .get(song.id) as { updated_at: number };
      expect(row.updated_at).toBeLessThan(ahead);

      // And it still converges: the rebased key is what the others receive.
      await sync(future);
      await sync(a);
      expect(songNames(a)).toContain('未来的歌');
    } finally {
      future.sqlite.close();
    }
  });
});
