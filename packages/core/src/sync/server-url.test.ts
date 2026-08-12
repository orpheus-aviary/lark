import { describe, expect, it } from 'vitest';
import { SyncInsecureUrlError } from '../errors.js';
import { isLoopbackHost, normalizeSyncServerUrl } from './server-url.js';

describe('normalizeSyncServerUrl', () => {
  it('accepts https and canonicalises it', () => {
    expect(normalizeSyncServerUrl('https://sync.example.test/')).toBe('https://sync.example.test');
    expect(normalizeSyncServerUrl('  https://sync.example.test  ')).toBe(
      'https://sync.example.test',
    );
    expect(normalizeSyncServerUrl('https://SYNC.example.test:8443')).toBe(
      'https://sync.example.test:8443',
    );
  });

  it('keeps a sub-path deployment, because the client appends /v1 to it', () => {
    expect(normalizeSyncServerUrl('https://host.test/skybridge/')).toBe(
      'https://host.test/skybridge',
    );
  });

  it('drops query and fragment — a base URL has no use for either', () => {
    expect(normalizeSyncServerUrl('https://host.test/?a=1#x')).toBe('https://host.test');
  });

  it.each(['http://localhost:47200', 'http://127.0.0.1:47200', 'http://[::1]:47200'])(
    'allows plaintext on loopback (%s)',
    (url) => {
      expect(() => normalizeSyncServerUrl(url)).not.toThrow();
    },
  );

  it('refuses plaintext http off-loopback by default', () => {
    expect(() => normalizeSyncServerUrl('http://sync.example.test')).toThrow(SyncInsecureUrlError);
  });

  it('accepts plaintext http only with the explicit breaker', () => {
    expect(normalizeSyncServerUrl('http://sync.example.test', { allowInsecureHttp: true })).toBe(
      'http://sync.example.test',
    );
  });

  it('fails closed on a scheme it does not speak', () => {
    for (const url of ['ftp://host.test', 'file:///etc/passwd', 'ws://host.test']) {
      expect(() => normalizeSyncServerUrl(url, { allowInsecureHttp: true })).toThrow(
        SyncInsecureUrlError,
      );
    }
  });

  it('fails closed on something that is not a URL at all', () => {
    expect(() => normalizeSyncServerUrl('sync.example.test')).toThrow(SyncInsecureUrlError);
    expect(() => normalizeSyncServerUrl('')).toThrow(SyncInsecureUrlError);
  });

  it('knows a loopback host from one that merely looks like it', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('dev.localhost')).toBe(true);
    // The classic homograph: a public host whose NAME contains localhost.
    expect(isLoopbackHost('localhost.evil.test')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.test')).toBe(false);
  });
});
