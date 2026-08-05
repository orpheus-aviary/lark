// The GUI ⇄ daemon session state machine (M4-9), React-free and fully
// deps-injected so every branch is unit-testable. `scripts/demo-gui-sim.mjs`
// is the frozen protocol reference this implements:
//
//   register → subscribe(?role=gui&gui_id=…) → events
//   409 GUI_REGISTRATION_REQUIRED → STOP the dead id → register again → resubscribe
//   any other disconnect → the subscribe loop's own backoff retry
//
// Recovery never depends on the daemon's TTL/capacity constants (10 min / 8):
// a 409 is handled whenever it arrives, whatever caused it.
//
// StrictMode safety (M4-8/T2): `dispose()` makes every later continuation a
// no-op — a register call resolving after cleanup must not open an SSE
// stream, or the remounted instance would share the daemon's single GUI slot
// with a ghost.

import { SseHttpError, parseLarkEvent } from '@lark/shared';
import type { LarkEvent, SseDisconnect, SubscribeSseOptions } from '@lark/shared';

export interface GuiSessionDeps {
  /** `POST /gui/register` → gui_instance_id. */
  registerGui(): Promise<string>;
  /** `subscribeSse` (or a test fake) — the retry loop lives inside it. */
  subscribe(options: SubscribeSseOptions): void;
  /** `GET /status` → pid, or null when unreachable / malformed. */
  probeStatusPid(): Promise<number | null>;
  /** Fresh token content (null = unreadable). Identity input, never logged. */
  readToken(): string | null;
  /** Every `hello`: connectionEpoch++ side effects (bump buses, refetches). */
  onHello(): void;
  /** Token content or /status pid changed across a reconnect (M4-8). */
  onGenerationChange(): void;
  /** Business events (everything but `hello`). */
  onEvent(event: LarkEvent): void;
  onOnline(): void;
  onOffline(): void;
  warn(msg: string): void;
  /** Delay before a register retry (network-down startup). Test-injectable. */
  registerRetryMs?: number;
  sleep?(ms: number): Promise<void>;
}

export class GuiSession {
  readonly #deps: GuiSessionDeps;
  #disposed = false;
  #controller: AbortController | null = null;
  /** Baseline for generation detection; null until the first check. */
  #identity: { token: string | null; pid: number | null } | null = null;
  #identitySeq = 0;

  constructor(deps: GuiSessionDeps) {
    this.#deps = deps;
  }

  start(): void {
    void this.#registerAndSubscribe();
  }

  dispose(): void {
    this.#disposed = true;
    this.#controller?.abort();
    this.#controller = null;
  }

  async #registerAndSubscribe(): Promise<void> {
    while (!this.#disposed) {
      let guiId: string;
      try {
        guiId = await this.#deps.registerGui();
      } catch (err) {
        this.#deps.warn(`gui register failed: ${String(err)}`);
        this.#deps.onOffline();
        await (this.#deps.sleep ?? defaultSleep)(this.#deps.registerRetryMs ?? 2000);
        continue;
      }
      if (this.#disposed) return; // register resolved after cleanup — do not attach
      this.#subscribe(guiId);
      return;
    }
  }

  #subscribe(guiId: string): void {
    const controller = new AbortController();
    this.#controller = controller;
    this.#deps.subscribe({
      path: `/events?role=gui&gui_id=${guiId}`,
      signal: controller.signal,
      onEvent: (_event, rawData) => this.#handleFrame(rawData),
      warn: this.#deps.warn,
      onDisconnect: (info) => this.#handleDisconnect(info, controller),
    });
  }

  #handleFrame(rawData: string): void {
    if (this.#disposed) return;
    const event = parseLarkEvent(rawData);
    if (event === null) {
      this.#deps.warn(`dropping malformed SSE frame: ${rawData.slice(0, 200)}`);
      return;
    }
    if (event.type === 'hello') {
      // Connection is live: epoch side effects fire immediately; the
      // generation check runs async and commits only if still current.
      this.#deps.onOnline();
      this.#deps.onHello();
      void this.#checkGeneration();
      return;
    }
    this.#deps.onEvent(event);
  }

  /**
   * daemonGeneration detection (M4-8): compare (token content, /status pid)
   * against the last-seen baseline once per (re)connect. The first check only
   * seeds the baseline. A newer check invalidates an older in-flight one.
   */
  async #checkGeneration(): Promise<void> {
    const seq = ++this.#identitySeq;
    const token = this.#deps.readToken();
    const pid = await this.#deps.probeStatusPid();
    if (this.#disposed || seq !== this.#identitySeq) return;
    const prev = this.#identity;
    this.#identity = { token, pid };
    if (prev !== null && (prev.token !== token || prev.pid !== pid)) {
      this.#deps.onGenerationChange();
    }
  }

  #handleDisconnect(info: SseDisconnect, controller: AbortController): 'stop' | undefined {
    if (this.#disposed) return 'stop';
    this.#deps.onOffline();
    if (info.error instanceof SseHttpError && info.error.status === 409) {
      // Registration is gone (daemon restart / TTL). Retrying the dead id
      // would "reconnect" forever without ever receiving a command — stop
      // this loop, register afresh, subscribe with a NEW controller.
      controller.abort();
      void this.#registerAndSubscribe();
      return 'stop';
    }
    return undefined; // let subscribeSse's backoff retry the same id
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
