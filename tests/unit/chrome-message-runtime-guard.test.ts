import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  chromeMessageAdapter,
  isExtensionContextInvalidatedError,
  isRuntimeContextAvailable,
} from '@/core/chrome-message';

describe('chrome message runtime guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns false when runtime id getter throws', () => {
    const runtime = {} as Record<string, unknown>;
    Object.defineProperty(runtime, 'id', {
      get() {
        throw new Error('Extension context invalidated.');
      },
    });

    vi.stubGlobal('chrome', { runtime });

    expect(isRuntimeContextAvailable()).toBe(false);
  });

  it('rejects sendMessage when lastError getter throws instead of bubbling uncaught', async () => {
    const runtime: Record<string, unknown> = {
      id: 'test-extension-id',
      sendMessage: vi.fn((_message: unknown, callback: (response: unknown) => void) => {
        callback({ status: 'ok' });
      }),
    };

    Object.defineProperty(runtime, 'lastError', {
      get() {
        throw new Error('Extension context invalidated.');
      },
    });

    vi.stubGlobal('chrome', { runtime });

    await expect(
      chromeMessageAdapter.sendMessage({
        type: 'getSettings',
      } as any)
    ).rejects.toThrow('Extension context invalidated.');
  });

  it('treats closed async response channels as stale runtime errors', () => {
    expect(
      isExtensionContextInvalidatedError(
        new Error(
          'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'
        )
      )
    ).toBe(true);
  });
});
