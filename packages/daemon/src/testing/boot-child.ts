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

// Port 0 = ephemeral: parallel test files must not fight over 47100. The real
// port is parsed from the listen line boot prints on stdout.
await boot({
  port: readIntEnv('LARK_DAEMON_TEST_PORT') ?? 0,
  stallBeforeListenMs: readIntEnv('LARK_TEST_STALL_BEFORE_LISTEN_MS'),
  fatalAfterMs: readIntEnv('LARK_TEST_FATAL_AFTER_MS'),
});
