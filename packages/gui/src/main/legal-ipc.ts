// The licence texts that ship inside the app (M7-9, G3).
//
// Delivering them is not optional — the renderer bundle keeps no @license
// comments and the packaging glob drops *.md, so `Resources/LICENSE` and
// `Resources/THIRD-PARTY-NOTICES.md` are the only copies a user ever gets. A
// file nobody can open from inside the app is a file nobody reads, hence this
// channel and the settings-page entry that uses it.
//
// READ-ONLY and PARAMETERLESS on purpose: the renderer names a document from a
// closed set, never a path. An IPC that takes a filename from the renderer is
// an arbitrary-file-read primitive one bug away from mattering.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LegalDocument, LegalDocuments } from '../shared/lark-api.js';

export interface LegalDeps {
  /** `process.resourcesPath` in a packaged app. */
  resourcesPath: string;
  /** Repo root, for a dev run — where the same two files live untracked. */
  devRoot: string;
  readFileImpl?: (path: string) => Promise<string>;
}

const FILES: Record<LegalDocument, { packaged: string; dev: string }> = {
  license: { packaged: 'LICENSE', dev: 'LICENSE' },
  notices: {
    packaged: 'THIRD-PARTY-NOTICES.md',
    // Dev has no packaged Resources. The staging copy is whatever
    // `gen-notices.mjs` produced last, which is the honest answer to "what
    // would ship" without pretending a build happened.
    dev: 'packages/gui/release/staging/bundled/THIRD-PARTY-NOTICES.md',
  },
};

/**
 * Read one of the two documents.
 *
 * Missing is an ANSWER, not an error: a dev checkout that has never run
 * `gen-notices` genuinely has no notices, and the settings page says so rather
 * than showing an exception.
 */
export async function readLegalDocument(
  document: LegalDocument,
  deps: LegalDeps,
): Promise<string | null> {
  const read = deps.readFileImpl ?? ((path: string) => readFile(path, 'utf8'));
  const entry = FILES[document];
  const candidates = [join(deps.resourcesPath, entry.packaged), join(deps.devRoot, entry.dev)];
  for (const path of candidates) {
    try {
      return await read(path);
    } catch {
      // Next candidate. Both missing is reported as `null` below.
    }
  }
  return null;
}

export function legalDocuments(deps: LegalDeps): LegalDocuments {
  return {
    license: () => readLegalDocument('license', deps),
    notices: () => readLegalDocument('notices', deps),
  };
}
