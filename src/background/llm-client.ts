/**
 * LLM API 客户端（OpenAI 兼容格式）
 * 支持百炼 DashScope / OpenAI / 自定义端点
 */

import { Logger } from '@/core/errors';
import type { AppSettings } from '@/types';

const PROVIDER_BASE_URLS: Record<string, string> = {
  bailian: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  openai: 'https://api.openai.com/v1',
};

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletionOptions {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 关闭混合推理模型（qwen3 / deepseek-v3.1+）的思考链，避免翻译等任务被拖慢。 */
  enableThinking?: boolean;
}

function getBaseUrl(config: NonNullable<AppSettings['llmApi']>): string {
  if (config.provider === 'custom' && config.baseUrl) {
    return config.baseUrl.replace(/\/+$/, '');
  }
  return PROVIDER_BASE_URLS[config.provider] || PROVIDER_BASE_URLS.openai;
}

export async function callLlm(
  config: NonNullable<AppSettings['llmApi']>,
  options: LlmCompletionOptions
): Promise<string> {
  const baseUrl = getBaseUrl(config);
  const model = config.model || 'qwen-plus';
  const url = `${baseUrl}/chat/completions`;

  Logger.debug(`[LLM] 请求 ${config.provider}/${model}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: options.messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      ...(options.enableThinking === false ? { enable_thinking: false } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`LLM API 错误 ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('LLM 返回空内容');
  }

  Logger.debug(`[LLM] 响应 ${content.length} 字符`);
  return content;
}
