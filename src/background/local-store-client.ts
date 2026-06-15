import type {
  Conversation,
  SaveMediaSnippetInput,
  Snippet,
  SnippetMergeInput,
  SnippetGroupDetail,
  SnippetInput,
  SnippetSelectionInput,
  SnippetSelectionUpsertResult,
  SnippetStatus,
} from '@/types';
import { fetchWithTimeout, normalizeErrorMessage } from '@/core/http';

export const DEFAULT_MEMORY_HUB_BASE_URL = 'http://127.0.0.1:1995';
export const DEFAULT_LOCAL_STORE_BASE_URL = `${DEFAULT_MEMORY_HUB_BASE_URL}/local-store`;
const REQUEST_TIMEOUT_MS = 6000;
const MEDIA_REQUEST_TIMEOUT_MS = 20000;

interface LocalStoreErrorPayload {
  status?: string;
  code?: string;
  message?: string;
}

export interface LocalStoreHealthResponse {
  status: 'ok' | 'error';
  version?: string;
  dbPath?: string;
  connected?: boolean;
}

export class LocalStoreClientError extends Error {
  readonly code?: string;
  readonly status?: number;

  constructor(message: string, options?: { code?: string; status?: number }) {
    super(message);
    this.name = 'LocalStoreClientError';
    this.code = options?.code;
    this.status = options?.status;
  }
}


export class LocalStoreClient {
  private baseUrl: string;

  constructor(baseUrl = DEFAULT_LOCAL_STORE_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async health(): Promise<LocalStoreHealthResponse> {
    return this.request<LocalStoreHealthResponse>('/health', {
      method: 'GET',
    });
  }

  async findConversationByUrl(url: string): Promise<Conversation | null> {
    const response = await this.request<{ conversation: Conversation | null }>(
      '/conversations/find-by-url',
      {
        method: 'POST',
        body: { url },
      }
    );

    return response.conversation || null;
  }

  async createConversation(conversation: Partial<Conversation>): Promise<string> {
    const response = await this.request<{ conversationId: string }>('/conversations', {
      method: 'POST',
      body: { conversation },
    });

    if (!response.conversationId) {
      throw new LocalStoreClientError('Local store createConversation response missing conversationId');
    }

    return response.conversationId;
  }

  async updateConversation(conversationId: string, conversation: Partial<Conversation>): Promise<void> {
    await this.request<{ status: 'ok' }>(`/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'PUT',
      body: { conversation },
    });
  }

  async getConversationById(conversationId: string): Promise<Conversation | null> {
    const response = await this.request<{ conversation?: Conversation | null }>(
      `/conversations/${encodeURIComponent(conversationId)}`,
      { method: 'GET' }
    );

    return response.conversation || null;
  }

  async getAllConversations(): Promise<Conversation[]> {
    const response = await this.request<{ conversations?: Conversation[] }>('/conversations', {
      method: 'GET',
    });

    return response.conversations || [];
  }

  async getConversationsByIds(conversationIds: string[]): Promise<Conversation[]> {
    const response = await this.request<{ conversations?: Conversation[] }>('/conversations/by-ids', {
      method: 'POST',
      body: { conversationIds },
    });

    return response.conversations || [];
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.request<{ status: 'ok' }>(`/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'DELETE',
    });
  }

  async clearConversations(): Promise<void> {
    await this.request<{ status: 'ok' }>('/conversations/clear', {
      method: 'POST',
      body: {},
    });
  }

  async getStorageUsage(): Promise<{ totalConversations: number; todayNewConversations: number }> {
    return this.request<{ totalConversations: number; todayNewConversations: number }>(
      '/stats/storage-usage',
      {
        method: 'GET',
      }
    );
  }

  async setDataPath(path: string): Promise<{ status: 'ok'; dbPath?: string }> {
    return this.request<{ status: 'ok'; dbPath?: string }>('/config/path', {
      method: 'POST',
      body: { path },
    });
  }

  async upsertSnippet(snippet: SnippetInput): Promise<Snippet> {
    const response = await this.request<{ snippet?: Snippet }>('/snippets/upsert', {
      method: 'POST',
      body: { snippet },
    });

    if (!response.snippet) {
      throw new LocalStoreClientError('Local store upsertSnippet response missing snippet');
    }

    return response.snippet;
  }

  async upsertSnippetSelection(
    selection: SnippetSelectionInput
  ): Promise<SnippetSelectionUpsertResult> {
    const response = await this.request<{
      group?: Snippet;
      item?: SnippetGroupDetail['items'][number];
    }>('/snippets/selection/upsert', {
      method: 'POST',
      body: { selection },
    });

    if (!response.group || !response.item) {
      throw new LocalStoreClientError(
        'Local store upsertSnippetSelection response missing group or item'
      );
    }

    return {
      group: response.group,
      item: response.item,
    };
  }

  async saveMediaSnippet(input: SaveMediaSnippetInput): Promise<SnippetGroupDetail | null> {
    const response = await this.request<{
      group?: Snippet | null;
      items?: SnippetGroupDetail['items'];
    }>('/snippets/media/upsert', {
      method: 'POST',
      body: input,
      timeoutMs: MEDIA_REQUEST_TIMEOUT_MS,
    });

    if (!response.group) {
      return null;
    }

    return {
      group: response.group,
      items: response.items || [],
    };
  }

  async getAllSnippets(): Promise<Snippet[]> {
    const response = await this.request<{ snippets?: Snippet[] }>('/snippets', {
      method: 'GET',
    });

    return response.snippets || [];
  }

  async getSnippetById(id: string): Promise<Snippet | null> {
    const response = await this.request<{ snippet?: Snippet | null }>(
      `/snippets/${encodeURIComponent(id)}`,
      {
        method: 'GET',
      }
    );

    return response.snippet || null;
  }

  async getSnippetGroupById(id: string): Promise<SnippetGroupDetail | null> {
    const response = await this.request<{
      group?: Snippet | null;
      items?: SnippetGroupDetail['items'];
    }>(`/snippets/${encodeURIComponent(id)}`, {
      method: 'GET',
    });

    if (!response.group) {
      return null;
    }

    return {
      group: response.group,
      items: response.items || [],
    };
  }

  async getSnippetsByUrl(url: string): Promise<SnippetGroupDetail[]> {
    const response = await this.request<{ snippets?: SnippetGroupDetail[] }>(
      `/snippets/by-url?url=${encodeURIComponent(url)}`,
      {
        method: 'GET',
      }
    );

    return response.snippets || [];
  }

  async deleteSnippet(id: string): Promise<void> {
    await this.request<{ status: 'ok' }>(`/snippets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async deleteSnippetItem(id: string): Promise<void> {
    await this.request<{ status: 'ok' }>(`/snippets/items/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async clearSnippets(): Promise<void> {
    await this.request<{ status: 'ok' }>('/snippets/clear', {
      method: 'POST',
      body: {},
    });
  }

  async getSnippetStatusForTab(url: string): Promise<SnippetStatus> {
    return this.request<SnippetStatus>(`/snippets/status?url=${encodeURIComponent(url)}`, {
      method: 'GET',
    });
  }

  async enrichSnippet(id: string): Promise<SnippetGroupDetail | null> {
    const response = await this.request<{
      group?: Snippet | null;
      items?: SnippetGroupDetail['items'];
    }>(`/snippets/${encodeURIComponent(id)}/enrich`, {
      method: 'POST',
      body: {},
    });

    if (!response.group) {
      return null;
    }

    return {
      group: response.group,
      items: response.items || [],
    };
  }

  async mergeSnippets(input: SnippetMergeInput): Promise<SnippetGroupDetail | null> {
    const response = await this.request<{
      group?: Snippet | null;
      items?: SnippetGroupDetail['items'];
    }>('/snippets/merge', {
      method: 'POST',
      body: {
        targetId: input.targetId,
        sourceIds: input.sourceIds,
      },
    });

    if (!response.group) {
      return null;
    }

    return {
      group: response.group,
      items: response.items || [],
    };
  }

  getSnippetMediaFileUrl(id: string): string {
    return `${this.baseUrl}/snippets/${encodeURIComponent(id)}/media/file`;
  }

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
        const errorPayload = (json || {}) as LocalStoreErrorPayload;
        const routeMismatchHint =
          response.status === 404 &&
          errorPayload.message === 'Route not found' &&
          path.startsWith('/snippets')
            ? ' Restart local-store service so it picks up the latest snippets API.'
            : '';
        throw new LocalStoreClientError(
          (errorPayload.message || `Local store request failed with status ${response.status}`) +
            routeMismatchHint,
          {
            status: response.status,
            code: errorPayload.code,
          }
        );
      }

      const payload = (json || {}) as Record<string, unknown>;
      if (payload.status === 'error') {
        const errorPayload = payload as LocalStoreErrorPayload;
        throw new LocalStoreClientError(errorPayload.message || 'Local store returned error status', {
          code: errorPayload.code,
        });
      }

      return json as T;
    } catch (error) {
      if (error instanceof LocalStoreClientError) {
        throw error;
      }

      const message = normalizeErrorMessage(error);
      throw new LocalStoreClientError(message || 'Local store request failed');
    }
  }
}

export const localStoreClient = new LocalStoreClient();
