// Wire types shared by every lark front-end (Electron renderer, CLI, future
// mobile). snake_case fields mirror the daemon's HTTP payloads verbatim;
// interface names are PascalCase. Kept free of any Node / Electron / DOM-host
// concept so the same definitions compile everywhere.

/**
 * The uniform response envelope. Exceptions (documented in the master plan
 * §R15): `GET /audio/:id` (binary + Range), `GET /lyrics/:id` (text/plain),
 * `GET /events` (SSE).
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error_code?: string;
  details?: Record<string, unknown>;
  total?: number;
}

/** `GET /status` payload — the daemon liveness probe (permanently unauthed). */
export interface StatusData {
  status: 'ok';
  /** Daemon process id, used by the GUI to adopt / replace a running daemon. */
  pid: number;
  /** Seconds since the daemon process started. */
  uptime: number;
  /** Daemon package version. */
  version: string;
}
