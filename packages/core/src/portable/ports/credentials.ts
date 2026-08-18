// The skybridge credential store, as an interface (N1a, subplan §1.1).
//
// The SHAPE is host-independent — it is a sync session, not a file format — so
// it is declared here and re-exported by `config/skybridge.ts`, which keeps
// the desktop implementation (TOML at 0600, whole-file atomic rewrite, never
// logged, never backed up). A phone will hold the same fields somewhere quite
// different (N2: SecureStore, per D16).
//
// What each section means when MISSING is part of the contract, not an
// implementation detail: no `[server]` means "not configured at all", no
// `[auth]` means "logged out but still configured", and a `[device]` outlives
// a logout so logging back in reuses the registration instead of leaving a
// dead device behind on every login.

export interface SkybridgeServerSection {
  url: string;
  /** The plaintext-http breaker (§3.7). Only ever set by an explicit opt-in. */
  allow_insecure_http?: boolean;
}

export interface SkybridgeAuthSection {
  user_id: string;
  email: string;
  token: string;
  refresh_token?: string;
  /** Access-token expiry, Unix ms. Absent on a server that does not issue one. */
  expires_at?: number;
}

export interface SkybridgeDeviceSection {
  id: string;
  name: string;
}

export interface SkybridgeWorkspaceSection {
  id: string;
}

export interface SkybridgeCredentials {
  server: SkybridgeServerSection;
  auth?: SkybridgeAuthSection;
  device?: SkybridgeDeviceSection;
  workspace?: SkybridgeWorkspaceSection;
}

/** Everything but the secrets — what a status route, a log line or `config-show` may see. */
export interface PublicSkybridgeCredentials {
  server_url: string;
  allow_insecure_http: boolean;
  user_id: string | null;
  email: string | null;
  has_token: boolean;
  has_refresh_token: boolean;
  expires_at: number | null;
  device_id: string | null;
  device_name: string | null;
  workspace_id: string | null;
}

/**
 * Credentials moved aside, and the two ways to end that.
 *
 * Both the login installer and `unbind` need the same guarantee: they are
 * about to write (or delete) credentials as part of a longer sequence that can
 * still fail, and storage must never be left holding credentials that no
 * longer describe anything. Moving aside is the only move that gives that —
 * a copy could be interrupted halfway.
 */
export interface CredentialStash {
  /** True when there was something to move aside. */
  existed: boolean;
  /** Put it back, discarding whatever the failed sequence wrote. */
  restore(): void;
  /** The sequence committed — drop the old copy. */
  discard(): void;
}

export interface CredentialStore {
  /** `null` = nothing to speak of: absent, or present but naming no server. */
  read(): SkybridgeCredentials | null;
  /** Replace wholesale. Never a merge — the caller holds the complete truth. */
  write(credentials: SkybridgeCredentials): void;
  /** Remove. `false` = there was nothing to remove. */
  delete(): boolean;
  stash(): CredentialStash;
}
