export interface SelectionTranslationToolbarOptions {
  root?: Document;
  onTranslate: (text: string) => Promise<string>;
  onExplain?: (text: string) => Promise<string>;
  onSpeak?: (text: string) => void | Promise<void>;
}

export interface SelectionTranslationToolbar {
  start: () => void;
  stop: () => void;
}

const TOOLBAR_CLASS = 'sayso-selection-translation-toolbar';
const BUTTON_CLASS = 'sayso-selection-translation-button';
const ACTION_BUTTON_CLASS = 'sayso-selection-action-button';
const RESULT_CLASS = 'sayso-selection-translation-result';

function normalizeSelectionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function getSelectedText(root: Document): string {
  return normalizeSelectionText(root.getSelection()?.toString() ?? '');
}

function selectionIntersectsToolbar(root: Document): boolean {
  const selection = root.getSelection();
  const toolbar = root.querySelector(`.${TOOLBAR_CLASS}`);
  if (selection == null || toolbar == null || selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  return toolbar.contains(range.commonAncestorContainer);
}

function getSelectionPosition(root: Document): { top: number; left: number } {
  const selection = root.getSelection();
  if (selection == null || selection.rangeCount === 0) {
    return { top: 12, left: 12 };
  }

  const range = selection.getRangeAt(0);
  const rect = typeof range.getBoundingClientRect === 'function'
    ? range.getBoundingClientRect()
    : null;
  const view = root.defaultView;
  const scrollX = view?.scrollX ?? 0;
  const scrollY = view?.scrollY ?? 0;
  const top = rect?.top ?? 12;
  const left = rect?.left ?? 12;

  return {
    top: Math.max(8, top + scrollY - 42),
    left: Math.max(8, left + scrollX),
  };
}

function applyToolbarStyles(toolbar: HTMLElement, top: number, left: number): void {
  toolbar.style.cssText = [
    'position: absolute',
    `top: ${top}px`,
    `left: ${left}px`,
    'z-index: 2147483647',
    'display: flex',
    'align-items: stretch',
    'gap: 6px',
    'max-width: min(360px, calc(100vw - 16px))',
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    'font-size: 13px',
  ].join('; ');
}

function createActionButton(
  root: Document,
  action: 'translate' | 'explain' | 'speak',
  label: string,
  title: string,
  primary = false
): HTMLButtonElement {
  const button = root.createElement('button');
  button.className = primary ? `${ACTION_BUTTON_CLASS} ${BUTTON_CLASS}` : ACTION_BUTTON_CLASS;
  button.type = 'button';
  button.textContent = label;
  button.title = title;
  button.setAttribute('data-selection-action', action);
  button.style.cssText = [
    'min-width: 34px',
    'height: 34px',
    'border: 0',
    'border-radius: 8px',
    primary ? 'background: #5e6ad2' : 'background: white',
    primary ? 'color: white' : 'color: #111827',
    'font-weight: 700',
    'box-shadow: 0 8px 24px rgba(17, 24, 39, 0.18)',
    'cursor: pointer',
  ].join('; ');
  return button;
}

function createToolbarElement(root: Document, selectedText: string): HTMLElement {
  const toolbar = root.createElement('div');
  toolbar.className = TOOLBAR_CLASS;
  toolbar.setAttribute('data-sayso-selection-text', selectedText);

  toolbar.appendChild(createActionButton(root, 'translate', '译', '翻译选中文字', true));
  toolbar.appendChild(createActionButton(root, 'explain', '解', '解释选中文字'));
  toolbar.appendChild(createActionButton(root, 'speak', '读', '朗读选中文字'));
  return toolbar;
}

function renderResult(root: Document, toolbar: HTMLElement, text: string): HTMLElement {
  let result = toolbar.querySelector<HTMLElement>(`.${RESULT_CLASS}`);
  if (!result) {
    result = root.createElement('div');
    result.className = RESULT_CLASS;
    result.style.cssText = [
      'max-width: 280px',
      'padding: 8px 10px',
      'border-radius: 8px',
      'background: white',
      'color: #111827',
      'box-shadow: 0 8px 24px rgba(17, 24, 39, 0.18)',
      'line-height: 1.45',
    ].join('; ');
    toolbar.appendChild(result);
  }
  result.textContent = text;
  return result;
}

export function createSelectionTranslationToolbar(
  options: SelectionTranslationToolbarOptions
): SelectionTranslationToolbar {
  const root = options.root ?? document;
  let toolbar: HTMLElement | null = null;

  const hide = (): void => {
    toolbar?.remove();
    toolbar = null;
  };

  const show = (): void => {
    if (selectionIntersectsToolbar(root)) {
      return;
    }

    const selectedText = getSelectedText(root);
    if (!selectedText) {
      hide();
      return;
    }

    hide();
    toolbar = createToolbarElement(root, selectedText);
    const position = getSelectionPosition(root);
    applyToolbarStyles(toolbar, position.top, position.left);

    toolbar.querySelectorAll<HTMLButtonElement>('[data-selection-action]').forEach((button) => {
      button.addEventListener('click', (): void => {
        void (async (): Promise<void> => {
          const text = toolbar?.getAttribute('data-sayso-selection-text') ?? selectedText;
          const action = button.getAttribute('data-selection-action');
          if (toolbar == null || !text) {
            return;
          }

          try {
            if (action === 'translate') {
              renderResult(root, toolbar, '翻译中...');
              const translated = await options.onTranslate(text);
              renderResult(root, toolbar, translated);
              return;
            }

            if (action === 'explain' && options.onExplain) {
              renderResult(root, toolbar, '解释中...');
              const explanation = await options.onExplain(text);
              renderResult(root, toolbar, explanation);
              return;
            }

            if (action === 'speak' && options.onSpeak) {
              await options.onSpeak(text);
            }
          } catch (error) {
            renderResult(root, toolbar, error instanceof Error ? error.message : String(error));
          }
        })();
      });
    });

    root.body.appendChild(toolbar);
  };

  const handleSelectionChange = (event: Event): void => {
    const target = event.target as Node | null;
    if (target != null && toolbar != null && toolbar.contains(target)) {
      // Clicks/keys inside the toolbar (e.g. pressing 译/解/读) must not tear it
      // down and rebuild it, or the button's click never lands.
      return;
    }
    show();
  };

  return {
    start: (): void => {
      root.addEventListener('mouseup', handleSelectionChange);
      root.addEventListener('keyup', handleSelectionChange);
    },
    stop: (): void => {
      root.removeEventListener('mouseup', handleSelectionChange);
      root.removeEventListener('keyup', handleSelectionChange);
      hide();
    },
  };
}
