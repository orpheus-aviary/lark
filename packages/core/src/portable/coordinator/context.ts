// Everything the sync coordinator needs from the process it runs in (N1f).
//
// The coordinator is the layer between core's protocol (`runSync`, `apply`,
// the outbox) and whatever is hosting it: it owns the session, the lifecycle
// mutex, the login install sequence and the state `GET /sync/status` reports.
// None of that is desktop-shaped — a phone logs in, refreshes a token and
// drops a rejected session in exactly the same order — but all of it needs
// things only a host can supply: a credential store, an event sink, a name to
// register under, a clock.
//
// So it arrives here as ONE object, assembled once by the host. The daemon
// builds it from its `AppContext` (`daemon/src/sync/coordinator.ts`); N5's
// mobile client will build it from its own. Nothing in this directory reads a
// module global, and nothing in it knows which host it is.

import type { PortableDb } from '../db.js';
import type { StructuredLogger } from '../logger.js';
import type { CredentialStore } from '../ports/credentials.js';
import type { DeviceNameSource } from '../ports/device.js';
import type { EventsBus } from '../ports/events.js';
import type { FileContext } from '../ports/fs.js';
import type { FileEffectLike } from '../sync/file-ops.js';
import type { SkybridgeApi } from './client.js';
import type { SyncRuntime } from './runtime.js';

export interface CoordinatorContext {
  /**
   * The session, the epoch and the lifecycle mutex.
   *
   * On the context rather than owned by each function because it is the ONE
   * piece of state every one of them mutates, and because "which session is
   * current" has to survive across them — a round that started under one
   * session must be able to tell that it finished under another.
   */
  sync: SyncRuntime;
  db: PortableDb;
  /** Song files. The login backfill reads lyrics off disk before it commits. */
  files: FileContext;
  logger: StructuredLogger;
  credentials: CredentialStore;
  events: EventsBus;
  /** Now, in Unix ms. Injected so tests can drive expiry and backoff. */
  now: () => number;
  /** What this device registers as. Read at login, not at boot (see the port). */
  deviceName: DeviceNameSource;
  /**
   * The SDK surface. Required, with no default: a coordinator that silently
   * fell back to the real client would reach a real server from a test.
   */
  api: SkybridgeApi;
  /** Executes the file effects an applied batch queued. */
  fileOps: FileEffectLike;
  /**
   * How many songs a peer's delete has parked in quarantine.
   *
   * Injected (N1b) because counting them is a filesystem question and the
   * status builder is otherwise pure database + memory.
   */
  countQuarantined: () => number;
  /** `[sync] interval_min`, read on every re-arm so a config patch takes effect. */
  intervalMin: () => number;
  /**
   * Pull page size. The desktop uses `SYNC_PULL_LIMIT`; a phone will use a
   * smaller one, because the batch size that keeps a Mac responsive drops
   * frames on a mid-range Android (N0b-3, R5).
   */
  pullLimit: number;
  /** App version, reported to the server when this device registers. */
  version: string;
}
