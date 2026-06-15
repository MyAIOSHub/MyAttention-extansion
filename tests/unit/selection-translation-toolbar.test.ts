import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSelectionTranslationToolbar } from '@/translation/selection-toolbar';

describe('selection translation toolbar', () => {
  beforeEach(() => {
    document.body.innerHTML = '<p id="source">Translate this sentence.</p>';
    document.getSelection()?.removeAllRanges();
  });

  it('shows a toolbar for selected text and renders the translation result', async () => {
    const source = document.getElementById('source')!;
    const range = document.createRange();
    range.selectNodeContents(source);
    document.getSelection()?.addRange(range);

    const onTranslate = vi.fn().mockResolvedValue('翻译这个句子。');
    const toolbar = createSelectionTranslationToolbar({ onTranslate });

    toolbar.start();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const button = document.querySelector<HTMLButtonElement>('.sayso-selection-translation-button');
    expect(button).not.toBeNull();

    button?.click();

    await vi.waitFor(() => {
      expect(onTranslate).toHaveBeenCalledWith('Translate this sentence.');
      expect(document.querySelector('.sayso-selection-translation-result')?.textContent).toContain(
        '翻译这个句子。'
      );
    });

    toolbar.stop();
    expect(document.querySelector('.sayso-selection-translation-toolbar')).toBeNull();
  });

  it('does not rebuild the toolbar when a mouseup originates inside it', async () => {
    const source = document.getElementById('source')!;
    const range = document.createRange();
    range.selectNodeContents(source);
    document.getSelection()?.addRange(range);

    const toolbar = createSelectionTranslationToolbar({
      onTranslate: vi.fn().mockResolvedValue('x'),
    });

    toolbar.start();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const button = document.querySelector<HTMLButtonElement>(
      '[data-selection-action="translate"]'
    )!;
    expect(button).not.toBeNull();

    // A real click first fires mouseup, which bubbles to the document handler.
    // It must not tear down and rebuild the toolbar, or the click never lands.
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    expect(document.body.contains(button)).toBe(true);

    toolbar.stop();
  });

  it('exposes explain and speak actions for selected text', async () => {
    const source = document.getElementById('source')!;
    const range = document.createRange();
    range.selectNodeContents(source);
    document.getSelection()?.addRange(range);

    const onExplain = vi.fn().mockResolvedValue('A short explanation.');
    const onSpeak = vi.fn();
    const toolbar = createSelectionTranslationToolbar({
      onTranslate: vi.fn().mockResolvedValue(''),
      onExplain,
      onSpeak,
    });

    toolbar.start();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    document.querySelector<HTMLButtonElement>('[data-selection-action="explain"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-selection-action="speak"]')?.click();

    await vi.waitFor(() => {
      expect(onExplain).toHaveBeenCalledWith('Translate this sentence.');
      expect(onSpeak).toHaveBeenCalledWith('Translate this sentence.');
      expect(document.querySelector('.sayso-selection-translation-result')?.textContent).toContain(
        'A short explanation.'
      );
    });
  });
});
