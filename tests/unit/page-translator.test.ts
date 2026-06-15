import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearPageTranslations,
  collectPageTranslationRequest,
  renderPageTranslations,
  runBatchedTranslation,
} from '@/translation/page-translator';

describe('page translator content helpers', () => {
  beforeEach(() => {
    document.title = 'Example Page';
    document.body.innerHTML = `
      <main>
        <h1>Example Title</h1>
        <p>First visible paragraph for translation.</p>
        <p style="display: none">Hidden paragraph</p>
        <p aria-hidden="true">Aria hidden paragraph</p>
        <script>window.ignoreMe = true;</script>
      </main>
    `;
  });

  it('collects visible page text blocks with stable ids', () => {
    const request = collectPageTranslationRequest({
      sourceLanguage: 'auto',
      targetLanguage: 'zh-CN',
      mode: 'bilingual',
      range: 'main',
    });

    expect(request.items).toEqual([
      { id: 'sayso-t-1', text: 'Example Title' },
      { id: 'sayso-t-2', text: 'First visible paragraph for translation.' },
    ]);
    expect(request.pageTitle).toBe('Example Page');
    expect(request.contextText).toContain('Example Title');
    expect(request.contextText).toContain('First visible paragraph for translation.');
    expect(document.querySelector('h1')?.getAttribute('data-sayso-translation-id')).toBe('sayso-t-1');
  });

  it('collects documentation pages with article-like lists, tables, and code labels', () => {
    document.title = 'Fusion | OpenRouter Documentation';
    document.body.innerHTML = `
      <div class="docs-shell">
        <nav>
          <a>Fusion</a>
          <a>PDF Inputs</a>
        </nav>
        <div data-layout="docs-page">
          <h1>Fusion</h1>
          <p>Multi-model analysis with a judge model.</p>
          <h2>When to use Fusion</h2>
          <p>Reach for Fusion when a single model is not enough.</p>
          <div>
            <ol>
              <li>The plugin injects the openrouter:fusion tool into your request.</li>
              <li>Your model receives the structured analysis and writes the final answer.</li>
            </ol>
          </div>
          <table>
            <tbody>
              <tr>
                <td>analysis_models</td>
                <td>Models that form the panel.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    const request = collectPageTranslationRequest({
      sourceLanguage: 'auto',
      targetLanguage: 'zh-CN',
      mode: 'bilingual',
      range: 'main',
    });

    expect(request.items.map((item) => item.text)).toEqual(
      expect.arrayContaining([
        'Fusion',
        'Reach for Fusion when a single model is not enough.',
        'The plugin injects the openrouter:fusion tool into your request.',
        'Models that form the panel.',
      ])
    );
  });

  it('collects rendered documentation text from div-only content blocks', () => {
    document.title = 'Fusion | OpenRouter Documentation';
    document.body.innerHTML = `
      <div class="fern-docs-layout">
        <nav>
          <div>Overview</div>
          <div>Plugins</div>
        </nav>
        <div role="main" class="fern-page">
          <div class="heading-xl">Fusion</div>
          <div class="text-base">
            The Fusion plugin gives your model access to a multi-model deliberation tool.
          </div>
          <div class="text-base">
            Reach for Fusion when a single model is not enough for research or expert critique.
          </div>
          <div class="steps">
            <div>The plugin injects the openrouter:fusion tool into your request.</div>
            <div>Your model receives the structured analysis and writes the final answer.</div>
          </div>
        </div>
      </div>
    `;

    const request = collectPageTranslationRequest({
      sourceLanguage: 'auto',
      targetLanguage: 'zh-CN',
      mode: 'bilingual',
      range: 'main',
    });

    expect(request.items.map((item) => item.text)).toEqual(
      expect.arrayContaining([
        'The Fusion plugin gives your model access to a multi-model deliberation tool.',
        'Reach for Fusion when a single model is not enough for research or expert critique.',
        'The plugin injects the openrouter:fusion tool into your request.',
      ])
    );
  });

  it('renders and clears bilingual translation blocks', () => {
    const request = collectPageTranslationRequest({
      sourceLanguage: 'auto',
      targetLanguage: 'zh-CN',
      mode: 'bilingual',
      range: 'main',
    });

    renderPageTranslations({
      mode: 'bilingual',
      translations: [
        { id: request.items[0].id, text: '示例标题' },
        { id: request.items[1].id, text: '用于翻译的第一个可见段落。' },
      ],
    });

    const overlays = [...document.querySelectorAll('.sayso-translation-block')];
    expect(overlays).toHaveLength(2);
    expect(overlays[0].textContent).toContain('示例标题');
    expect(overlays[1].textContent).toContain('用于翻译的第一个可见段落。');

    clearPageTranslations();

    expect(document.querySelectorAll('.sayso-translation-block')).toHaveLength(0);
    expect(document.querySelector('h1')?.hasAttribute('data-sayso-translation-id')).toBe(false);
  });
});

describe('runBatchedTranslation', () => {
  const makeItems = (n: number): Array<{ id: string; text: string }> =>
    Array.from({ length: n }, (_, i) => ({ id: `t-${i}`, text: `s${i}` }));

  it('splits items into batches and renders each batch as it completes', async () => {
    const items = makeItems(7);
    const rendered: Array<{ id: string; text: string }> = [];
    const batchSizes: number[] = [];

    const result = await runBatchedTranslation({
      items,
      batchSize: 3,
      concurrency: 2,
      translateBatch: async (batch) => {
        batchSizes.push(batch.length);
        return batch.map((item) => ({ id: item.id, text: `T:${item.text}` }));
      },
      onBatch: (translations) => rendered.push(...translations),
    });

    expect(result).toEqual({ translatedCount: 7 });
    expect(batchSizes).toEqual([3, 3, 1]);
    expect(rendered.map((r) => r.id).sort()).toEqual(items.map((i) => i.id).sort());
  });

  it('never exceeds the configured concurrency', async () => {
    const items = makeItems(6);
    let inFlight = 0;
    let maxInFlight = 0;

    await runBatchedTranslation({
      items,
      batchSize: 1,
      concurrency: 2,
      translateBatch: async (batch) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return batch.map((item) => ({ id: item.id, text: 't' }));
      },
      onBatch: () => undefined,
    });

    expect(maxInFlight).toBe(2);
  });

  it('captures the first batch error and still counts successful batches', async () => {
    const items = makeItems(4);

    const result = await runBatchedTranslation({
      items,
      batchSize: 2,
      concurrency: 1,
      translateBatch: async (batch) => {
        if (batch[0].id === 't-0') {
          throw new Error('boom');
        }
        return batch.map((item) => ({ id: item.id, text: 't' }));
      },
      onBatch: () => undefined,
    });

    expect(result.translatedCount).toBe(2);
    expect(result.firstError).toBe('boom');
  });
});
