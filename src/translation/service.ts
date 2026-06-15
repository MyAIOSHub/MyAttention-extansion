import type { AppSettings } from '@/types';
import {
  callLlm,
  type LlmCompletionOptions,
  type LlmMessage,
} from '@/background/llm-client';

export interface PageTranslationItem {
  id: string;
  text: string;
}

export interface PageTranslationRequest {
  sourceLanguage: 'auto' | string;
  targetLanguage: string;
  pageTitle?: string;
  pageUrl?: string;
  contextText?: string;
  items: PageTranslationItem[];
}

export interface PageTranslationResult {
  translations: PageTranslationItem[];
}

export interface ExplainSelectedTextOptions {
  settings: Partial<AppSettings>;
  text: string;
  targetLanguage: string;
  runCompletion?: PageTranslationLlmRunner;
}

export interface ExplainSelectedTextResult {
  explanation: string;
}

export type PageTranslationLlmRunner = (
  config: NonNullable<AppSettings['llmApi']>,
  options: LlmCompletionOptions
) => Promise<string>;

interface TranslatePageTextOptions {
  settings: Partial<AppSettings>;
  request: PageTranslationRequest;
  runCompletion?: PageTranslationLlmRunner;
}

function normalizeLanguageLabel(language: string): string {
  if (!language || language === 'auto') {
    return 'auto-detected source language';
  }
  return language;
}

// 翻译质量取向 → bailian 模型映射（均关闭思考链）。
// 快=qwen-turbo（实测最快），准=deepseek-v4-flash（更准、慢约 30-50%）。
// 其他 provider 无这些模型，沿用用户配置。
type TranslationQuality = 'fast' | 'accurate';

const BAILIAN_TRANSLATION_MODEL: Record<TranslationQuality, string> = {
  fast: 'qwen-turbo',
  accurate: 'deepseek-v4-flash',
};

function resolveTranslationLlmConfig(
  config: NonNullable<AppSettings['llmApi']>,
  quality: TranslationQuality
): NonNullable<AppSettings['llmApi']> {
  if (config.provider === 'bailian') {
    return { ...config, model: BAILIAN_TRANSLATION_MODEL[quality] };
  }
  return config;
}

function getTranslationQuality(settings: Partial<AppSettings>): TranslationQuality {
  return settings.immersiveTranslation?.translationQuality === 'accurate' ? 'accurate' : 'fast';
}

export function buildPageTranslationMessages(
  request: PageTranslationRequest
): LlmMessage[] {
  const payload = {
    sourceLanguage: request.sourceLanguage,
    targetLanguage: request.targetLanguage,
    page: {
      title: request.pageTitle ?? '',
      url: request.pageUrl ?? '',
      contextText: request.contextText ?? '',
    },
    items: request.items,
    expectedResponse: {
      translations: [
        {
          id: 'same id as input',
          text: 'translated text only',
        },
      ],
    },
  };

  return [
    {
      role: 'system',
      content:
        'You are a professional web page translator. Preserve meaning, tone, links, numbers, names, and ordering. Return valid JSON only.',
    },
    {
      role: 'user',
      content: [
        `Translate each item from ${normalizeLanguageLabel(request.sourceLanguage)} to ${request.targetLanguage}.`,
        'Return exactly one translation for each input item using this JSON shape:',
        JSON.stringify(payload.expectedResponse, null, 2),
        'Use this page context when it helps disambiguate terminology:',
        JSON.stringify(payload.page, null, 2),
        'Input:',
        JSON.stringify(payload, null, 2),
      ].join('\n\n'),
    },
  ];
}

export function buildSelectedTextExplanationMessages(
  text: string,
  targetLanguage: string
): LlmMessage[] {
  return [
    {
      role: 'system',
      content:
        'You explain selected web text for a language learner. Be concise, practical, and preserve important terminology.',
    },
    {
      role: 'user',
      content: [
        `Explain this selected text in ${targetLanguage}.`,
        'Include meaning, key terms, and any idiom or grammar point if useful.',
        'Selected text:',
        text,
      ].join('\n\n'),
    },
  ];
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

export function parsePageTranslationResponse(raw: string): PageTranslationItem[] {
  const parsed = JSON.parse(stripJsonFence(raw)) as unknown;
  const translations = Array.isArray(parsed)
    ? parsed
    : (parsed as { translations?: unknown })?.translations;

  if (!Array.isArray(translations)) {
    throw new Error('翻译结果格式错误：缺少 translations 数组');
  }

  return translations
    .map((item) => {
      const candidate = item as { id?: unknown; text?: unknown };
      return {
        id: typeof candidate.id === 'string' ? candidate.id : '',
        text: typeof candidate.text === 'string' ? candidate.text : '',
      };
    })
    .filter((item) => item.id.length > 0 && item.text.length > 0);
}

export async function translatePageTextItems({
  settings,
  request,
  runCompletion = callLlm,
}: TranslatePageTextOptions): Promise<PageTranslationResult> {
  if (!request.items.length) {
    return { translations: [] };
  }

  const llmConfig = settings.llmApi;
  if (!llmConfig?.apiKey) {
    throw new Error('请先在设置中配置 LLM API Key');
  }

  const raw = await runCompletion(resolveTranslationLlmConfig(llmConfig, getTranslationQuality(settings)), {
    messages: buildPageTranslationMessages(request),
    temperature: 0.2,
    maxTokens: Math.min(8192, Math.max(1024, request.items.length * 256)),
    enableThinking: false,
  });

  return {
    translations: parsePageTranslationResponse(raw),
  };
}

export async function explainSelectedText({
  settings,
  text,
  targetLanguage,
  runCompletion = callLlm,
}: ExplainSelectedTextOptions): Promise<ExplainSelectedTextResult> {
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  if (!normalizedText) {
    return { explanation: '' };
  }

  const llmConfig = settings.llmApi;
  if (!llmConfig?.apiKey) {
    throw new Error('请先在设置中配置 LLM API Key');
  }

  const explanation = await runCompletion(resolveTranslationLlmConfig(llmConfig, getTranslationQuality(settings)), {
    messages: buildSelectedTextExplanationMessages(normalizedText, targetLanguage),
    temperature: 0.2,
    maxTokens: 1024,
    enableThinking: false,
  });

  return {
    explanation: explanation.trim(),
  };
}
