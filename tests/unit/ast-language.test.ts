import { describe, expect, it } from 'vitest';

import { normalizeAstLanguageCode, resolveAstLanguagePair } from '@/offscreen/ast-language';

describe('AST language mapping', () => {
  it('uses Volcengine Chinese-English auto mode for browser auto-detect to Chinese', () => {
    expect(resolveAstLanguagePair('auto', 'zh-CN')).toEqual({
      sourceLanguage: 'zhen',
      targetLanguage: 'zhen',
    });
  });

  it('normalizes browser locale tags before sending them to AST', () => {
    expect(normalizeAstLanguageCode('zh-CN')).toBe('zh');
    expect(normalizeAstLanguageCode('en-US')).toBe('en');
    expect(resolveAstLanguagePair('en-US', 'zh-CN')).toEqual({
      sourceLanguage: 'en',
      targetLanguage: 'zh',
    });
  });
});
