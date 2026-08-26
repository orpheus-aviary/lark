// The whole of this device's LLM configuration, in one place (N4e-1).
//
// It is assembled from TWO stores and that is not an accident of history: the
// endpoint (url / model / api_format) is a setting and lives in the library
// (`@lark/core/portable`'s `llm-config.ts`); the key is a secret and lives in
// SecureStore, beside the install identity and for the same reason — it is the
// one store on this phone that does not come back from a backup (N0b-5a).
//
// 🔒 ONE CHANNEL, and it is this file (§0). There is no aviary shared config
// to fall back to, nothing is imported from the desktop, and none of it enters
// `sync_changes`. If a future reader is looking for "where else could a model
// come from" — nowhere, by decision.
//
// READS ARE SYNCHRONOUS ALL THE WAY DOWN, which is what makes
// `DownloadEngineOptions.getLlmConfig` (`() => LlmConfig`, no Promise)
// satisfiable at all: `SecureStore.getItem` is sync, and the boot sequence has
// relied on that since N2c. Every read is a Keystore round trip, and there is
// deliberately NO cache: the engine reads once per task and a screen reads once
// per render of a form nobody is scrolling, while a cache would make "I just
// changed it and the add page still disagrees" a new class of bug (§1.2).

import {
  DEFAULT_TIMEOUTS,
  type DeviceSettingsPort,
  type LlmEndpoint,
  type StructuredLogger,
  chatCompletion,
  isLlmConfigured,
  readLlmEndpoint,
  writeLlmEndpoint,
} from '@lark/core/portable';
import type { LlmConfig } from '@lark/shared';
import { deleteItemAsync, getItem, setItem } from 'expo-secure-store';

const API_KEY = 'lark.llm.api_key';

/**
 * No biometric prompt, same as the identity keys: the engine reads this on a
 * background thread while the screen is off, and a fingerprint dialog there is
 * a download that never starts.
 */
const OPTIONS = { requireAuthentication: false } as const;

/** The key this install holds, or `''` — a local endpoint legitimately has none. */
export function readApiKey(): string {
  return getItem(API_KEY, OPTIONS) ?? '';
}

/** Endpoint + key, in the shape `chatCompletion` and the engine both take. */
export function readLlmConfig(settings: DeviceSettingsPort, logger?: StructuredLogger): LlmConfig {
  return { ...readLlmEndpoint(settings, logger), api_key: readApiKey() };
}

/** Is there enough here to call anything? url + model, never the key. */
export function hasLlmConfig(settings: DeviceSettingsPort): boolean {
  return isLlmConfigured(readLlmConfig(settings));
}

/** Save the three device-held fields. The key is saved separately, below. */
export function saveLlmEndpoint(
  settings: DeviceSettingsPort,
  endpoint: LlmEndpoint,
): Promise<void> {
  return writeLlmEndpoint(settings, endpoint);
}

/**
 * Replace the key.
 *
 * Separate from `saveLlmEndpoint`, and separate from `clearApiKey`, because
 * the settings page never echoes what is stored (§2.3): an empty key field
 * means "leave it alone", and only the 清除 button means "remove it". Two
 * named functions put that distinction at the call site rather than inside a
 * branch on the empty string.
 */
export function saveApiKey(key: string): void {
  setItem(API_KEY, key.trim(), OPTIONS);
}

/** 「清除」. Async because SecureStore offers no synchronous delete. */
export async function clearApiKey(): Promise<void> {
  await deleteItemAsync(API_KEY, OPTIONS);
}

/**
 * What one press of 「测试连接」 found out.
 *
 * `reply` exists so the answer is evidence rather than a claim — a gateway
 * that returns 200 with somebody else's model still fails the thing the user
 * is actually checking, and seeing the words back is the cheapest way to
 * notice.
 */
export type LlmTestResult = { ok: true; reply: string } | { ok: false; message: string };

/** Two sentences, because the answer is thrown away. */
const TEST_SYSTEM = 'You are a connectivity probe. Reply with one short word.';
const TEST_USER = 'ping';

/** Enough of the reply to recognise, not enough to fill the screen. */
const REPLY_MAX = 80;

/**
 * One minimal completion against the config in the form (decision f — the
 * DRAFT, not what is stored, so "try it before you keep it" is possible).
 *
 * The deadline is the same one a real naming call gets rather than something
 * shorter: a test that gives up sooner than the thing it is predicting can
 * report a failure the product would not have had, and this button exists to
 * be believed (§6, first row).
 *
 * `max_tokens` is not ours to set — `chatCompletion` fixes it — so the prompt
 * does the work instead. It costs a handful of tokens either way.
 *
 * Never throws: every outcome is something to put on the screen.
 */
export async function testLlm(config: LlmConfig, signal?: AbortSignal): Promise<LlmTestResult> {
  if (!isLlmConfigured(config)) {
    return { ok: false, message: '接口地址和模型都要填。' };
  }
  try {
    const reply = await chatCompletion(config, TEST_SYSTEM, TEST_USER, {
      timeoutMs: DEFAULT_TIMEOUTS.llm,
      ...(signal === undefined ? {} : { signal }),
    });
    return { ok: true, reply: reply.trim().slice(0, REPLY_MAX) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
