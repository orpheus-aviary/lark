// Acceptance-only observation points (M4 T6).
//
// Registered ONLY when `ctx.acceptance.debugRoutes` is on, which only
// `testing/boot-child.ts` can ask for. Deliberately absent from
// `GET /api/capabilities`: this is not API surface, it is a window into the
// media criterion's stream accounting, and `system.test.ts` asserts a normal
// boot answers 404 here.

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ok } from '../response.js';
import { audioStreamCount } from './media.js';

export const DEBUG_AUDIO_STREAMS_PATH = '/debug/audio-streams';

export function registerDebugRoutes(app: FastifyInstance, _ctx: AppContext): void {
  app.get(DEBUG_AUDIO_STREAMS_PATH, async (_req, reply) => {
    ok(reply, { open_audio_streams: audioStreamCount() });
  });
}
