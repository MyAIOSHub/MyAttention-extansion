import { FIRST_OPEN_WELCOME_PENDING_KEY } from '@/core/first-open';

const OVERLAY_ID = 'first-open-overlay';
const CLOSE_BUTTON_ID = 'first-open-overlay-close';
const BOUND_DATASET_KEY = 'firstOpenOverlayBound';

function getOverlayElements(doc: Document): {
  overlay: HTMLElement | null;
  closeButton: HTMLButtonElement | null;
} {
  return {
    overlay: doc.getElementById(OVERLAY_ID),
    closeButton: doc.getElementById(CLOSE_BUTTON_ID) as HTMLButtonElement | null,
  };
}

function setOverlayVisible(overlay: HTMLElement, visible: boolean): void {
  const activeElement = overlay.ownerDocument.activeElement;
  if (!visible && activeElement instanceof HTMLElement && overlay.contains(activeElement)) {
    activeElement.blur();
  }

  overlay.hidden = !visible;
  overlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

async function readOverlayPending(): Promise<boolean> {
  try {
    if (!chrome?.storage?.local?.get) {
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      chrome.storage.local.get([FIRST_OPEN_WELCOME_PENDING_KEY], (result) => {
        resolve(result?.[FIRST_OPEN_WELCOME_PENDING_KEY] === true);
      });
    });
  } catch {
    return false;
  }
}

async function dismissOverlay(): Promise<void> {
  try {
    if (!chrome?.storage?.local?.set) {
      return;
    }

    await new Promise<void>((resolve) => {
      chrome.storage.local.set({ [FIRST_OPEN_WELCOME_PENDING_KEY]: false }, () => {
        resolve();
      });
    });
  } catch {
    // Ignore storage failures. The overlay is still dismissible for the current view.
  }
}

export async function initializeFirstOpenOverlay(doc: Document = document): Promise<void> {
  const { overlay, closeButton } = getOverlayElements(doc);
  if (!overlay || !closeButton) {
    return;
  }

  if (closeButton.dataset[BOUND_DATASET_KEY] !== 'true') {
    closeButton.dataset[BOUND_DATASET_KEY] = 'true';
    closeButton.addEventListener('click', () => {
      setOverlayVisible(overlay, false);
      void dismissOverlay();
    });
  }

  const pending = await readOverlayPending();
  setOverlayVisible(overlay, pending);
}
