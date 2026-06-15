import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchWithTimeout,
  FetchTimeoutError,
  normalizeErrorMessage,
} from '../../src/core/http';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeErrorMessage', () => {
  it('returns a string error as-is', () => {
    expect(normalizeErrorMessage('boom')).toBe('boom');
  });
  it('prefers a non-empty .message', () => {
    expect(normalizeErrorMessage(new Error('nope'))).toBe('nope');
    expect(normalizeErrorMessage({ message: '  ' })).not.toBe('  ');
  });
  it('uses .detail only when includeDetail is set', () => {
    const e = { message: '', detail: 'detailed' };
    expect(normalizeErrorMessage(e)).toBe(JSON.stringify(e));
    expect(normalizeErrorMessage(e, { includeDetail: true })).toBe('detailed');
  });
  it('falls back to JSON then String', () => {
    expect(normalizeErrorMessage({ a: 1 })).toBe('{"a":1}');
    expect(normalizeErrorMessage(42)).toBe('42');
  });
});

describe('fetchWithTimeout', () => {
  it('returns the response on success', async () => {
    const res = new Response('ok');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
    await expect(fetchWithTimeout('https://x/', { method: 'GET' }, 1000)).resolves.toBe(res);
  });

  it('maps an AbortError to FetchTimeoutError', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    await expect(fetchWithTimeout('https://x/', {}, 500)).rejects.toBeInstanceOf(FetchTimeoutError);
  });

  it('rethrows non-abort network errors unchanged', async () => {
    const neterr = new Error('network down');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(neterr));
    await expect(fetchWithTimeout('https://x/', {}, 500)).rejects.toBe(neterr);
  });

  it('passes an abort signal into fetch init', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', spy);
    await fetchWithTimeout('https://x/', { method: 'POST' }, 1000);
    const init = spy.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe('POST');
  });
});
