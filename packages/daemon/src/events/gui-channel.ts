// The GUI single-consumer channel (R11 / M2-6).
//
// Broadcast events go to every `/events` subscriber. Player COMMANDS must not:
// two windows both executing `pause` is a bug, so exactly one connection is
// "active" and gets the unicast. The active one is the most recent GUI to
// associate a connection — a newly launched window takes over, the old one
// stays subscribed to broadcasts, and when the active one drops the previous
// still-connected GUI is promoted back.
//
// Registration is a two-step handshake on purpose: `POST /gui/register` mints
// an id, `GET /events?role=gui&gui_id=<id>` associates it. That gives the
// daemon something to reject — an id it never minted (or one that expired, or
// one from before a daemon restart) is answered `409
// GUI_REGISTRATION_REQUIRED` BEFORE the stream is hijacked. Silently degrading
// such a connection to a plain subscriber would be worse than useless: the GUI
// would reconnect "successfully", never receive another command, and have no
// signal telling it to re-register.

import { randomUUID } from 'node:crypto';
import type { LarkEvent } from '@lark/shared';

/** Registration slots are full and every one of them is actively connected. */
export class GuiCapacityError extends Error {
  constructor(capacity: number) {
    super(`gui registration capacity (${capacity}) reached with all slots connected`);
    this.name = 'GuiCapacityError';
  }
}

/** What the SSE route hands over so the channel can talk to one connection. */
export interface GuiConnection {
  /** Write one event. `false` = the write failed / the socket is gone. */
  send: (event: LarkEvent) => boolean;
  /** End the stream (used when the same GUI re-associates). */
  close: () => void;
}

interface Registration {
  readonly id: string;
  readonly pid: number;
  readonly version: string;
  readonly registeredAt: number;
  connection: GuiConnection | null;
  expiry: ReturnType<typeof setTimeout> | null;
}

export interface GuiChannelOptions {
  /** How long a registration survives with no connection attached. */
  registrationTtlMs?: number;
  /** Maximum concurrent registrations. */
  capacity?: number;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_CAPACITY = 8;

export class GuiChannel {
  private readonly registrations = new Map<string, Registration>();
  /** Ids with a live connection, oldest first — the tail is the active one. */
  private readonly attachOrder: string[] = [];
  private readonly activeCloseHandlers = new Set<(guiId: string) => void>();
  private readonly ttlMs: number;
  private readonly capacity: number;
  private closed = false;

  constructor(options: GuiChannelOptions = {}) {
    this.ttlMs = options.registrationTtlMs ?? DEFAULT_TTL_MS;
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
  }

  /**
   * Mint a registration id. When the table is full, the oldest registration
   * with NO connection is evicted; if every slot is connected the caller gets
   * a `GuiCapacityError` (→ 409 GUI_CAPACITY) rather than having a live GUI
   * silently unregistered under it.
   */
  register(pid: number, version: string): string {
    if (this.registrations.size >= this.capacity) {
      const victim = this.oldestUnattached();
      if (!victim) throw new GuiCapacityError(this.capacity);
      this.drop(victim);
    }
    const reg: Registration = {
      id: randomUUID(),
      pid,
      version,
      registeredAt: Date.now(),
      connection: null,
      expiry: null,
    };
    this.registrations.set(reg.id, reg);
    this.armExpiry(reg);
    return reg.id;
  }

  /** Is this id one we minted and still hold? (Checked before the hijack.) */
  isRegistered(guiId: string): boolean {
    return this.registrations.has(guiId);
  }

  /**
   * Associate a connection with a registration; the newcomer becomes active.
   * Returns false for an unknown/expired id — the caller answers 409.
   */
  attach(guiId: string, connection: GuiConnection): boolean {
    const reg = this.registrations.get(guiId);
    if (!reg || this.closed) return false;
    this.clearExpiry(reg);
    const previous = reg.connection;
    if (previous) {
      // Same GUI opening a second stream: the older one is superseded.
      reg.connection = null;
      this.removeFromOrder(guiId);
      safeClose(previous);
    }
    reg.connection = connection;
    this.attachOrder.push(guiId);
    return true;
  }

  /**
   * Release a connection. A stale call (the connection was already superseded)
   * is ignored, so a late socket-close can't unseat the current stream.
   * Returns true when the ACTIVE connection was the one released.
   */
  detach(guiId: string, connection: GuiConnection): boolean {
    const reg = this.registrations.get(guiId);
    if (!reg || reg.connection !== connection) return false;
    const wasActive = this.activeId() === guiId;
    reg.connection = null;
    this.removeFromOrder(guiId);
    this.armExpiry(reg);
    if (wasActive) {
      for (const handler of [...this.activeCloseHandlers]) {
        try {
          handler(guiId);
        } catch {
          // one bad handler must not block the rest
        }
      }
    }
    return wasActive;
  }

  /** The gui id currently receiving unicast commands, or null. */
  activeId(): string | null {
    return this.attachOrder.length > 0 ? this.attachOrder[this.attachOrder.length - 1] : null;
  }

  /** True while some registered GUI holds a live connection. */
  guiOnline(): boolean {
    return this.activeId() !== null;
  }

  /**
   * Unicast to the active GUI. `false` means "not delivered" — no active
   * connection, or the write failed (socket died between the check and the
   * write). The caller must treat that as an immediate failure instead of
   * waiting out the ack timeout for a command nobody received.
   */
  sendToActive(event: LarkEvent): boolean {
    const id = this.activeId();
    if (!id) return false;
    const connection = this.registrations.get(id)?.connection;
    if (!connection) return false;
    try {
      return connection.send(event);
    } catch {
      return false;
    }
  }

  /** Subscribe to "the active connection just closed" (carrying its gui id). */
  onActiveClose(handler: (guiId: string) => void): () => void {
    this.activeCloseHandlers.add(handler);
    return () => {
      this.activeCloseHandlers.delete(handler);
    };
  }

  /** Registration count (connected or not) — test/observability hook. */
  size(): number {
    return this.registrations.size;
  }

  /**
   * Idempotent teardown: cancel every expiry timer, forget every registration
   * and connection, drop the callbacks. Runs inside `teardown` AFTER the HTTP
   * server closed (its preClose ends the streams) — a leftover timer or
   * connection reference here is exactly what keeps a test process alive.
   */
  close(): void {
    this.closed = true;
    for (const reg of this.registrations.values()) {
      this.clearExpiry(reg);
      reg.connection = null;
    }
    this.registrations.clear();
    this.attachOrder.length = 0;
    this.activeCloseHandlers.clear();
  }

  // ─── Internals ───────────────────────────────────────

  private oldestUnattached(): Registration | null {
    let oldest: Registration | null = null;
    for (const reg of this.registrations.values()) {
      if (reg.connection) continue;
      if (!oldest || reg.registeredAt < oldest.registeredAt) oldest = reg;
    }
    return oldest;
  }

  private drop(reg: Registration): void {
    this.clearExpiry(reg);
    this.removeFromOrder(reg.id);
    this.registrations.delete(reg.id);
  }

  private armExpiry(reg: Registration): void {
    if (this.closed) return;
    this.clearExpiry(reg);
    // Unref'd: a pending expiry must never be the reason the process lingers.
    const timer = setTimeout(() => this.drop(reg), this.ttlMs);
    timer.unref?.();
    reg.expiry = timer;
  }

  private clearExpiry(reg: Registration): void {
    if (reg.expiry === null) return;
    clearTimeout(reg.expiry);
    reg.expiry = null;
  }

  private removeFromOrder(guiId: string): void {
    const i = this.attachOrder.lastIndexOf(guiId);
    if (i !== -1) this.attachOrder.splice(i, 1);
  }
}

function safeClose(connection: GuiConnection): void {
  try {
    connection.close();
  } catch {
    // the socket is going away anyway
  }
}
