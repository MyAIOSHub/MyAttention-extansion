/**
 * EverMemOS Client
 *
 * HTTP client for communicating with EverMemOS memory management system.
 * Used for importing conversations and snippets from SaySo extension to EverMemOS.
 */

import type { Conversation, SnippetGroup } from '@/types';
import { fetchWithTimeout, FetchTimeoutError, normalizeErrorMessage } from '@/core/http';

import { DEFAULT_MEMORY_HUB_BASE_URL } from './local-store-client';

export const DEFAULT_EVERMEMOS_BASE_URL = DEFAULT_MEMORY_HUB_BASE_URL;
const REQUEST_TIMEOUT_MS = 30000; // Longer timeout for memory extraction

interface EverMemOSErrorPayload {
  status?: string;
  message?: string;
  detail?: string;
}

/**
 * Result of an import operation
 */
export interface ImportResult {
  imported_count: number;
  extracted_memories: number;
  group_id: string;
  status: 'completed' | 'partial' | 'failed';
}

/**
 * Response from EverMemOS API
 */
export interface EverMemOSResponse<T> {
  status: 'ok' | 'failed';
  message: string;
  result: T;
}

/**
 * EverMemOS connection status
 */
export interface EverMemOSStatus {
  connected: boolean;
  version?: string;
  baseUrl: string;
  lastError?: string;
}

export interface BrowserSyncCursor {
  updated_at?: string | null;
  cursor_id?: string | null;
}

export interface BrowserSyncStatus {
  running: boolean;
  last_poll_at?: string | null;
  last_success_at?: string | null;
  last_error?: string | null;
  conversation_cursor?: BrowserSyncCursor;
  snippet_cursor?: BrowserSyncCursor;
  pending_conversations: number;
  pending_snippets: number;
  in_progress_conversations: number;
  in_progress_snippets: number;
  imported_conversations: number;
  imported_snippets: number;
}

/**
 * Custom error class for EverMemOS client errors
 */
export class EverMemOSClientError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options?: { status?: number; code?: string }) {
    super(message);
    this.name = 'EverMemOSClientError';
    this.status = options?.status;
    this.code = options?.code;
  }
}


/**
 * Convert SaySo Conversation to EverMemOS import format
 */
function conversationToImportFormat(conversation: Conversation): Record<string, unknown> {
  return {
    conversation_id: conversation.conversationId,
    link: conversation.link,
    platform: conversation.platform,
    title: conversation.title,
    messages: conversation.messages.map((msg, index) => ({
      message_id: msg.messageId,
      sender: msg.sender,
      content: msg.content,
      thinking: msg.thinking,
      position: msg.position ?? index,
      created_at: msg.createdAt || msg.timestamp,
      updated_at: msg.updatedAt || msg.createdAt || msg.timestamp,
    })),
    created_at: conversation.createdAt,
    updated_at: conversation.updatedAt,
  };
}

/**
 * Convert SaySo SnippetGroup to EverMemOS import format
 */
function snippetToImportFormat(snippet: SnippetGroup): Record<string, unknown> {
  return {
    id: snippet.id,
    type: snippet.type,
    url: snippet.url,
    title: snippet.title,
    domain: snippet.domain,
    selection_text: snippet.selectionText,
    context_text: snippet.contextText,
    raw_context_markdown: snippet.rawContextMarkdown,
    summary_text: snippet.summaryText,
    heading_path: snippet.headingPath,
    created_at: snippet.createdAt,
    updated_at: snippet.updatedAt,
    media: snippet.media
      ? {
          kind: snippet.media.kind,
          source_url: snippet.media.sourceUrl,
          preview_url: snippet.media.previewUrl,
          local_file_url: snippet.media.localFileUrl,
          mime_type: snippet.media.mimeType,
          alt_text: snippet.media.altText,
        }
      : undefined,
  };
}

/**
 * EverMemOS API Client
 */
export class EverMemOSClient {
  private baseUrl: string;

  constructor(baseUrl = DEFAULT_EVERMEMOS_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Check connection to EverMemOS server
   */
  async health(): Promise<{ connected: boolean; version?: string }> {
    try {
      const response = await this.request<{ status: string; version?: string }>('/health', {
        method: 'GET',
        timeoutMs: 5000,
      });
      return { connected: true, version: response.version };
    } catch (error) {
      return { connected: false };
    }
  }

  /**
   * Import a conversation to EverMemOS
   *
   * @param conversation The conversation to import
   * @returns Import result with counts
   */
  async importConversation(conversation: Conversation): Promise<ImportResult> {
    const importData = conversationToImportFormat(conversation);

    const response = await this.request<EverMemOSResponse<ImportResult>>(
      '/api/v1/memories/import/conversation',
      {
        method: 'POST',
        body: importData,
        timeoutMs: REQUEST_TIMEOUT_MS,
      }
    );

    if (response.status !== 'ok') {
      throw new EverMemOSClientError(response.message || 'Import failed');
    }

    return response.result;
  }

  /**
   * Import multiple conversations to EverMemOS
   *
   * @param conversations Array of conversations to import
   * @returns Array of import results
   */
  async importConversations(conversations: Conversation[]): Promise<ImportResult[]> {
    const results: ImportResult[] = [];

    for (const conversation of conversations) {
      try {
        const result = await this.importConversation(conversation);
        results.push(result);
      } catch (error) {
        // Log error but continue with remaining conversations
        console.error(
          `Failed to import conversation ${conversation.conversationId}:`,
          error
        );
        results.push({
          imported_count: 0,
          extracted_memories: 0,
          group_id: '',
          status: 'failed',
        });
      }
    }

    return results;
  }

  /**
   * Import a snippet to EverMemOS
   *
   * @param snippet The snippet to import
   * @returns Import result with counts
   */
  async importSnippet(snippet: SnippetGroup): Promise<ImportResult> {
    const importData = snippetToImportFormat(snippet);

    const response = await this.request<EverMemOSResponse<ImportResult>>(
      '/api/v1/memories/import/snippet',
      {
        method: 'POST',
        body: importData,
        timeoutMs: REQUEST_TIMEOUT_MS,
      }
    );

    if (response.status !== 'ok') {
      throw new EverMemOSClientError(response.message || 'Import failed');
    }

    return response.result;
  }

  /**
   * Import multiple snippets to EverMemOS
   *
   * @param snippets Array of snippets to import
   * @returns Array of import results
   */
  async importSnippets(snippets: SnippetGroup[]): Promise<ImportResult[]> {
    const results: ImportResult[] = [];

    for (const snippet of snippets) {
      try {
        const result = await this.importSnippet(snippet);
        results.push(result);
      } catch (error) {
        console.error(`Failed to import snippet ${snippet.id}:`, error);
        results.push({
          imported_count: 0,
          extracted_memories: 0,
          group_id: '',
          status: 'failed',
        });
      }
    }

    return results;
  }

  /**
   * Check if EverMemOS is configured and reachable
   */
  async checkStatus(): Promise<EverMemOSStatus> {
    try {
      const health = await this.health();
      return {
        connected: health.connected,
        version: health.version,
        baseUrl: this.baseUrl,
      };
    } catch (error) {
      return {
        connected: false,
        baseUrl: this.baseUrl,
        lastError: normalizeErrorMessage(error),
      };
    }
  }

  async getBrowserSyncStatus(): Promise<BrowserSyncStatus> {
    const response = await this.request<{
      status: string;
      result?: { status?: BrowserSyncStatus };
    }>('/api/v1/browser-sync/status', {
      method: 'GET',
      timeoutMs: 8000,
    });

    return (
      response?.result?.status || {
        running: false,
        pending_conversations: 0,
        pending_snippets: 0,
        in_progress_conversations: 0,
        in_progress_snippets: 0,
        imported_conversations: 0,
        imported_snippets: 0,
      }
    );
  }

  /**
   * Make HTTP request to EverMemOS API
   */
  private async request<T>(
    path: string,
    options: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
      timeoutMs?: number;
    }
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      const response = await fetchWithTimeout(
        `${this.baseUrl}${path}`,
        {
          method: options.method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        },
        options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      );

      const rawText = await response.text();
      const json = rawText ? (JSON.parse(rawText) as unknown) : ({} as unknown);

      if (!response.ok) {
        const errorPayload = (json || {}) as EverMemOSErrorPayload;
        throw new EverMemOSClientError(
          errorPayload.detail ||
            errorPayload.message ||
            `EverMemOS request failed with status ${response.status}`,
          {
            status: response.status,
          }
        );
      }

      return json as T;
    } catch (error) {
      if (error instanceof EverMemOSClientError) {
        throw error;
      }

      if (error instanceof FetchTimeoutError) {
        throw new EverMemOSClientError('Request timeout');
      }

      const message = normalizeErrorMessage(error, { includeDetail: true });
      throw new EverMemOSClientError(message || 'EverMemOS request failed');
    }
  }
}

/**
 * Default EverMemOS client instance
 */
export const everMemOSClient = new EverMemOSClient();
