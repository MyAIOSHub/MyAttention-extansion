const LANGUAGE_ALIASES: Record<string, string> = {
  'zh-cn': 'zh',
  'zh-tw': 'zh',
  'zh-hans': 'zh',
  'zh-hant': 'zh',
  'en-us': 'en',
  'en-gb': 'en',
};

export function normalizeAstLanguageCode(language: string | undefined): string {
  const normalized = (language || '').trim().toLowerCase();
  return LANGUAGE_ALIASES[normalized] || normalized || 'en';
}

export function resolveAstLanguagePair(
  sourceLanguage: string,
  targetLanguage: string
): { sourceLanguage: string; targetLanguage: string } {
  const source = (sourceLanguage || '').trim().toLowerCase();
  const target = normalizeAstLanguageCode(targetLanguage);

  if (source === 'auto') {
    if (target === 'zh' || target === 'en') {
      return {
        sourceLanguage: 'zhen',
        targetLanguage: 'zhen',
      };
    }

    return {
      sourceLanguage: 'en',
      targetLanguage: target,
    };
  }

  return {
    sourceLanguage: normalizeAstLanguageCode(sourceLanguage),
    targetLanguage: target,
  };
}
