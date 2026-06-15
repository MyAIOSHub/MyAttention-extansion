import { Logger } from '@/core/errors';
import { cleanUrl } from '@/core/url';
import { asNonEmptyString } from '@/core/string';

export interface MessageDispatchPolicy {
  readCoalesceTypes: Set<string>;
  writeQueueTypes: Set<string>;
  maxConcurrentWriteKeys: number;
  taskTimeoutMs: number;
}

export interface QueueTaskMeta {
  type: string;
  queueKey: string;
  priority: number;
  source: 'manual' | 'auto' | 'unknown';
  createdAt: number;
}

interface DispatchRequest {
  messageType: string;
  params: any;
  sender: chrome.runtime.MessageSender;
  handler: (params: any, sender: chrome.runtime.MessageSender) => Promise<any>;
}

interface WriteQueueTask {
  meta: QueueTaskMeta;
  params: any;
  sender: chrome.runtime.MessageSender;
  handler: (params: any, sender: chrome.runtime.MessageSender) => Promise<any>;
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
}

const DEFAULT_POLICY: MessageDispatchPolicy = {
  readCoalesceTypes: new Set([
    'getAllConversations',
    'getStorageUsage',
    'getSettings',
    'getLocalStoreStatus',
    'getLocalStoreMigrationState',
    'getEverMemOSStatus',
    'getBrowserSyncStatus',
    'getBrowsingHistory',
  ]),
  writeQueueTypes: new Set([
    'createConversation',
    'updateConversation',
    'incrementalUpdate',
    'smartIncrementalUpdate',
    'deleteConversation',
    'upsertSnippet',
    'saveMediaSnippet',
    'upsertSnippetSelection',
    'mergeSnippets',
    'deleteSnippet',
    'deleteSnippetItem',
    'clearSnippets',
    'exportConversationToEverMemOS',
    'exportConversationsToEverMemOS',
    'exportSnippetToEverMemOS',
    'exportSnippetsToEverMemOS',
    'setEverMemOSBaseUrl',
  ]),
  maxConcurrentWriteKeys: 3,
  taskTimeoutMs: 15_000,
};

export class MessageDispatcher {
  private readonly policy: MessageDispatchPolicy;

  private readonly inFlightReadRequests = new Map<string, Promise<any>>();

  private readonly writeQueues = new Map<string, WriteQueueTask[]>();

  private readonly activeWriteKeys = new Set<string>();

  private readonly roundRobinKeys: string[] = [];

  private roundRobinCursor = 0;

  constructor(policy: Partial<MessageDispatchPolicy> = {}) {
    this.policy = {
      ...DEFAULT_POLICY,
      ...policy,
      readCoalesceTypes: policy.readCoalesceTypes || DEFAULT_POLICY.readCoalesceTypes,
      writeQueueTypes: policy.writeQueueTypes || DEFAULT_POLICY.writeQueueTypes,
    };
  }

  async dispatch(request: DispatchRequest): Promise<any> {
    if (this.policy.readCoalesceTypes.has(request.messageType)) {
      return this.dispatchRead(request);
    }

    if (this.policy.writeQueueTypes.has(request.messageType)) {
      return this.dispatchWrite(request);
    }

    return this.runWithTimeout(
      () => request.handler(request.params, request.sender),
      {
        type: request.messageType,
        queueKey: 'direct',
        priority: 0,
        source: 'unknown',
        createdAt: Date.now(),
      }
    );
  }

  private dispatchRead(request: DispatchRequest): Promise<any> {
    const readKey = this.buildReadCoalesceKey(request.messageType, request.params);
    const inFlight = this.inFlightReadRequests.get(readKey);
    if (inFlight) {
      return inFlight;
    }

    const taskMeta: QueueTaskMeta = {
      type: request.messageType,
      queueKey: readKey,
      priority: 0,
      source: 'unknown',
      createdAt: Date.now(),
    };

    const promise = this.runWithTimeout(
      () => request.handler(request.params, request.sender),
      taskMeta
    ).finally(() => {
      this.inFlightReadRequests.delete(readKey);
    });

    this.inFlightReadRequests.set(readKey, promise);
    return promise;
  }

  private dispatchWrite(request: DispatchRequest): Promise<any> {
    const queueKey = this.extractWriteQueueKey(request.messageType, request.params);
    const source = this.extractSource(request.params);
    const priority = this.resolvePriority(source);

    return new Promise((resolve, reject) => {
      const queue = this.writeQueues.get(queueKey) || [];
      const task: WriteQueueTask = {
        meta: {
          type: request.messageType,
          queueKey,
          priority,
          source,
          createdAt: Date.now(),
        },
        params: request.params,
        sender: request.sender,
        handler: request.handler,
        resolve,
        reject,
      };

      queue.push(task);
      queue.sort((a, b) => {
        if (a.meta.priority !== b.meta.priority) {
          return b.meta.priority - a.meta.priority;
        }
        return a.meta.createdAt - b.meta.createdAt;
      });

      this.writeQueues.set(queueKey, queue);
      this.ensureRoundRobinKey(queueKey);

      Logger.debug('[MessageDispatcher] 写请求入队', {
        type: request.messageType,
        queueKey,
        queueLength: queue.length,
        source,
      });

      this.pumpWriteQueues();
    });
  }

  private pumpWriteQueues(): void {
    while (this.activeWriteKeys.size < this.policy.maxConcurrentWriteKeys) {
      const nextKey = this.pickNextQueueKey();
      if (!nextKey) {
        return;
      }

      const queue = this.writeQueues.get(nextKey);
      if (!queue || queue.length === 0) {
        this.cleanupQueue(nextKey);
        continue;
      }

      const task = queue.shift();
      if (!task) {
        this.cleanupQueue(nextKey);
        continue;
      }

      this.activeWriteKeys.add(nextKey);
      void this.executeWriteTask(nextKey, task);
    }
  }

  private async executeWriteTask(queueKey: string, task: WriteQueueTask): Promise<void> {
    try {
      const result = await this.runWithTimeout(
        () => task.handler(task.params, task.sender),
        task.meta
      );
      task.resolve(result);
    } catch (error) {
      task.reject(error);
    } finally {
      this.activeWriteKeys.delete(queueKey);

      const queue = this.writeQueues.get(queueKey);
      if (!queue || queue.length === 0) {
        this.cleanupQueue(queueKey);
      }

      this.pumpWriteQueues();
    }
  }

  private async runWithTimeout<T>(
    executor: () => Promise<T>,
    taskMeta: QueueTaskMeta
  ): Promise<T> {
    if (this.policy.taskTimeoutMs <= 0) {
      return executor();
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const timer = globalThis.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(
          new Error(
            `[MessageDispatcher] ${taskMeta.type} timed out after ${this.policy.taskTimeoutMs}ms (queueKey=${taskMeta.queueKey})`
          )
        );
      }, this.policy.taskTimeoutMs);

      void Promise.resolve()
        .then(executor)
        .then((result) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private buildReadCoalesceKey(type: string, params: any): string {
    if (!params || typeof params !== 'object') {
      return type;
    }

    const normalizedParams = this.omitTypeField(params);
    if (!normalizedParams || Object.keys(normalizedParams).length === 0) {
      return type;
    }

    return `${type}:${this.stableHash(normalizedParams)}`;
  }

  private extractWriteQueueKey(type: string, params: any): string {
    if (type === 'upsertSnippet') {
      const dedupeKey = asNonEmptyString(params?.snippet?.dedupeKey);
      if (dedupeKey) {
        return `snippet:${dedupeKey}`;
      }
    }

    if (type === 'saveMediaSnippet') {
      const dedupeKey = asNonEmptyString(params?.snippet?.dedupeKey);
      if (dedupeKey) {
        return `snippet-media:${dedupeKey}`;
      }
      const sourceUrl = asNonEmptyString(params?.snippet?.media?.sourceUrl);
      const url = asNonEmptyString(params?.snippet?.url);
      if (sourceUrl || url) {
        return `snippet-media:${cleanUrl(url || '')}:${sourceUrl || 'unknown'}`;
      }
    }

    if (type === 'upsertSnippetSelection') {
      const groupKey = asNonEmptyString(params?.selection?.groupKey);
      if (groupKey) {
        return `snippet-group:${groupKey}`;
      }

      const semanticBlockKey = asNonEmptyString(params?.selection?.semanticBlockKey);
      const url = asNonEmptyString(params?.selection?.url);
      if (semanticBlockKey || url) {
        return `snippet-group:${semanticBlockKey || 'unknown'}:${cleanUrl(url || '')}`;
      }
    }

    if (type === 'deleteSnippet') {
      const snippetId = asNonEmptyString(params?.id);
      if (snippetId) {
        return `snippet-id:${snippetId}`;
      }
    }

    if (type === 'mergeSnippets') {
      const targetId = asNonEmptyString(params?.targetId);
      if (targetId) {
        return `snippet-merge:${targetId}`;
      }
      return 'snippet-merge:unknown';
    }

    if (type === 'deleteSnippetItem') {
      const itemId = asNonEmptyString(params?.id);
      if (itemId) {
        return `snippet-item:${itemId}`;
      }
    }

    if (type === 'clearSnippets') {
      return 'snippet:all';
    }

    if (type === 'incrementalUpdate' || type === 'smartIncrementalUpdate') {
      const conversationId = asNonEmptyString(params?.conversationId);
      if (conversationId) {
        return `conversation:${conversationId}`;
      }
    }

    if (type === 'deleteConversation') {
      const conversationId = asNonEmptyString(params?.conversationId);
      if (conversationId) {
        return `conversation:${conversationId}`;
      }
    }

    const conversation = params?.conversation;
    const conversationId = asNonEmptyString(conversation?.conversationId);
    if (conversationId) {
      return `conversation:${conversationId}`;
    }

    const externalId = asNonEmptyString(conversation?.externalId);
    if (externalId) {
      return `external:${externalId}`;
    }

    const link = asNonEmptyString(conversation?.link);
    if (link) {
      return `url:${cleanUrl(link)}`;
    }

    return `global:${type}`;
  }

  private extractSource(params: any): 'manual' | 'auto' | 'unknown' {
    const sourceCandidates = [
      params?.source,
      params?.conversation?.source,
      params?.metadata?.source,
    ];

    for (const candidate of sourceCandidates) {
      if (candidate === 'manual' || candidate === 'auto') {
        return candidate;
      }
    }

    return 'unknown';
  }

  private resolvePriority(source: 'manual' | 'auto' | 'unknown'): number {
    if (source === 'manual') {
      return 100;
    }
    if (source === 'auto') {
      return 10;
    }
    return 20;
  }

  private ensureRoundRobinKey(key: string): void {
    if (this.roundRobinKeys.includes(key)) {
      return;
    }
    this.roundRobinKeys.push(key);
  }

  private pickNextQueueKey(): string | null {
    if (!this.roundRobinKeys.length) {
      return null;
    }

    const maxIterations = this.roundRobinKeys.length;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (!this.roundRobinKeys.length) {
        return null;
      }

      const index = this.roundRobinCursor % this.roundRobinKeys.length;
      const key = this.roundRobinKeys[index];
      this.roundRobinCursor = (index + 1) % this.roundRobinKeys.length;

      const queue = this.writeQueues.get(key);
      if (!queue || queue.length === 0) {
        this.cleanupQueue(key);
        continue;
      }

      if (this.activeWriteKeys.has(key)) {
        continue;
      }

      return key;
    }

    return null;
  }

  private cleanupQueue(key: string): void {
    this.writeQueues.delete(key);

    const index = this.roundRobinKeys.indexOf(key);
    if (index === -1) {
      return;
    }

    this.roundRobinKeys.splice(index, 1);
    if (this.roundRobinKeys.length === 0) {
      this.roundRobinCursor = 0;
      return;
    }

    if (this.roundRobinCursor >= this.roundRobinKeys.length) {
      this.roundRobinCursor = 0;
    }
  }

  private omitTypeField(params: any): Record<string, unknown> {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return {};
    }

    const cloned: Record<string, unknown> = {};
    Object.keys(params)
      .filter((key) => key !== 'type')
      .forEach((key) => {
        cloned[key] = params[key];
      });

    return cloned;
  }

  private stableHash(value: unknown): string {
    return this.stableStringify(value);
  }

  private stableStringify(value: unknown): string {
    if (value === null || value === undefined) {
      return String(value);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return JSON.stringify(value);
    }

    if (typeof value === 'string') {
      return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }

    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b));

      return `{${entries
        .map(([key, itemValue]) => `${JSON.stringify(key)}:${this.stableStringify(itemValue)}`)
        .join(',')}}`;
    }

    return JSON.stringify(String(value));
  }

}

export const messageDispatcher = new MessageDispatcher();
