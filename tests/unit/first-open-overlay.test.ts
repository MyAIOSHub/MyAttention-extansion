import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIRST_OPEN_WELCOME_PENDING_KEY } from '@/core/first-open';
import { initializeFirstOpenOverlay } from '@/popup/first-open-overlay';

function installChromeStorageMock(pending: boolean) {
  const local = {
    get: vi.fn((_keys: string[], callback: (result: Record<string, boolean>) => void) => {
      callback({ [FIRST_OPEN_WELCOME_PENDING_KEY]: pending });
    }),
    set: vi.fn((payload: Record<string, boolean>, callback?: () => void) => {
      callback?.();
      return payload;
    }),
  };

  (globalThis as any).chrome = {
    storage: {
      local,
    },
  };

  return local;
}

describe('first open overlay', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="first-open-overlay" hidden aria-hidden="true">
        <button id="first-open-overlay-close" type="button">x</button>
      </div>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete (globalThis as any).chrome;
    vi.restoreAllMocks();
  });

  it('shows overlay when install flag is pending', async () => {
    installChromeStorageMock(true);

    await initializeFirstOpenOverlay(document);

    const overlay = document.getElementById('first-open-overlay');
    expect(overlay?.hidden).toBe(false);
    expect(overlay?.getAttribute('aria-hidden')).toBe('false');
  });

  it('hides overlay and clears install flag when user closes it', async () => {
    const local = installChromeStorageMock(true);

    await initializeFirstOpenOverlay(document);

    const overlay = document.getElementById('first-open-overlay') as HTMLElement;
    const closeButton = document.getElementById('first-open-overlay-close') as HTMLButtonElement;
    closeButton.focus();
    closeButton.click();

    expect(overlay.hidden).toBe(true);
    expect(document.activeElement).not.toBe(closeButton);
    expect(local.set).toHaveBeenCalledWith(
      { [FIRST_OPEN_WELCOME_PENDING_KEY]: false },
      expect.any(Function)
    );
  });

  it('keeps overlay hidden when install flag is absent', async () => {
    installChromeStorageMock(false);

    await initializeFirstOpenOverlay(document);

    const overlay = document.getElementById('first-open-overlay');
    expect(overlay?.hidden).toBe(true);
    expect(overlay?.getAttribute('aria-hidden')).toBe('true');
  });
});
