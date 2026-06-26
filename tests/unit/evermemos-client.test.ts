import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EverMemOSClient,
  EverMemOSClientError,
  isEverMemOSUnavailableError,
} from '@/background/evermemos-client';

function createAbortError(message = 'The operation was aborted.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

describe('EverMemOSClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns disconnected status with lastError when health request times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw createAbortError();
      })
    );

    const client = new EverMemOSClient('http://127.0.0.1:1996');
    const status = await client.checkStatus();

    expect(status).toEqual({
      connected: false,
      baseUrl: 'http://127.0.0.1:1996',
      lastError: 'Request timeout',
      version: undefined,
    });
  });

  it('returns fallback browser sync status instead of throwing on timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw createAbortError();
      })
    );

    const client = new EverMemOSClient('http://127.0.0.1:1996');
    const status = await client.getBrowserSyncStatus();

    expect(status).toEqual({
      running: false,
      last_error: 'Request timeout',
      pending_conversations: 0,
      pending_snippets: 0,
      in_progress_conversations: 0,
      in_progress_snippets: 0,
      imported_conversations: 0,
      imported_snippets: 0,
    });
  });

  it('returns fallback browser sync status instead of throwing when server is offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const client = new EverMemOSClient('http://127.0.0.1:1996');
    const status = await client.getBrowserSyncStatus();

    expect(status).toEqual({
      running: false,
      last_error: 'Failed to fetch',
      pending_conversations: 0,
      pending_snippets: 0,
      in_progress_conversations: 0,
      in_progress_snippets: 0,
      imported_conversations: 0,
      imported_snippets: 0,
    });
  });

  it('classifies EverMemOS network failures as service-unavailable errors', () => {
    expect(
      isEverMemOSUnavailableError(new EverMemOSClientError('Failed to fetch', { code: 'network' }))
    ).toBe(true);
    expect(
      isEverMemOSUnavailableError(
        new EverMemOSClientError('EverMemOS request failed with status 500', { status: 500 })
      )
    ).toBe(false);
  });

  it('returns browser sync status payload on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            status: 'ok',
            result: {
              status: {
                running: true,
                pending_conversations: 2,
                pending_snippets: 1,
                in_progress_conversations: 1,
                in_progress_snippets: 0,
                imported_conversations: 12,
                imported_snippets: 8,
                last_success_at: '2026-04-11T10:00:00.000Z',
              },
            },
          }),
          { status: 200 }
        );
      })
    );

    const client = new EverMemOSClient('http://127.0.0.1:1996');
    const status = await client.getBrowserSyncStatus();

    expect(status).toMatchObject({
      running: true,
      pending_conversations: 2,
      pending_snippets: 1,
      in_progress_conversations: 1,
      imported_conversations: 12,
      imported_snippets: 8,
      last_success_at: '2026-04-11T10:00:00.000Z',
    });
  });
});
