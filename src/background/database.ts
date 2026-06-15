/**
 * IndexedDB 数据库管理
 * 封装会话镜像、片段镜像和同步 outbox 操作。
 */

import type {
  Conversation,
  Snippet,
  SnippetGroupDetail,
  SnippetItem,
  SnippetStatus,
  SyncOutboxEntry,
} from '@/types';
import { Logger, ErrorFactory } from '@/core/errors';
import { DB_NAME, DB_VERSION, STORES } from '@/types';
import { normalizeAndDedupeMessages } from '@/core/storage/message-normalizer';
import { cleanUrl } from '@/core/url';

type StoreName = (typeof STORES)[keyof typeof STORES];

type TransactionStores = {
  conversations: IDBObjectStore;
  snippetGroups: IDBObjectStore;
  snippetItems: IDBObjectStore;
  syncOutbox: IDBObjectStore;
};

function requestToPromise<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event: Event) => {
      const target = event.target as IDBRequest | null;
      reject(target?.error || event);
    };
  });
}


function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(16);
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const next = new Set<string>();
  values.forEach((value) => {
    const normalized = String(value || '').trim();
    if (normalized) {
      next.add(normalized);
    }
  });
  return Array.from(next);
}

function buildFallbackSummary(group: Snippet, items: SnippetItem[]): string {
  if (group.summaryText?.trim()) {
    return group.summaryText;
  }
  if (items[0]?.selectionText?.trim()) {
    return items[0].selectionText.trim();
  }
  if (group.selectionText?.trim()) {
    return group.selectionText.trim();
  }
  if (group.media?.altText?.trim()) {
    return group.media.altText.trim();
  }
  return (group.rawContextText || group.contextText || '').slice(0, 160);
}

function sortSnippetItems(items: SnippetItem[]): SnippetItem[] {
  return [...items].sort((a, b) => {
    if ((a.orderIndex || 0) !== (b.orderIndex || 0)) {
      return (a.orderIndex || 0) - (b.orderIndex || 0);
    }
    return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
  });
}

/**
 * IndexedDB 数据库管理器
 */
export class Database {
  private db: IDBDatabase | null = null;

  private dbPromise: Promise<IDBDatabase> | null = null;

  async open(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }

    Logger.info('[Database] 打开数据库...');

    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event: Event) => {
          Logger.error('[Database] 打开数据库失败', event);
          reject(ErrorFactory.database('打开数据库失败', event));
        };

        request.onsuccess = () => {
          Logger.info('[Database] 数据库打开成功');
          resolve(request.result);
        };

        request.onupgradeneeded = (event) => {
          Logger.info('[Database] 数据库需要升级', {
            oldVersion: event.oldVersion,
            newVersion: event.newVersion,
          });
          this.handleUpgrade((event.target as IDBOpenDBRequest).result);
        };
      });

      return this.db;
    } catch (error) {
      throw ErrorFactory.database('数据库初始化失败', error as Error);
    }
  }

  private handleUpgrade(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains(STORES.CONVERSATIONS)) {
      const store = db.createObjectStore(STORES.CONVERSATIONS, {
        keyPath: 'conversationId',
      });
      store.createIndex('link', 'link', { unique: false });
      store.createIndex('platform', 'platform', { unique: false });
      store.createIndex('updatedAt', 'updatedAt', { unique: false });
      store.createIndex('createdAt', 'createdAt', { unique: false });
    }

    if (!db.objectStoreNames.contains(STORES.SNIPPET_GROUPS)) {
      const store = db.createObjectStore(STORES.SNIPPET_GROUPS, {
        keyPath: 'id',
      });
      store.createIndex('groupKey', 'groupKey', { unique: false });
      store.createIndex('dedupeKey', 'dedupeKey', { unique: false });
      store.createIndex('url', 'url', { unique: false });
      store.createIndex('updatedAt', 'updatedAt', { unique: false });
      store.createIndex('createdAt', 'createdAt', { unique: false });
    }

    if (!db.objectStoreNames.contains(STORES.SNIPPET_ITEMS)) {
      const store = db.createObjectStore(STORES.SNIPPET_ITEMS, {
        keyPath: 'id',
      });
      store.createIndex('snippetId', 'snippetId', { unique: false });
      store.createIndex('quoteHash', 'quoteHash', { unique: false });
      store.createIndex('updatedAt', 'updatedAt', { unique: false });
    }

    if (!db.objectStoreNames.contains(STORES.SYNC_OUTBOX)) {
      const store = db.createObjectStore(STORES.SYNC_OUTBOX, {
        keyPath: 'id',
        autoIncrement: true,
      });
      store.createIndex('createdAt', 'createdAt', { unique: false });
      store.createIndex('operation', 'operation', { unique: false });
      store.createIndex('entityId', 'entityId', { unique: false });
    }
  }

  getDatabase(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = this.open();
    }
    return this.dbPromise;
  }

  private async transactionOnStores<T>(
    storeNames: StoreName[],
    mode: IDBTransactionMode,
    callback: (stores: Partial<TransactionStores>) => Promise<T>
  ): Promise<T> {
    const db = await this.getDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeNames, mode);
      const stores: Partial<TransactionStores> = {};

      if (storeNames.includes(STORES.CONVERSATIONS)) {
        stores.conversations = transaction.objectStore(STORES.CONVERSATIONS);
      }
      if (storeNames.includes(STORES.SNIPPET_GROUPS)) {
        stores.snippetGroups = transaction.objectStore(STORES.SNIPPET_GROUPS);
      }
      if (storeNames.includes(STORES.SNIPPET_ITEMS)) {
        stores.snippetItems = transaction.objectStore(STORES.SNIPPET_ITEMS);
      }
      if (storeNames.includes(STORES.SYNC_OUTBOX)) {
        stores.syncOutbox = transaction.objectStore(STORES.SYNC_OUTBOX);
      }

      transaction.onerror = (event: Event) => {
        Logger.error('[Database] 事务失败', event);
        reject(ErrorFactory.database('事务执行失败', event));
      };

      void callback(stores)
        .then((result) => {
          resolve(result);
        })
        .catch((error) => {
          try {
            transaction.abort();
          } catch {
            // ignore abort failures
          }
          reject(error);
        });
    });
  }

  async readTransaction<T>(
    callback: (stores: Partial<TransactionStores>) => Promise<T>,
    storeNames: StoreName[] = [STORES.CONVERSATIONS]
  ): Promise<T> {
    return this.transactionOnStores(storeNames, 'readonly', callback);
  }

  async readWriteTransaction<T>(
    callback: (stores: Partial<TransactionStores>) => Promise<T>,
    storeNames: StoreName[] = [STORES.CONVERSATIONS]
  ): Promise<T> {
    return this.transactionOnStores(storeNames, 'readwrite', callback);
  }

  async findConversationByUrl(url: string): Promise<Conversation | null> {
    try {
      return await this.readTransaction(async (stores) => {
        const index = stores.conversations!.index('link');
        return (await requestToPromise<Conversation | undefined>(index.get(cleanUrl(url)))) || null;
      });
    } catch (error) {
      Logger.error('[Database] 查找会话失败', error);
      return null;
    }
  }

  async createConversation(conversation: Partial<Conversation>): Promise<string> {
    try {
      return await this.readWriteTransaction(async (stores) => {
        const store = stores.conversations!;
        const conversationId = conversation.conversationId || `conv_${hashText(`${conversation.link}:${Date.now()}`)}`;
        const existing = await requestToPromise<Conversation | undefined>(store.get(conversationId));
        if (existing) {
          throw ErrorFactory.database('会话已存在', '对话 ID 已存在');
        }

        const now = new Date().toISOString();
        const normalizedMessages = normalizeAndDedupeMessages(conversation.messages || []);
        const fullConversation: Conversation = {
          conversationId,
          link: cleanUrl(conversation.link || ''),
          title: conversation.title || '新对话',
          platform: conversation.platform!,
          messages: normalizedMessages,
          createdAt: conversation.createdAt || now,
          updatedAt: conversation.updatedAt || now,
          messageCount: normalizedMessages.length,
          lastMessageAt:
            this.getLastMessageTime({
              messages: normalizedMessages,
              createdAt: now,
              updatedAt: now,
            }) || undefined,
          externalId: conversation.externalId || null,
          dataVersion: 2,
        };

        await requestToPromise(store.add(fullConversation));
        return conversationId;
      });
    } catch (error) {
      Logger.error('[Database] 创建会话失败', error);
      throw error;
    }
  }

  async upsertConversation(conversation: Conversation): Promise<void> {
    try {
      await this.readWriteTransaction(async (stores) => {
        const store = stores.conversations!;
        await requestToPromise(store.put({
          ...conversation,
          link: cleanUrl(conversation.link || ''),
          messages: normalizeAndDedupeMessages(conversation.messages || []),
          dataVersion: conversation.dataVersion || 2,
        }));
      });
    } catch (error) {
      Logger.error('[Database] 写入会话失败', error);
      throw error;
    }
  }

  async replaceAllConversations(conversations: Conversation[]): Promise<void> {
    await this.readWriteTransaction(async (stores) => {
      const store = stores.conversations!;
      await requestToPromise(store.clear());
      for (const conversation of conversations) {
        await requestToPromise(store.put({
          ...conversation,
          link: cleanUrl(conversation.link || ''),
          messages: normalizeAndDedupeMessages(conversation.messages || []),
          dataVersion: conversation.dataVersion || 2,
        }));
      }
    });
  }

  async getConversationById(conversationId: string): Promise<Conversation | null> {
    try {
      return await this.readTransaction(async (stores) => {
        return (await requestToPromise<Conversation | undefined>(stores.conversations!.get(conversationId))) || null;
      });
    } catch (error) {
      Logger.error('[Database] 获取会话失败', error);
      return null;
    }
  }

  async getAllConversations(): Promise<Conversation[]> {
    try {
      return await this.readTransaction(async (stores) => {
        const all = (await requestToPromise<Conversation[]>(stores.conversations!.getAll())) || [];
        return all.sort((a, b) => {
          const timeA = this.getConversationSortTime(a);
          const timeB = this.getConversationSortTime(b);
          return new Date(timeB).getTime() - new Date(timeA).getTime();
        });
      });
    } catch (error) {
      Logger.error('[Database] 获取所有会话失败', error);
      return [];
    }
  }

  async updateConversation(conversation: Partial<Conversation>): Promise<void> {
    await this.readWriteTransaction(async (stores) => {
      const store = stores.conversations!;
      const existing = await requestToPromise<Conversation | undefined>(store.get(conversation.conversationId!));
      if (!existing) {
        throw ErrorFactory.database('会话不存在', '对话 ID 不存在');
      }

      const normalizedMessages = conversation.messages
        ? normalizeAndDedupeMessages(conversation.messages)
        : existing.messages;
      const updatedAt = conversation.updatedAt || new Date().toISOString();
      const nextConversation: Conversation = {
        ...existing,
        ...conversation,
        link: cleanUrl(conversation.link || existing.link || ''),
        messages: normalizedMessages,
        updatedAt,
        messageCount: normalizedMessages.length,
        lastMessageAt:
          this.getLastMessageTime({
            messages: normalizedMessages,
            createdAt: existing.createdAt,
            updatedAt,
          }) || existing.lastMessageAt,
        dataVersion: 2,
      };

      await requestToPromise(store.put(nextConversation));
    });
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.readWriteTransaction(async (stores) => {
      await requestToPromise(stores.conversations!.delete(conversationId));
    });
  }

  async clearAllConversations(): Promise<void> {
    await this.readWriteTransaction(async (stores) => {
      await requestToPromise(stores.conversations!.clear());
    });
  }

  async getStorageUsage(): Promise<{ totalConversations: number; todayNewConversations: number }> {
    try {
      return await this.readTransaction(async (stores) => {
        const store = stores.conversations!;
        const totalConversations = await requestToPromise<number>(store.count());
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const range = IDBKeyRange.lowerBound(today.toISOString());
        const todayNewConversations = await requestToPromise<number>(store.index('createdAt').count(range));
        return {
          totalConversations,
          todayNewConversations,
        };
      });
    } catch (error) {
      Logger.error('[Database] 获取存储使用情况失败', error);
      return {
        totalConversations: 0,
        todayNewConversations: 0,
      };
    }
  }

  async getSnippetById(id: string): Promise<Snippet | null> {
    try {
      return await this.readTransaction(
        async (stores) => {
          return (await requestToPromise<Snippet | undefined>(stores.snippetGroups!.get(id))) || null;
        },
        [STORES.SNIPPET_GROUPS]
      );
    } catch (error) {
      Logger.error('[Database] 获取片段分组失败', error);
      return null;
    }
  }

  async getSnippetGroupById(id: string): Promise<SnippetGroupDetail | null> {
    try {
      return await this.readTransaction(
        async (stores) => {
          const group =
            (await requestToPromise<Snippet | undefined>(stores.snippetGroups!.get(id))) || null;
          if (!group) {
            return null;
          }
          const items = await this.getSnippetItemsInternal(stores, id);
          return {
            group,
            items,
          };
        },
        [STORES.SNIPPET_GROUPS, STORES.SNIPPET_ITEMS]
      );
    } catch (error) {
      Logger.error('[Database] 获取片段详情失败', error);
      return null;
    }
  }

  async getAllSnippets(): Promise<Snippet[]> {
    try {
      return await this.readTransaction(
        async (stores) => {
          const groups =
            (await requestToPromise<Snippet[]>(stores.snippetGroups!.getAll())) || [];
          return groups.sort((a, b) => {
            return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
          });
        },
        [STORES.SNIPPET_GROUPS]
      );
    } catch (error) {
      Logger.error('[Database] 获取所有片段失败', error);
      return [];
    }
  }

  async getSnippetsByUrl(url: string): Promise<SnippetGroupDetail[]> {
    try {
      return await this.readTransaction(
        async (stores) => {
          const groups =
            (await requestToPromise<Snippet[]>(
              stores.snippetGroups!.index('url').getAll(cleanUrl(url))
            )) || [];
          const details: SnippetGroupDetail[] = [];
          for (const group of groups) {
            const items = await this.getSnippetItemsInternal(stores, group.id);
            details.push({ group, items });
          }
          return details.sort((a, b) => {
            return new Date(b.group.updatedAt || b.group.createdAt).getTime() -
              new Date(a.group.updatedAt || a.group.createdAt).getTime();
          });
        },
        [STORES.SNIPPET_GROUPS, STORES.SNIPPET_ITEMS]
      );
    } catch (error) {
      Logger.error('[Database] 根据 URL 获取片段失败', error);
      return [];
    }
  }

  async getSnippetStatus(url: string): Promise<SnippetStatus> {
    const details = await this.getSnippetsByUrl(url);
    const latestSnippetAt = details[0]?.group.updatedAt || details[0]?.group.createdAt;
    return {
      url: cleanUrl(url),
      hasSnippet: details.length > 0,
      snippetCount: details.length,
      latestSnippetAt,
    };
  }

  async getSnippetGroupByGroupKey(groupKey: string): Promise<Snippet | null> {
    if (!groupKey) {
      return null;
    }
    return this.readTransaction(
      async (stores) => {
        const results =
          (await requestToPromise<Snippet[]>(
            stores.snippetGroups!.index('groupKey').getAll(groupKey)
          )) || [];
        return results[0] || null;
      },
      [STORES.SNIPPET_GROUPS]
    );
  }

  async getSnippetGroupByDedupeKey(dedupeKey: string): Promise<Snippet | null> {
    if (!dedupeKey) {
      return null;
    }
    return this.readTransaction(
      async (stores) => {
        const results =
          (await requestToPromise<Snippet[]>(
            stores.snippetGroups!.index('dedupeKey').getAll(dedupeKey)
          )) || [];
        return results[0] || null;
      },
      [STORES.SNIPPET_GROUPS]
    );
  }

  async upsertSnippetGroup(group: Snippet): Promise<void> {
    await this.readWriteTransaction(
      async (stores) => {
        await requestToPromise(stores.snippetGroups!.put(group));
      },
      [STORES.SNIPPET_GROUPS]
    );
  }

  async putSnippetItems(items: SnippetItem[]): Promise<void> {
    if (!items.length) {
      return;
    }
    await this.readWriteTransaction(
      async (stores) => {
        for (const item of items) {
          await requestToPromise(stores.snippetItems!.put(item));
        }
      },
      [STORES.SNIPPET_ITEMS]
    );
  }

  async replaceSnippetGroupDetail(
    detail: SnippetGroupDetail,
    match?: { previousGroupId?: string; groupKey?: string; dedupeKey?: string }
  ): Promise<void> {
    await this.readWriteTransaction(
      async (stores) => {
        const groupsStore = stores.snippetGroups!;
        const itemsStore = stores.snippetItems!;
        const cleanupIds = uniqueStrings([
          match?.previousGroupId,
          detail.group.id,
        ]);

        if (match?.groupKey && detail.group.groupKey !== match.groupKey) {
          const groups =
            (await requestToPromise<Snippet[]>(groupsStore.index('groupKey').getAll(match.groupKey))) || [];
          groups.forEach((group) => cleanupIds.push(group.id));
        }

        if (match?.dedupeKey && detail.group.dedupeKey !== match.dedupeKey) {
          const groups =
            (await requestToPromise<Snippet[]>(groupsStore.index('dedupeKey').getAll(match.dedupeKey))) || [];
          groups.forEach((group) => cleanupIds.push(group.id));
        }

        for (const groupId of uniqueStrings(cleanupIds)) {
          const existingItems =
            (await requestToPromise<SnippetItem[]>(
              itemsStore.index('snippetId').getAll(groupId)
            )) || [];
          for (const item of existingItems) {
            await requestToPromise(itemsStore.delete(item.id));
          }
          if (groupId !== detail.group.id) {
            await requestToPromise(groupsStore.delete(groupId));
          }
        }

        await requestToPromise(groupsStore.put(detail.group));
        for (const item of detail.items) {
          await requestToPromise(itemsStore.put(item));
        }
      },
      [STORES.SNIPPET_GROUPS, STORES.SNIPPET_ITEMS]
    );
  }

  async deleteSnippet(id: string): Promise<void> {
    await this.readWriteTransaction(
      async (stores) => {
        const items =
          (await requestToPromise<SnippetItem[]>(
            stores.snippetItems!.index('snippetId').getAll(id)
          )) || [];
        for (const item of items) {
          await requestToPromise(stores.snippetItems!.delete(item.id));
        }
        await requestToPromise(stores.snippetGroups!.delete(id));
      },
      [STORES.SNIPPET_GROUPS, STORES.SNIPPET_ITEMS]
    );
  }

  async deleteSnippetItem(id: string): Promise<SnippetItem | null> {
    return this.readWriteTransaction(
      async (stores) => {
        const existing =
          (await requestToPromise<SnippetItem | undefined>(stores.snippetItems!.get(id))) || null;
        if (!existing) {
          return null;
        }
        await requestToPromise(stores.snippetItems!.delete(id));
        return existing;
      },
      [STORES.SNIPPET_ITEMS]
    );
  }

  async clearSnippets(): Promise<void> {
    await this.readWriteTransaction(
      async (stores) => {
        await requestToPromise(stores.snippetItems!.clear());
        await requestToPromise(stores.snippetGroups!.clear());
      },
      [STORES.SNIPPET_GROUPS, STORES.SNIPPET_ITEMS]
    );
  }

  async replaceAllSnippets(details: SnippetGroupDetail[]): Promise<void> {
    await this.readWriteTransaction(
      async (stores) => {
        await requestToPromise(stores.snippetItems!.clear());
        await requestToPromise(stores.snippetGroups!.clear());
        for (const detail of details) {
          await requestToPromise(stores.snippetGroups!.put(detail.group));
          for (const item of detail.items) {
            await requestToPromise(stores.snippetItems!.put(item));
          }
        }
      },
      [STORES.SNIPPET_GROUPS, STORES.SNIPPET_ITEMS]
    );
  }

  async getOutboxEntries(): Promise<Array<SyncOutboxEntry & { id: number }>> {
    return this.readTransaction(
      async (stores) => {
        const entries =
          (await requestToPromise<Array<SyncOutboxEntry & { id: number }>>(
            stores.syncOutbox!.getAll()
          )) || [];
        return entries.sort((a, b) => (a.id || 0) - (b.id || 0));
      },
      [STORES.SYNC_OUTBOX]
    );
  }

  async addOutboxEntry(entry: SyncOutboxEntry): Promise<number> {
    return this.readWriteTransaction(
      async (stores) => {
        const id = await requestToPromise<IDBValidKey>(stores.syncOutbox!.add(entry));
        return Number(id);
      },
      [STORES.SYNC_OUTBOX]
    );
  }

  async deleteOutboxEntry(id: number): Promise<void> {
    await this.readWriteTransaction(
      async (stores) => {
        await requestToPromise(stores.syncOutbox!.delete(id));
      },
      [STORES.SYNC_OUTBOX]
    );
  }

  async clearOutbox(): Promise<void> {
    await this.readWriteTransaction(
      async (stores) => {
        await requestToPromise(stores.syncOutbox!.clear());
      },
      [STORES.SYNC_OUTBOX]
    );
  }

  async countOutboxEntries(): Promise<number> {
    return this.readTransaction(
      async (stores) => {
        return requestToPromise<number>(stores.syncOutbox!.count());
      },
      [STORES.SYNC_OUTBOX]
    );
  }

  private async getSnippetItemsInternal(
    stores: Partial<TransactionStores>,
    snippetId: string
  ): Promise<SnippetItem[]> {
    const items =
      (await requestToPromise<SnippetItem[]>(
        stores.snippetItems!.index('snippetId').getAll(snippetId)
      )) || [];
    return sortSnippetItems(items);
  }

  private getConversationSortTime(conversation: Conversation): string {
    if (conversation.messages && conversation.messages.length > 0) {
      const lastMessage = conversation.messages[conversation.messages.length - 1];
      if (lastMessage.updatedAt) {
        return lastMessage.updatedAt;
      }
      if (lastMessage.createdAt) {
        return lastMessage.createdAt;
      }
    }
    return conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt || new Date().toISOString();
  }

  private getLastMessageTime(conversation: Partial<Conversation>): string | null {
    if (!conversation.messages || conversation.messages.length === 0) {
      return null;
    }
    const lastMessage = conversation.messages[conversation.messages.length - 1];
    return lastMessage.updatedAt || lastMessage.createdAt || null;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.dbPromise = null;
    }
  }

  async destroy(): Promise<void> {
    await this.close();
  }
}

export const database = new Database();
