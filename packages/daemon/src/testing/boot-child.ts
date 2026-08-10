// Test-only daemon entry point (M2-17).
//
// Lifecycle behaviour — PID contention, signal handling, real exit codes —
// cannot be observed from inside the process that owns it: `process.exit` ends
// the test runner too. So the integration tests spawn THIS module, built into
// `dist`, against a temporary `LARK_NEST_DIR`.
//
// Every test-only knob is read here and passed to `boot()` as an option, so
// `boot.ts` itself has no test-only env surface and the production path cannot
// be reconfigured by a stray variable.

import { boot } from '../boot.js';

function readIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * The acceptance harness (`just accept-gui`) runs a REAL daemon with two extra
 * seams: paced `/audio` writes so a seek can land on unbuffered bytes, and a
 * debug route that reports the open stream count. Both are absent unless asked
 * for here — the shipped CLI has no way to enable them.
 */
const audioThrottleBytesPerSec = readIntEnv('LARK_ACCEPT_AUDIO_THROTTLE_BPS');
const debugRoutes = process.env.LARK_ACCEPT_DEBUG_ROUTES === '1';
const acceptance =
  audioThrottleBytesPerSec === undefined && !debugRoutes
    ? undefined
    : {
        ...(audioThrottleBytesPerSec === undefined ? {} : { audioThrottleBytesPerSec }),
        ...(debugRoutes ? { debugRoutes } : {}),
      };

/**
 * Where the media toolchain is looked for (M7-18).
 *
 * accept-pack has to observe the `missing` and `incompatible` states on a
 * REAL packaged app, and the only honest way to produce them is to point the
 * search somewhere empty. Doing that by moving the user's actual Homebrew
 * install would be an acceptance script editing the machine it is measuring;
 * doing it with an env var the shipped daemon reads would put a "pretend you
 * have no ffmpeg" switch in a release build. So it lands here, like every
 * other knob: a colon-separated search path, honoured only by this module.
 */
const homebrewDirs = process.env.LARK_TEST_MEDIA_TOOL_DIRS?.split(':').filter((d) => d !== '');
const mediaTools =
  homebrewDirs === undefined
    ? undefined
    : // An empty list is meaningful: "look nowhere". `PATH` is still consulted
      // by the resolver's last level, which is why the harness also clears it.
      { resolve: { homebrewDirs } };

// Port 0 = ephemeral: parallel test files must not fight over 47100. The real
// port is parsed from the listen line boot prints on stdout. The acceptance
// harness passes 47100 explicitly — the renderer's CSP names that port.
await boot({
  port: readIntEnv('LARK_DAEMON_TEST_PORT') ?? 0,
  stallBeforeListenMs: readIntEnv('LARK_TEST_STALL_BEFORE_LISTEN_MS'),
  fatalAfterMs: readIntEnv('LARK_TEST_FATAL_AFTER_MS'),
  ...(acceptance === undefined ? {} : { acceptance }),
  ...(mediaTools === undefined ? {} : { mediaTools }),
});
