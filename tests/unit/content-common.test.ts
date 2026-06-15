import { afterEach, describe, expect, it, vi } from 'vitest';

describe('content common settings loading', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    delete window.saySoSettings;
  });

  it('silently falls back to defaults when extension context is invalidated during settings load', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension-id',
        sendMessage: vi.fn((_message: unknown, callback: (response: unknown) => void) => {
          callback({ status: 'ok' });
        }),
      },
    });

    Object.defineProperty(chrome.runtime, 'lastError', {
      configurable: true,
      get() {
        throw new Error('Extension context invalidated.');
      },
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { getCurrentSettings, loadSettingsFromStorage } = await import('@/content/common');

    await loadSettingsFromStorage();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(getCurrentSettings()).toMatchObject({
      autoSave: true,
      webCapture: {
        enabled: true,
        highlightEnabled: true,
        dwellEnabled: true,
      },
    });
  });
});
