import { describe, expect, it, vi } from 'vitest';

import {
  explainSelectedText,
  buildPageTranslationMessages,
  parsePageTranslationResponse,
  translatePageTextItems,
} from '@/translation/service';

describe('translation service', () => {
  const items = [
    { id: 'sayso-t1', text: 'Hello world' },
    { id: 'sayso-t2', text: 'Keep the same order.' },
  ];

  it('builds a structured page translation prompt', () => {
    const messages = buildPageTranslationMessages({
      sourceLanguage: 'auto',
      targetLanguage: 'zh-CN',
      pageTitle: 'Transformer overview',
      pageUrl: 'https://example.com/transformer',
      contextText: 'Attention mechanism overview',
      items,
    });

    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('professional web page translator');
    expect(messages[1].content).toContain('zh-CN');
    expect(messages[1].content).toContain('Transformer overview');
    expect(messages[1].content).toContain('Attention mechanism overview');
    expect(messages[1].content).toContain('"id": "sayso-t1"');
    expect(messages[1].content).toContain('"translations"');
  });

  it('parses fenced JSON translation responses', () => {
    const parsed = parsePageTranslationResponse(
      '```json\n{"translations":[{"id":"sayso-t1","text":"你好，世界"}]}\n```'
    );

    expect(parsed).toEqual([{ id: 'sayso-t1', text: '你好，世界' }]);
  });

  it('translates page text through an injected LLM runner', async () => {
    const runCompletion = vi.fn().mockResolvedValue(
      JSON.stringify({
        translations: [
          { id: 'sayso-t1', text: '你好，世界' },
          { id: 'sayso-t2', text: '保持相同顺序。' },
        ],
      })
    );

    const result = await translatePageTextItems({
      settings: {
        llmApi: {
          provider: 'openai',
          apiKey: 'test-key',
          model: 'gpt-4o-mini',
        },
      },
      request: {
        sourceLanguage: 'auto',
        targetLanguage: 'zh-CN',
        items,
      },
      runCompletion,
    });

    expect(runCompletion).toHaveBeenCalledTimes(1);
    expect(result.translations).toEqual([
      { id: 'sayso-t1', text: '你好，世界' },
      { id: 'sayso-t2', text: '保持相同顺序。' },
    ]);
  });

  it('requires an LLM API key for server-side page translation', async () => {
    await expect(
      translatePageTextItems({
        settings: {},
        request: {
          sourceLanguage: 'auto',
          targetLanguage: 'zh-CN',
          items,
        },
        runCompletion: vi.fn(),
      })
    ).rejects.toThrow('请先在设置中配置 LLM API Key');
  });

  it('explains selected text through the LLM runner', async () => {
    const runCompletion = vi.fn().mockResolvedValue('This sentence greets the reader.');

    const result = await explainSelectedText({
      settings: {
        llmApi: {
          provider: 'openai',
          apiKey: 'test-key',
          model: 'gpt-4o-mini',
        },
      },
      text: 'Hello world',
      targetLanguage: 'zh-CN',
      runCompletion,
    });

    expect(result.explanation).toContain('greets');
    expect(runCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'test-key' }),
      expect.objectContaining({
        temperature: 0.2,
      })
    );
  });
});
