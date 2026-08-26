// The settings that belong to the DEVICE rather than to a library (N7a).
//
// Until N7 every per-install preference on the phone lived in
// `local_metadata` — not because a library was the right owner, but because a
// library was the only thing this host could write to. N7 gives one device
// several libraries, and that accident becomes a bug the moment it does: the
// cache limit, the model endpoint and the Bluetooth-lyrics switch would each
// take on a different value depending on which account was active, and
// switching accounts would silently change settings nobody touched (§4).
//
// The desktop has always been layered this way — `storage.cache_limit_mb` and
// `[llm]` live in `lark_config.toml`, a DEVICE file next to the nest, and the
// library holds only what is true about the library. This port is the phone's
// half of that same split; `apps/mobile/src/ports/device-settings.ts` backs it
// with `<nest>/device.json`.
//
// A STRING KV, deliberately, and the same shape `local_metadata` had: an
// unknown key is ignored, a missing key is the default, and a value whose
// MEANING changes gets a new key rather than a reinterpretation of this one.
// Every reader in this directory keeps its own parse and its own fallback, so
// what moved is where the bytes are — not what any of them mean.

/**
 * This device's preferences, as the readers beside this file see them.
 *
 * READS ARE SYNCHRONOUS and writes are not, which is the honest shape of both
 * hosts: a settings form reads at render time and a download engine reads once
 * per task (`() => LlmConfig`, no Promise), while making a write durable means
 * replacing a file. Implementations therefore hold the settings in memory and
 * persist on `set`.
 */
export interface DeviceSettingsPort {
  /** What this device stored for `key`, or `undefined` if it never has. */
  get(key: string): string | undefined;

  /**
   * Store every entry, or none of them.
   *
   * All-or-nothing is load-bearing for `writeLlmEndpoint`, whose three keys
   * are one setting: half a saved endpoint is a new url pointed at an old
   * model, a configuration nobody typed that fails like the provider's fault.
   *
   * Resolves once the value is durable, and rejects when it is not — a
   * settings page that says "saved" over a failed write is worse than one that
   * says what happened.
   */
  set(entries: Readonly<Record<string, string>>): Promise<void>;
}
