// "Which model does THIS install talk to?" (N4e, §2.2)
//
// Three DEVICE settings (N7a): per-install preferences, never facts about any
// library, so they stay out of `sync_changes` (decision h) and — since N7,
// where one phone holds several libraries — out of the libraries themselves.
// A phone on a train and a laptop on a desk legitimately point at different
// endpoints; two accounts on one phone do not. The desktop has always kept the
// same three in `lark_config.toml`'s `[llm]`, a device file.
//
// WHAT IS NOT HERE IS THE POINT: `api_key`. The other three are settings; the
// key is a secret, and on this host it lives in SecureStore
// (`apps/mobile/src/settings/llm.ts`), which is also the one store that does
// not come back from a backup. That asymmetry is D16's mechanism and it is
// also, incidentally, why a restored phone shows an endpoint with no key
// (§1.7, decision g) — a state this module cannot see and must not try to fix.
//
// THE VALUE SET IS NARROWER THAN THE DESKTOP'S, deliberately (decision a).
// `@lark/shared`'s `LLM_API_FORMATS` has three members and the third is `''`,
// meaning "follow aviary's shared config". There is no `aviary_config.toml` on
// a phone and no `resolveLlmConfig` fallback chain to read it with, so `''`
// here would be a word for a thing that does not exist. `chatCompletion`
// already treats everything that is not `anthropic` as OpenAI, so nothing
// behaves differently — what changes is that the stored value is always one of
// two concrete protocols instead of sometimes being a deferral to nowhere.
//
// The read path never writes. A value we cannot parse belongs to another build
// of this install, not to us.

import type { StructuredLogger } from './logger.js';
import type { DeviceSettingsPort } from './ports/device-settings.js';

export const LLM_URL_KEY = 'llm_url';
export const LLM_MODEL_KEY = 'llm_model';
export const LLM_API_FORMAT_KEY = 'llm_api_format';

/** The closed domain on this host — see the header for why `''` is absent. */
export const LOCAL_LLM_API_FORMATS = ['openai', 'anthropic'] as const;

export type LocalLlmApiFormat = (typeof LOCAL_LLM_API_FORMATS)[number];

/**
 * What an install that has never been asked speaks.
 *
 * Concrete, unlike the desktop's `''`, and for the opposite reason: the
 * desktop needs "absent on disk" to stay distinguishable so deepMerge cannot
 * mask an aviary value. Nothing falls back to anything here, so a default that
 * means "unset" would only be a second spelling of `openai`.
 */
export const DEFAULT_LLM_API_FORMAT: LocalLlmApiFormat = 'openai';

/**
 * The non-secret half of an `LlmConfig`: where to call, what to ask for, and
 * which protocol to speak. Assignable to `LlmConfig` once a key is added —
 * that join is the host's job (`settings/llm.ts`), because only the host knows
 * where its secrets live.
 */
export interface LlmEndpoint {
  url: string;
  model: string;
  api_format: LocalLlmApiFormat;
}

const isApiFormat = (value: unknown): value is LocalLlmApiFormat =>
  LOCAL_LLM_API_FORMATS.some((format) => format === value);

/**
 * What this install has been told to call, or the empty endpoint.
 *
 * One statement for three keys: they are one setting, and reading them
 * separately would let a caller act on a url from before a save and a model
 * from after it.
 *
 * A missing value is the default and says nothing. A value out of domain is
 * warned about and read as the default — and what is stored is left exactly as
 * it was, because a read path that "fixes" what it cannot parse is how a
 * downgrade eats a setting.
 */
export function readLlmEndpoint(
  settings: DeviceSettingsPort,
  logger?: StructuredLogger,
): LlmEndpoint {
  const format = settings.get(LLM_API_FORMAT_KEY);
  if (format !== undefined && !isApiFormat(format)) {
    logger?.warn(
      { key: LLM_API_FORMAT_KEY, stored: format },
      `${LLM_API_FORMAT_KEY} is not a format this build knows — reading it as '${DEFAULT_LLM_API_FORMAT}'`,
    );
  }

  return {
    url: settings.get(LLM_URL_KEY) ?? '',
    model: settings.get(LLM_MODEL_KEY) ?? '',
    api_format: isApiFormat(format) ? format : DEFAULT_LLM_API_FORMAT,
  };
}

/**
 * Store all three, or none of them.
 *
 * One `set` and not three, which is the port's all-or-nothing promise: half a
 * saved endpoint is a new url pointed at an old model, which is a
 * configuration nobody typed and which fails in a way that looks like the
 * provider's fault.
 *
 * `url` and `model` are trimmed on the way in. A phone keyboard adds a
 * trailing space to a pasted URL often enough that this is not defensive
 * programming, and `model` in particular reaches the request body verbatim —
 * `chatCompletion` trims the url and nothing else.
 */
export function writeLlmEndpoint(
  settings: DeviceSettingsPort,
  endpoint: LlmEndpoint,
): Promise<void> {
  return settings.set({
    [LLM_URL_KEY]: endpoint.url.trim(),
    [LLM_MODEL_KEY]: endpoint.model.trim(),
    [LLM_API_FORMAT_KEY]: endpoint.api_format,
  });
}
