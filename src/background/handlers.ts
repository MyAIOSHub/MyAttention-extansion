/**
 * 消息处理器
 * 处理来自内容脚本和弹出窗口的消息
 */

import type {
  Conversation,
  Message,
  MessageChanges,
  IncrementalUpdateResult,
  TabRuntimeStatus,
  LocalStoreStatus,
  AppSettings,
  SaveMediaSnippetInput,
  Snippet,
  SnippetMergeInput,
  SnippetGroupDetail,
  SnippetInput,
  SnippetSelectionInput,
  SnippetSelectionUpsertResult,
  SnippetStatus,
} from '@/types';
import { DEFAULT_SETTINGS as APP_DEFAULT_SETTINGS } from '@/types';
import { normalizeAndDedupeMessages } from '@/core/storage/message-normalizer';
import { Logger, ErrorFactory } from '@/core/errors';
import { eventBus } from '@/core/event-bus';
import { getPlatformFromUrl } from '@/core/platforms';
import { isCapturablePage } from '@/core/page-scope';
import { exportManager } from './export';
import { runtimeStatusStore } from './runtime-status';
import { localStoreRepository } from './repository/local-store-repository';
import { snippetRepository } from './repository/snippet-repository';
import { localStoreClient } from './local-store-client';
import { localStoreMigrator } from './migration/local-store-migrator';
import { getLocalStoreMeta, updateLocalStoreMeta } from './local-store-meta';
import { localStoreSyncService } from './local-store-sync-service';
import {
  everMemOSClient,
  type ImportResult,
  type BrowserSyncStatus,
} from './evermemos-client';
import { notifyConversationUpdated } from './myisland-client';
import {
  explainSelectedText,
  translatePageTextItems,
  type PageTranslationRequest,
  type PageTranslationResult,
} from '@/translation/service';
import {
  loadLocalCredentialPrefill,
  resolveLlmCredentialPrefill,
} from '@/popup/local-credential-prefill';

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * 消息处理器
 */
export class MessageHandlers {
  /**
   * 处理连接数据库请求
   */
  async handleConnectDB(): Promise<void> {
    Logger.info('[MessageHandlers] 处理连接数据库请求');
    // Local Store Service 会在首次请求时自动连接
  }

  /**
   * 处理根据 URL 查找会话
   */
  async handleFindConversationByUrl(url: string): Promise<Conversation | null> {
    Logger.info('[MessageHandlers] 根据 URL 查找会话:', url);
    return await localStoreRepository.findConversationByUrl(url);
  }

  /**
   * 处理创建会话
   */
  async handleCreateConversation(
    conversation: Partial<Conversation>
  ): Promise<string> {
    Logger.info('[MessageHandlers] 创建会话:', conversation.conversationId);

    const conversationId = await localStoreRepository.createConversation(conversation);

    // 通知侧边栏刷新
    this.notifySidebarRefresh();

    // 推送到 MyIsland
    notifyConversationUpdated(conversation as any);

    return conversationId;
  }

  /**
   * 处理更新会话
   */
  async handleUpdateConversation(
    conversation: Partial<Conversation>
  ): Promise<void> {
    Logger.info('[MessageHandlers] 更新会话:', conversation.conversationId);

    await localStoreRepository.updateConversation(conversation);

    // 通知侧边栏刷新
    this.notifySidebarRefresh();

    // 推送到 MyIsland
    notifyConversationUpdated(conversation as any);
  }

  /**
   * 处理根据 ID 获取会话
   */
  async handleGetConversationById(
    conversationId: string
  ): Promise<Conversation | null> {
    Logger.info('[MessageHandlers] 获取会话:', conversationId);
    return await localStoreRepository.getConversationById(conversationId);
  }

  /**
   * 处理获取所有会话
   */
  async handleGetAllConversations(): Promise<Conversation[]> {
    Logger.info('[MessageHandlers] 获取所有会话');
    return await localStoreRepository.getAllConversations();
  }

  /**
   * 处理按 ID 批量获取会话（导出/筛选使用）
   */
  async handleGetConversationsByIds(
    conversationIds: string[]
  ): Promise<Conversation[]> {
    Logger.info('[MessageHandlers] 批量获取会话:', conversationIds.length);
    return await localStoreRepository.getConversationsByIds(conversationIds || []);
  }

  /**
   * 处理删除会话
   */
  async handleDeleteConversation(conversationId: string): Promise<void> {
    Logger.info('[MessageHandlers] 删除会话:', conversationId);

    await localStoreRepository.deleteConversation(conversationId);

    // 通知侧边栏刷新
    this.notifySidebarRefresh();
  }

  /**
   * 处理获取存储使用情况
   */
  async handleGetStorageUsage(): Promise<{
    totalConversations: number;
    todayNewConversations: number;
  }> {
    Logger.info('[MessageHandlers] 获取存储使用情况');
    return await localStoreRepository.getStorageUsage();
  }

  /**
   * 处理更新设置
   */
  async handleUpdateSettings(settings: any): Promise<void> {
    Logger.info('[MessageHandlers] 更新设置:', settings);

    const currentSettings = (await this.handleGetSettings()) as AppSettings;
    const nextSettings = this.mergeSettings(currentSettings, settings || {});

    await chrome.storage.sync.set({ settings: nextSettings });

    // 通知所有内容脚本设置已更新
    this.notifySettingsUpdated(nextSettings);
  }

  /**
   * 处理获取设置
   */
  async handleGetSettings(): Promise<any> {
    Logger.info('[MessageHandlers] 获取设置');

    return new Promise((resolve, reject) => {
      chrome.storage.sync.get(['settings'], (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(this.mergeSettings(APP_DEFAULT_SETTINGS, result.settings || {}));
        }
      });
    });
  }

  /**
   * 当用户尚未手动保存 LLM API Key 时，回退到 local-prefill.json 中预设的凭据，
   * 让沉浸式翻译等功能开箱即用。已保存的 Key 始终优先。
   */
  private async resolveLlmSettings(settings: AppSettings): Promise<AppSettings> {
    if (settings.llmApi?.apiKey) {
      return settings;
    }

    const prefill = await loadLocalCredentialPrefill();
    if (!prefill.llmApi?.apiKey) {
      return settings;
    }

    return {
      ...settings,
      llmApi: resolveLlmCredentialPrefill(settings.llmApi, prefill.llmApi),
    };
  }

  async handleTranslatePageText(
    request: PageTranslationRequest
  ): Promise<PageTranslationResult> {
    Logger.info('[MessageHandlers] 翻译网页文本:', {
      count: request.items.length,
      targetLanguage: request.targetLanguage,
    });

    const settings = await this.resolveLlmSettings(
      (await this.handleGetSettings()) as AppSettings
    );
    return translatePageTextItems({
      settings,
      request,
    });
  }

  async handleExplainText(request: {
    text: string;
    targetLanguage: string;
  }): Promise<{ explanation: string }> {
    Logger.info('[MessageHandlers] 解释选中文本:', {
      length: request.text.length,
      targetLanguage: request.targetLanguage,
    });

    const settings = await this.resolveLlmSettings(
      (await this.handleGetSettings()) as AppSettings
    );
    return explainSelectedText({
      settings,
      text: request.text,
      targetLanguage: request.targetLanguage || 'zh-CN',
    });
  }

  /**
   * 处理导出对话
   */
  async handleExportConversations(params: {
    conversationIds: string[];
    exportType: 'separate' | 'merged';
    metadata?: any;
  }): Promise<string | null> {
    Logger.info('[MessageHandlers] 导出对话:', {
      count: params.conversationIds.length,
      type: params.exportType,
    });

    // 获取对话数据（用于前置校验）
    const conversations = await localStoreRepository.getConversationsByIds(params.conversationIds || []);

    if (conversations.length === 0) {
      return null;
    }

    // 导出对话
    return await exportManager.exportConversations(
      params.conversationIds,
      params.exportType,
      params.metadata || {}
    );
  }

  /**
   * 处理清空存储
   */
  async handleClearStorage(): Promise<void> {
    Logger.info('[MessageHandlers] 清空存储');
    await localStoreRepository.clearAllConversations();
    this.notifySidebarRefresh();
  }

  async handleUpsertSnippet(snippet: SnippetInput): Promise<Snippet> {
    Logger.info('[MessageHandlers] 保存片段:', {
      type: snippet?.type,
      sourceKind: snippet?.sourceKind,
      url: snippet?.url,
    });

    const saved = await snippetRepository.upsertSnippet(snippet);
    this.notifySidebarRefresh();
    return saved;
  }

  async handleSaveMediaSnippet(input: SaveMediaSnippetInput): Promise<SnippetGroupDetail | null> {
    Logger.info('[MessageHandlers] 保存媒体片段:', {
      url: input?.snippet?.url,
      sourceKind: input?.snippet?.sourceKind,
      mediaKind: input?.snippet?.media?.kind,
      sourceUrl: input?.snippet?.media?.sourceUrl,
    });

    const saved = await snippetRepository.saveMediaSnippet(input);
    this.notifySidebarRefresh();
    return saved;
  }

  async handleUpsertSnippetSelection(
    selection: SnippetSelectionInput
  ): Promise<SnippetSelectionUpsertResult> {
    Logger.info('[MessageHandlers] 保存划词片段:', {
      url: selection?.url,
      sourceKind: selection?.sourceKind,
      semanticBlockKey: selection?.semanticBlockKey,
    });

    const saved = await snippetRepository.upsertSnippetSelection(selection);
    this.notifySidebarRefresh();
    return saved;
  }

  async handleGetAllSnippets(): Promise<Snippet[]> {
    return snippetRepository.getAllSnippets();
  }

  async handleGetSnippetById(id: string): Promise<Snippet | null> {
    return snippetRepository.getSnippetById(id);
  }

  async handleGetSnippetGroupById(id: string): Promise<SnippetGroupDetail | null> {
    return snippetRepository.getSnippetGroupById(id);
  }

  async handleGetSnippetsByUrl(url: string): Promise<SnippetGroupDetail[]> {
    return snippetRepository.getSnippetsByUrl(url);
  }

  async handleMergeSnippets(input: SnippetMergeInput): Promise<SnippetGroupDetail | null> {
    const merged = await snippetRepository.mergeSnippets(input);
    this.notifySidebarRefresh();
    return merged;
  }

  async handleDeleteSnippet(id: string): Promise<void> {
    await snippetRepository.deleteSnippet(id);
    this.notifySidebarRefresh();
  }

  async handleDeleteSnippetItem(id: string): Promise<void> {
    await snippetRepository.deleteSnippetItem(id);
    this.notifySidebarRefresh();
  }

  async handleClearSnippets(): Promise<void> {
    await snippetRepository.clearSnippets();
    this.notifySidebarRefresh();
  }

  async handleGetSnippetStatusForTab(url: string): Promise<SnippetStatus> {
    return snippetRepository.getSnippetStatusForTab(url);
  }

  async handleEnrichSnippet(id: string): Promise<SnippetGroupDetail | null> {
    const enriched = await snippetRepository.enrichSnippet(id);
    this.notifySidebarRefresh();
    return enriched;
  }

  /**
   * 处理打开侧边栏
   */
  async handleOpenSidePanel(sender: chrome.runtime.MessageSender): Promise<void> {
    Logger.info('[MessageHandlers] 处理打开侧边栏请求');

    // 检查是否在支持的页面
    if (sender.tab && sender.tab.id) {
      // 发送消息给 content script 打开注入式侧边栏
      await chrome.tabs.sendMessage(sender.tab.id, {
        type: 'toggleSidebar',
      });
    } else {
      throw ErrorFactory.runtime('无法获取当前标签页信息');
    }
  }

  /**
   * 处理手动保存请求（T05 协议占位，T06 接入真实保存链路）
   */
  async handleManualSave(params: { url?: string }): Promise<{ accepted: boolean; url?: string }> {
    Logger.info('[MessageHandlers] 手动保存请求已接收:', params?.url);
    return {
      accepted: true,
      url: params?.url,
    };
  }

  /**
   * 处理增量更新
   */
  async handleIncrementalUpdate(params: {
    conversationId: string;
    changes: MessageChanges;
  }): Promise<IncrementalUpdateResult> {
    Logger.info('[MessageHandlers] 处理增量更新:', params.conversationId);

    const conversation = await localStoreRepository.getConversationById(params.conversationId);
    if (!conversation) {
      throw ErrorFactory.storage('对话不存在', `conversationId: ${params.conversationId}`);
    }

    if (!this.hasRealMessageChanges(params.changes)) {
      return {
        success: true,
        conversation,
        skipped: true,
      };
    }

    const removedIds = new Set((params.changes.removedMessages || []).map((message) => message.messageId));
    const updatedMap = new Map((params.changes.updatedMessages || []).map((message) => [message.messageId, message]));

    const retainedMessages = (conversation.messages || [])
      .filter((message) => !removedIds.has(message.messageId))
      .map((message) => updatedMap.get(message.messageId) || message);

    const nextMessages = normalizeAndDedupeMessages([
      ...retainedMessages,
      ...(params.changes.newMessages || []),
    ]);

    const updatedConversation = this.withUpdatedConversationMetadata(conversation, nextMessages);
    await localStoreRepository.updateConversation(updatedConversation);

    this.notifySidebarRefresh();
    notifyConversationUpdated(updatedConversation as any);

    return {
      success: true,
      conversation: updatedConversation,
    };
  }

  /**
   * 处理智能增量更新
   */
  async handleSmartIncrementalUpdate(params: {
    conversationId: string;
    currentMessages: Message[];
  }): Promise<IncrementalUpdateResult> {
    Logger.info('[MessageHandlers] 处理智能增量更新:', params.conversationId);

    if (!Array.isArray(params.currentMessages)) {
      throw new Error('currentMessages must be an array');
    }

    const conversation = await localStoreRepository.getConversationById(params.conversationId);
    if (!conversation) {
      throw ErrorFactory.storage('对话不存在', `conversationId: ${params.conversationId}`);
    }

    if (!params.currentMessages.length) {
      return {
        success: true,
        conversation,
        skipped: true,
      };
    }

    const nextMessages = normalizeAndDedupeMessages(params.currentMessages || []);
    const storedSignature = this.buildMessageSignature(conversation.messages || []);
    const nextSignature = this.buildMessageSignature(nextMessages);

    if (storedSignature === nextSignature) {
      return {
        success: true,
        conversation,
        skipped: true,
      };
    }

    const updatedConversation = this.withUpdatedConversationMetadata(conversation, nextMessages);
    await localStoreRepository.updateConversation(updatedConversation);
    this.notifySidebarRefresh();
    notifyConversationUpdated(updatedConversation as any);

    return {
      success: true,
      conversation: updatedConversation,
      fullOverwrite: true,
      anchor: false,
    };
  }

  /**
   * 处理获取会话
   */
  async handleGetConversation(conversationId: string): Promise<Conversation | null> {
    Logger.info('[MessageHandlers] 获取会话:', conversationId);
    return await localStoreRepository.getConversationById(conversationId);
  }

  /**
   * 处理获取 Local Store 状态
   */
  async handleGetLocalStoreStatus(): Promise<LocalStoreStatus> {
    const meta = await getLocalStoreMeta();
    const status = await localStoreSyncService.getStatus();

    return {
      enabled: meta.local_store_enabled,
      connected: status.connected,
      fallbackMode: status.fallbackMode,
      pendingOpsCount: status.pendingOpsCount,
      version: status.version,
      path: status.path || meta.local_store_path,
      migrationState: meta.local_store_migration_state,
      lastError: status.lastError,
      lastMigratedAt: meta.local_store_last_migrated_at,
      lastSyncAt: status.lastSyncAt,
    };
  }

  /**
   * 处理设置 Local Store 路径
   */
  async handleSetLocalStorePath(path: string): Promise<LocalStoreStatus> {
    const nextPath = (path || '').trim();
    if (!nextPath) {
      throw new Error('local store path is required');
    }

    await localStoreClient.setDataPath(nextPath);

    await updateLocalStoreMeta({
      local_store_path: nextPath,
      local_store_last_error: '',
      local_store_migration_state: 'pending',
    });

    return this.handleGetLocalStoreStatus();
  }

  /**
   * 处理手动触发 Local Store 迁移
   */
  async handleStartLocalStoreMigration(): Promise<{
    state: string;
    lastError?: string;
    lastMigratedAt?: string;
  }> {
    await localStoreMigrator.startMigration(true);
    const meta = await getLocalStoreMeta();

    return {
      state: meta.local_store_migration_state,
      lastError: meta.local_store_last_error,
      lastMigratedAt: meta.local_store_last_migrated_at,
    };
  }

  /**
   * 获取 Local Store 迁移状态
   */
  async handleGetLocalStoreMigrationState(): Promise<{
    state: string;
    lastError?: string;
    lastMigratedAt?: string;
  }> {
    const meta = await getLocalStoreMeta();

    return {
      state: meta.local_store_migration_state,
      lastError: meta.local_store_last_error,
      lastMigratedAt: meta.local_store_last_migrated_at,
    };
  }

  /**
   * 处理内容脚本运行态上报
   */
  async handleReportContentRuntime(
    params: {
      tabId?: number;
      url?: string;
      injected?: boolean;
      lastExtractAt?: string;
      lastSaveAt?: string;
      lastError?: string;
    },
    sender: chrome.runtime.MessageSender
  ): Promise<TabRuntimeStatus | null> {
    const tabId = sender.tab?.id ?? params.tabId;
    if (typeof tabId !== 'number') {
      Logger.warn('[MessageHandlers] 运行态上报缺少 tabId');
      return null;
    }

    const url = params.url || sender.tab?.url || '';
    const platform = getPlatformFromUrl(url);
    const injectable = this.isInjectablePage(url);

    const status = runtimeStatusStore.upsert(
      tabId,
      {
        url,
        platform,
        injectable,
      },
      {
        url,
        platform,
        injectable,
        injected: params.injected ?? true,
        lastSeenAt: new Date().toISOString(),
        lastExtractAt: params.lastExtractAt,
        lastSaveAt: params.lastSaveAt,
        lastError: params.lastError,
      }
    );

    return status;
  }

  /**
   * 获取标签页运行态诊断信息
   */
  async handleGetTabRuntimeStatus(
    params: { tabId?: number },
    sender: chrome.runtime.MessageSender
  ): Promise<TabRuntimeStatus | null> {
    const tabId = params.tabId ?? sender.tab?.id;
    if (typeof tabId !== 'number') {
      return null;
    }

    return runtimeStatusStore.get(tabId);
  }

  /**
   * 清理标签页运行态（标签页关闭时调用）
   */
  handleClearTabRuntimeStatus(tabId: number): void {
    runtimeStatusStore.clearTab(tabId);
  }

  /**
   * 通知侧边栏刷新
   */
  private notifySidebarRefresh(): void {
    Logger.info('[MessageHandlers] 通知侧边栏刷新');

    // 使用 storage change 事件来通知刷新
    chrome.storage.local.set({
      sidebar_refresh_trigger: Date.now(),
    });

    // 触发事件总线事件
    eventBus.publish('sidebar:refresh', {});
  }

  /**
   * 通知所有内容脚本设置已更新
   */
  private notifySettingsUpdated(settings: any): void {
    Logger.info('[MessageHandlers] 通知设置已更新');

    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        // 过滤出支持注入的页面
        if (tab.url && this.isInjectablePage(tab.url)) {
          chrome.tabs
            .sendMessage(tab.id!, {
              type: 'settingsUpdated',
              settings,
            })
            .catch((error) => {
              // 未注入/已关闭的标签页投递失败属预期；记 debug 以便排查异常投递。
              Logger.debug('[MessageHandlers] settingsUpdated 投递标签页失败', {
                tabId: tab.id,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        }
      });
    });

    // 同时发送给所有扩展视图（如 popup 或 side panel iframe）
    try {
      chrome.runtime
        .sendMessage({
          type: 'settingsUpdated',
          settings,
        })
        .catch((error) => {
          // 无接收端（popup/side panel 未打开）属预期；记 debug。
          Logger.debug('[MessageHandlers] settingsUpdated 广播失败', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    } catch (error) {
      Logger.debug('[MessageHandlers] settingsUpdated 广播抛错', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 检查 URL 是否支持内容脚本注入
   */
  private isInjectablePage(url: string): boolean {
    return isCapturablePage(url);
  }

  private mergeSettings(current: AppSettings, partial: Partial<AppSettings>): AppSettings {
    return {
      ...APP_DEFAULT_SETTINGS,
      ...(current || {}),
      ...(partial || {}),
      floatTag: {
        ...(APP_DEFAULT_SETTINGS.floatTag || {}),
        ...((current || {}).floatTag || {}),
        ...((partial || {}).floatTag || {}),
      },
      localStore: {
        ...((APP_DEFAULT_SETTINGS.localStore || {}) as Record<string, unknown>),
        ...(((current || {}).localStore || {}) as Record<string, unknown>),
        ...(((partial || {}).localStore || {}) as Record<string, unknown>),
      } as AppSettings['localStore'],
      webCapture: {
        ...(APP_DEFAULT_SETTINGS.webCapture || {}),
        ...((current || {}).webCapture || {}),
        ...((partial || {}).webCapture || {}),
      } as NonNullable<AppSettings['webCapture']>,
      immersiveTranslation: {
        ...(APP_DEFAULT_SETTINGS.immersiveTranslation || {}),
        ...((current || {}).immersiveTranslation || {}),
        ...((partial || {}).immersiveTranslation || {}),
      } as NonNullable<AppSettings['immersiveTranslation']>,
      simultaneousInterpretation: {
        ...(APP_DEFAULT_SETTINGS.simultaneousInterpretation || {}),
        ...((current || {}).simultaneousInterpretation || {}),
        ...((partial || {}).simultaneousInterpretation || {}),
        credentials: {
          ...(APP_DEFAULT_SETTINGS.simultaneousInterpretation?.credentials || {}),
          ...((current || {}).simultaneousInterpretation?.credentials || {}),
          ...((partial || {}).simultaneousInterpretation?.credentials || {}),
        },
      } as NonNullable<AppSettings['simultaneousInterpretation']>,
    };
  }

  private hasRealMessageChanges(changes: MessageChanges): boolean {
    return !!(
      changes &&
      ((changes.newMessages || []).length > 0 ||
        (changes.updatedMessages || []).length > 0 ||
        (changes.removedMessages || []).length > 0)
    );
  }

  private withUpdatedConversationMetadata(
    conversation: Conversation,
    nextMessages: Message[]
  ): Conversation {
    const now = new Date().toISOString();
    const lastMessage = nextMessages[nextMessages.length - 1];

    return {
      ...conversation,
      messages: nextMessages,
      updatedAt: now,
      messageCount: nextMessages.length,
      lastMessageAt: lastMessage?.updatedAt || lastMessage?.createdAt || now,
      dataVersion: 2,
    };
  }

  private buildMessageSignature(messages: Message[]): string {
    if (!messages || messages.length === 0) {
      return 'empty';
    }

    const tail = messages.slice(-3).map((message) => {
      const id = message.messageId || 'no-id';
      const content = (message.content || '').slice(0, 48);
      return `${id}:${content}`;
    });

    return `${messages.length}|${tail.join('|')}`;
  }

  // ==========================================================================
  // EverMemOS Export Handlers
  // ==========================================================================

  /**
   * Export a single conversation to EverMemOS
   */
  async handleExportConversationToEverMemOS(conversationId: string): Promise<ImportResult> {
    Logger.info('[MessageHandlers] Exporting conversation to EverMemOS:', conversationId);

    const conversation = await localStoreRepository.getConversationById(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const result = await everMemOSClient.importConversation(conversation);

    Logger.info('[MessageHandlers] EverMemOS export completed:', {
      conversationId,
      importedCount: result.imported_count,
      extractedMemories: result.extracted_memories,
      groupId: result.group_id,
    });

    return result;
  }

  /**
   * Export multiple conversations to EverMemOS
   */
  async handleExportConversationsToEverMemOS(conversationIds: string[]): Promise<ImportResult[]> {
    Logger.info('[MessageHandlers] Exporting conversations to EverMemOS:', conversationIds.length);

    const conversations = await localStoreRepository.getConversationsByIds(conversationIds);
    if (conversations.length === 0) {
      throw new Error('No conversations found');
    }

    const results = await everMemOSClient.importConversations(conversations);

    const successCount = results.filter((r) => r.status === 'completed').length;
    Logger.info('[MessageHandlers] EverMemOS batch export completed:', {
      total: conversations.length,
      success: successCount,
      failed: conversations.length - successCount,
    });

    return results;
  }

  /**
   * Export a single snippet to EverMemOS
   */
  async handleExportSnippetToEverMemOS(snippetId: string): Promise<ImportResult> {
    Logger.info('[MessageHandlers] Exporting snippet to EverMemOS:', snippetId);

    const snippet = await snippetRepository.getSnippetGroupById(snippetId);
    if (!snippet || !snippet.group) {
      throw new Error(`Snippet not found: ${snippetId}`);
    }

    const result = await everMemOSClient.importSnippet(snippet.group);

    Logger.info('[MessageHandlers] EverMemOS snippet export completed:', {
      snippetId,
      importedCount: result.imported_count,
      extractedMemories: result.extracted_memories,
    });

    return result;
  }

  /**
   * Export multiple snippets to EverMemOS
   */
  async handleExportSnippetsToEverMemOS(snippetIds: string[]): Promise<ImportResult[]> {
    Logger.info('[MessageHandlers] Exporting snippets to EverMemOS:', snippetIds.length);

    const results: ImportResult[] = [];

    for (const snippetId of snippetIds) {
      try {
        const snippetDetail = await snippetRepository.getSnippetGroupById(snippetId);
        if (snippetDetail?.group) {
          const result = await everMemOSClient.importSnippet(snippetDetail.group);
          results.push(result);
        } else {
          results.push({
            imported_count: 0,
            extracted_memories: 0,
            group_id: '',
            status: 'failed',
          });
        }
      } catch (error) {
        Logger.error('[MessageHandlers] Failed to export snippet:', snippetId, error);
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
   * Check EverMemOS connection status
   */
  async handleGetEverMemOSStatus(baseUrl?: string): Promise<{
    connected: boolean;
    version?: string;
    baseUrl: string;
    lastError?: string;
  }> {
    if (baseUrl) {
      everMemOSClient.setBaseUrl(baseUrl);
    }

    return everMemOSClient.checkStatus();
  }

  async handleGetBrowserSyncStatus(): Promise<BrowserSyncStatus> {
    return everMemOSClient.getBrowserSyncStatus();
  }

  /**
   * Set EverMemOS base URL
   */
  async handleSetEverMemOSBaseUrl(baseUrl: string): Promise<void> {
    everMemOSClient.setBaseUrl(baseUrl);
    Logger.info('[MessageHandlers] EverMemOS base URL updated:', baseUrl);
  }
}

// 导出单例
export const messageHandlers = new MessageHandlers();
