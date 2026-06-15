/**
 * Exa API HTTP 客户端
 * 文档：https://docs.exa.ai/reference/search
 */

import { Logger } from '@/core/errors';
import { fetchWithTimeout, FetchTimeoutError } from '@/core/http';

export type ExaErrorCode =
  | 'INVALID_KEY'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'BAD_REQUEST'
  | 'SERVER_ERROR'
  | 'UNKNOWN';

export class ExaClientError extends Error {
  public readonly code: ExaErrorCode;
  public readonly status?: number;
  public readonly detail?: string;

  constructor(code: ExaErrorCode, message: string, options?: { status?: number; detail?: string }) {
    super(message);
    this.name = 'ExaClientError';
    this.code = code;
    this.status = options?.status;
    this.detail = options?.detail;
  }
}

export interface ExaSearchRequest {
  query: string;
  type?: 'research paper' | 'github' | 'company';
  numResults: number;
  useAutoprompt?: boolean;
  includeText?: boolean;
  timeoutMs?: number;
}

export interface ExaSearchResult {
  title: string;
  url: string;
  publishedDate?: string;
  text?: string;
  score?: number;
  author?: string;
}

export interface ExaSearchResponse {
  results: ExaSearchResult[];
}

const EXA_BASE = 'https://api.exa.ai';
const DEFAULT_TIMEOUT_MS = 10_000;

export class ExaClient {
  constructor(private readonly apiKey: string) {}

  async search(request: ExaSearchRequest): Promise<ExaSearchResponse> {
    if (!this.apiKey) {
      throw new ExaClientError('INVALID_KEY', 'Exa API key is not configured');
    }

    const body: Record<string, unknown> = {
      query: request.query,
      numResults: request.numResults,
      useAutoprompt: request.useAutoprompt ?? false,
    };
    if (request.type) body.type = request.type;
    if (request.includeText !== false) {
      body.contents = { text: { maxCharacters: 500 } };
    }

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${EXA_BASE}/search`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
          },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof FetchTimeoutError) {
        throw new ExaClientError('TIMEOUT', `Exa request timed out after ${timeoutMs}ms`);
      }
      const err = error as Error;
      throw new ExaClientError('NETWORK_ERROR', err.message || 'network error');
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const code = this.mapStatusToCode(response.status);
      throw new ExaClientError(code, `Exa ${response.status}: ${detail.slice(0, 200)}`, {
        status: response.status,
        detail,
      });
    }

    const data = (await response.json()) as ExaSearchResponse;
    Logger.debug(`[Exa] ${request.query} → ${data.results?.length ?? 0} results`);
    return { results: data.results ?? [] };
  }

  private mapStatusToCode(status: number): ExaErrorCode {
    if (status === 401 || status === 403) return 'INVALID_KEY';
    if (status === 429) return 'RATE_LIMITED';
    if (status === 400) return 'BAD_REQUEST';
    if (status >= 500) return 'SERVER_ERROR';
    return 'UNKNOWN';
  }
}
