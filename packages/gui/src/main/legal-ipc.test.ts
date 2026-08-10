import { describe, expect, it, vi } from 'vitest';
import { readLegalDocument } from './legal-ipc.js';

const DEPS = { resourcesPath: '/App/Contents/Resources', devRoot: '/repo' };

/** Only the listed paths exist; everything else rejects like a missing file. */
const onDisk = (files: Record<string, string>) =>
  vi.fn((path: string) =>
    path in files ? Promise.resolve(files[path]) : Promise.reject(new Error('ENOENT')),
  );

describe('readLegalDocument', () => {
  it('reads the copy inside the app bundle', async () => {
    const read = onDisk({ '/App/Contents/Resources/LICENSE': 'MIT License' });
    expect(await readLegalDocument('license', { ...DEPS, readFileImpl: read })).toBe('MIT License');
  });

  it('reads the notices from the bundle too', async () => {
    const read = onDisk({ '/App/Contents/Resources/THIRD-PARTY-NOTICES.md': '# 第三方软件声明' });
    expect(await readLegalDocument('notices', { ...DEPS, readFileImpl: read })).toBe(
      '# 第三方软件声明',
    );
  });

  // A dev run has no packaged Resources; the staging copy is the honest answer
  // to "what would ship", rather than pretending a build happened.
  it('falls back to the repo in a dev checkout', async () => {
    const read = onDisk({
      '/repo/packages/gui/release/staging/bundled/THIRD-PARTY-NOTICES.md': 'staged',
    });
    expect(await readLegalDocument('notices', { ...DEPS, readFileImpl: read })).toBe('staged');
  });

  // Missing is an answer, not an exception: a checkout that never ran
  // gen-notices genuinely has none, and the settings page says so.
  it('answers null when neither copy is there', async () => {
    expect(await readLegalDocument('notices', { ...DEPS, readFileImpl: onDisk({}) })).toBeNull();
  });

  it('prefers the bundle over the repo when both exist', async () => {
    const read = onDisk({
      '/App/Contents/Resources/LICENSE': 'shipped',
      '/repo/LICENSE': 'source',
    });
    expect(await readLegalDocument('license', { ...DEPS, readFileImpl: read })).toBe('shipped');
  });
});
