import { describe, expect, it } from 'vitest';

import { formatPageTranslationStatus } from '@/popup/translation-status';

describe('page translation popup status', () => {
  it('reports inserted translation count when page translation succeeds', () => {
    expect(
      formatPageTranslationStatus({
        translatedCount: 4,
        frameCount: 2,
        failedFrameCount: 0,
      })
    ).toEqual({
      kind: 'success',
      message: '已在 2 个 frame 中插入 4 段译文',
    });
  });

  it('does not misreport frame delivery failures as missing page text', () => {
    expect(
      formatPageTranslationStatus({
        translatedCount: 0,
        frameCount: 2,
        failedFrameCount: 2,
      })
    ).toEqual({
      kind: 'error',
      message: '当前页面翻译脚本未响应，请刷新页面后重试或重新加载扩展。',
    });
  });

  it('surfaces the real translation error instead of reporting missing page text', () => {
    expect(
      formatPageTranslationStatus({
        translatedCount: 0,
        frameCount: 1,
        failedFrameCount: 0,
        errorMessage: 'LLM API 错误 401: invalid api key',
      })
    ).toEqual({
      kind: 'error',
      message: '翻译失败：LLM API 错误 401: invalid api key',
    });
  });

  it('still reports missing page text when no error occurred and no text was found', () => {
    expect(
      formatPageTranslationStatus({
        translatedCount: 0,
        frameCount: 1,
        failedFrameCount: 0,
      })
    ).toEqual({
      kind: 'success',
      message: '当前页面未找到可翻译文本',
    });
  });
});
