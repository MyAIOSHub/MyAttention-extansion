import { describe, expect, it, vi } from 'vitest';
import { TranslationIframeRuntime } from '../../src/background/translation-iframe-runtime';

describe('TranslationIframeRuntime', () => {
  it('broadcasts page translation to every frame and records active tab state', async () => {
    const sendMessageToFrame = vi.fn(async () => ({ status: 'ok', translatedCount: 2 }));
    const ensureFrameContentScript = vi.fn(async () => undefined);
    const runtime = new TranslationIframeRuntime({
      getAllFrames: async () => [{ frameId: 0 }, { frameId: 3 }, { frameId: 8 }],
      sendMessageToFrame,
      ensureFrameContentScript,
      now: () => 100,
    });

    const result = await runtime.translateTabFrames(12, {
      sourceLanguage: 'auto',
      targetLanguage: 'zh-CN',
      mode: 'bilingual',
      range: 'main',
    });

    expect(result).toEqual({
      frameCount: 3,
      failedFrameCount: 0,
      translatedCount: 6,
    });
    expect(runtime.hasActiveTranslation(12)).toBe(true);
    expect(sendMessageToFrame).toHaveBeenCalledWith(
      12,
      3,
      expect.objectContaining({ type: 'translation:translateCurrentPage' })
    );
    expect(ensureFrameContentScript).toHaveBeenCalledTimes(3);
    expect(ensureFrameContentScript).toHaveBeenCalledWith(12, 0);
  });

  it('captures a frame translation error instead of silently reporting zero translations', async () => {
    const sendMessageToFrame = vi.fn(async () => ({
      status: 'error',
      error: 'LLM API 错误 401: invalid api key',
    }));
    const runtime = new TranslationIframeRuntime({
      getAllFrames: async () => [{ frameId: 0 }],
      sendMessageToFrame,
      ensureFrameContentScript: vi.fn(async () => undefined),
      now: () => 50,
    });

    const result = await runtime.translateTabFrames(9, {
      sourceLanguage: 'auto',
      targetLanguage: 'zh-CN',
      mode: 'bilingual',
      range: 'main',
    });

    expect(result).toEqual({
      frameCount: 1,
      failedFrameCount: 0,
      translatedCount: 0,
      errorMessage: 'LLM API 错误 401: invalid api key',
    });
  });

  it('replays the active translation request into a newly completed iframe', async () => {
    const sendMessageToFrame = vi.fn(async () => ({ status: 'ok', translatedCount: 4 }));
    const ensureFrameContentScript = vi.fn(async () => undefined);
    const runtime = new TranslationIframeRuntime({
      getAllFrames: async () => [{ frameId: 0 }],
      sendMessageToFrame,
      ensureFrameContentScript,
      now: () => 200,
    });

    await runtime.translateTabFrames(7, {
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      mode: 'translationOnly',
      range: 'fullPage',
    });
    const result = await runtime.handleFrameCompleted({ tabId: 7, frameId: 5 });

    expect(result).toEqual({ injected: true, translatedCount: 4 });
    expect(ensureFrameContentScript).toHaveBeenLastCalledWith(7, 5);
    expect(sendMessageToFrame).toHaveBeenLastCalledWith(
      7,
      5,
      expect.objectContaining({
        sourceLanguage: 'en',
        targetLanguage: 'ja',
        mode: 'translationOnly',
      })
    );
  });

  it('clears translations in every frame and removes active state', async () => {
    const runtime = new TranslationIframeRuntime({
      getAllFrames: async () => [{ frameId: 0 }, { frameId: 2 }],
      sendMessageToFrame: vi.fn(async () => ({ status: 'ok' })),
      ensureFrameContentScript: vi.fn(async () => undefined),
      now: () => 300,
    });

    await runtime.translateTabFrames(4, {
      sourceLanguage: 'auto',
      targetLanguage: 'zh-CN',
      mode: 'bilingual',
      range: 'main',
    });
    const result = await runtime.clearTabTranslations(4);

    expect(result).toEqual({ clearedFrameCount: 2, failedFrameCount: 0 });
    expect(runtime.hasActiveTranslation(4)).toBe(false);
  });
});
