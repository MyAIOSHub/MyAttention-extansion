/**
 * 内容脚本入口点
 * 负责初始化所有内容功能：悬浮标签、侧边栏、平台适配器
 */

import type {
  AppSettings,
  PlatformName,
  PlatformAdapter,
  Conversation,
  Message,
  ChromeMessageResponse,
} from '@/types';
import {
  isSupportedPlatform,
  getPlatformFromUrl,
  loadSettingsFromStorage,
  updateGlobalSettings,
  getCurrentSettings,
  safeInit,
} from '@/content/common';
import { isCapturablePage } from '@/core/page-scope';
import { initSimulcastVideoSyncListener } from '@/content/simulcast-video-sync';
import { initSimulcastSubtitleOverlayListener } from '@/content/simulcast-subtitle-overlay';
import {
  initFloatTag,
  updateFloatTagState,
  showSuccessStatus,
  cleanupFloatTags,
} from '@/content/float-tag';
import {
  createSidebar,
  toggleSidebar,
  cleanupSidebar,
  initSidebarMessageListener,
} from '@/content/sidebar';
import { chatgptAdapter } from '@/adapters/chatgpt';
import { claudeAdapter } from '@/adapters/claude';
import { deepseekAdapter } from '@/adapters/deepseek';
import { geminiAdapter } from '@/adapters/gemini';
import { qwenAdapter } from '@/adapters/qwen';
import { doubaoAdapter } from '@/adapters/doubao';
import { yuanbaoAdapter } from '@/adapters/yuanbao';
import { kimiAdapter } from '@/adapters/kimi';
import { eventBus } from '@/core/event-bus';
import {
  chromeMessageAdapter,
  isExtensionContextInvalidatedError,
  isRuntimeContextAvailable,
} from '@/core/chrome-message';
import { isTopLevelFrame } from '@/content/frame-scope';
import { Logger } from '@/core/errors';
import { createSnippetCaptureController } from '@/content/snippets/snippet-capture-controller';
import { createMediaHoverController } from '@/content/media/media-hover-controller';
import {
  clearPageTranslations,
  collectPageTranslationRequest,
  renderPageTranslations,
  runBatchedTranslation,
} from '@/translation/page-translator';
import {
  createSelectionTranslationToolbar,
  type SelectionTranslationToolbar,
} from '@/translation/selection-toolbar';
import type { TranslationMode, TranslationRange } from '@/translation/config';

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 平台适配器映射
 */
const ADAPTERS: Record<PlatformName, PlatformAdapter> = {
  chatgpt: chatgptAdapter,
  claude: claudeAdapter,
  deepseek: deepseekAdapter,
  gemini: geminiAdapter,
  qwen: qwenAdapter,
  doubao: doubaoAdapter,
  yuanbao: yuanbaoAdapter,
  kimi: kimiAdapter,
} as const;

// ============================================================================
// 全局变量
// ============================================================================

/**
 * 当前激活的适配器
 */
let activeAdapter: PlatformAdapter | null = null;

/**
 * URL 变化监听器
 */
let urlChangeListener: (() => void) | null = null;
let snippetCaptureController:
  | ReturnType<typeof createSnippetCaptureController>
  | null = null;
let mediaHoverController:
  | ReturnType<typeof createMediaHoverController>
  | null = null;
let selectionTranslationToolbar: SelectionTranslationToolbar | null = null;
let hasInitializedPageTranslationListener = false;

/**
 * 自动保存稳定窗口（毫秒）
 */
const AUTO_SAVE_STABLE_MS = 1200;

/**
 * 自动保存队列状态（T06 通用链路）
 */
let pendingSaveRequest:
  | {
      platform: PlatformName;
      messages: Message[];
      source: 'auto' | 'manual';
    }
  | null = null;
let pendingSaveTimer: number | null = null;
let isSavingConversation = false;
const lastSavedSignatureByUrl = new Map<string, string>();
const SAVE_TRACE_ENABLED = !!import.meta.env?.DEV;
let hasRuntimeContextInvalidated = false;
let hasInstalledGlobalErrorGuard = false;
let contentLastSaveAt: string | undefined;

interface RuntimeStatusReportPayload {
  injected?: boolean;
  lastExtractAt?: string;
  lastSaveAt?: string;
  lastError?: string | null;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function traceSave(stage: string, data: Record<string, unknown>): void {
  if (!SAVE_TRACE_ENABLED) {
    return;
  }
  Logger.info(`[Content][Trace] ${stage}`, data);
}

function handleRuntimeContextInvalidated(source: string, error: unknown): boolean {
  if (!isExtensionContextInvalidatedError(error)) {
    return false;
  }

  if (!hasRuntimeContextInvalidated) {
    hasRuntimeContextInvalidated = true;
    if (pendingSaveTimer) {
      clearTimeout(pendingSaveTimer);
      pendingSaveTimer = null;
    }
    pendingSaveRequest = null;
    Logger.warn(
      `[Content] ${source}失败：扩展上下文已失效，已暂停保存。为避免打断当前页面，不会自动刷新。`
    );
  }
  Logger.debug(`[Content] ${source}上下文失效详情:`, error);
  return true;
}

function installGlobalErrorGuard(): void {
  if (hasInstalledGlobalErrorGuard) {
    return;
  }
  hasInstalledGlobalErrorGuard = true;

  window.addEventListener('error', (event) => {
    const error = event.error ?? event.message;
    if (!handleRuntimeContextInvalidated('全局错误', error)) {
      return;
    }
    event.preventDefault();
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (!handleRuntimeContextInvalidated('未处理 Promise 异常', event.reason)) {
      return;
    }
    event.preventDefault();
  });
}

function reportRuntimeStatus(payload: RuntimeStatusReportPayload): void {
  if (payload.lastSaveAt) {
    contentLastSaveAt = payload.lastSaveAt;
  }
  if (hasRuntimeContextInvalidated || !isRuntimeContextAvailable()) {
    return;
  }

  void chromeMessageAdapter.sendMessage({
    type: 'reportContentRuntime',
    url: window.location.href,
    injected: payload.injected ?? true,
    lastExtractAt: payload.lastExtractAt,
    lastSaveAt: payload.lastSaveAt,
    lastError: payload.lastError,
  }).catch((error) => {
    if (handleRuntimeContextInvalidated('运行态上报', error)) {
      return;
    }
    Logger.debug('[Content] 运行态上报失败:', error);
  });
}

function validateFloatTagVisibility(): void {
  window.setTimeout(() => {
    const node = document.querySelector('.sayso-float') as HTMLElement | null;
    if (!node) {
      reportRuntimeStatus({ lastError: 'FLOAT_TAG_INIT_FAILED' });
      return;
    }

    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0';

    if (!visible) {
      reportRuntimeStatus({ lastError: 'FLOAT_TAG_INIT_FAILED' });
      return;
    }

    reportRuntimeStatus({ lastError: null });
  }, 500);
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 获取当前 URL 的平台配置
 */
function getCurrentPlatformConfig(): PlatformName | null {
  const currentUrl = window.location.href;
  return getPlatformFromUrl(currentUrl);
}

/**
 * 激活平台适配器
 */
function activatePlatform(platform: PlatformName): void {
  // 如果已有激活的适配器，先停止
  if (activeAdapter) {
    Logger.info('[Content] 停止当前适配器:', activeAdapter.platform);
    activeAdapter.stop?.();
  }

  // 获取新适配器
  const adapter = ADAPTERS[platform];

  if (!adapter) {
    Logger.error('[Content] 未找到平台适配器:', platform);
    return;
  }

  // 启动新适配器
  Logger.info('[Content] 激活平台适配器:', platform);
  activeAdapter = adapter;
  adapter.start?.();
}

/**
 * 停用平台适配器
 */
function deactivatePlatform(): void {
  if (activeAdapter) {
    Logger.info('[Content] 停用平台适配器:', activeAdapter.platform);
    activeAdapter.stop?.();
    activeAdapter = null;
  }
}

/**
 * 检查并切换平台
 */
function checkAndSwitchPlatform(): void {
  const currentUrl = window.location.href;
  const currentPlatform = getPlatformFromUrl(currentUrl);

  if (!currentPlatform) {
    Logger.debug('[Content] 当前 URL 不在支持的平台列表中');
    deactivatePlatform();
    snippetCaptureController?.refreshForUrlChange();
    mediaHoverController?.refreshForUrlChange();
    return;
  }

  if (activeAdapter && activeAdapter.platform !== currentPlatform) {
    Logger.info('[Content] 平台切换:', activeAdapter.platform, '->', currentPlatform);
    activatePlatform(currentPlatform);
  } else if (!activeAdapter) {
    Logger.info('[Content] 激活初始平台:', currentPlatform);
    activatePlatform(currentPlatform);
  }

  snippetCaptureController?.refreshForUrlChange();
  mediaHoverController?.refreshForUrlChange();
}

/**
 * 监听 URL 变化
 */
function startUrlMonitoring(): void {
  let lastUrl = window.location.href;

  urlChangeListener = () => {
    const currentUrl = window.location.href;

    if (currentUrl !== lastUrl) {
      Logger.info('[Content] URL 变化:', lastUrl, '->', currentUrl);
      lastUrl = currentUrl;

      checkAndSwitchPlatform();
    }
  };

  // 使用 MutationObserver 监听 URL 变化（SPA 导航）
  const observer = new MutationObserver(() => {
    urlChangeListener?.();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // 监听 popstate 事件（浏览器前进/后退）
  window.addEventListener('popstate', urlChangeListener);

  // 监听 hashchange 事件（hash 变化）
  window.addEventListener('hashchange', urlChangeListener);

  Logger.info('[Content] URL 监听已启动');
}

/**
 * 停止 URL 监听
 */
function stopUrlMonitoring(): void {
  if (urlChangeListener) {
    window.removeEventListener('popstate', urlChangeListener);
    window.removeEventListener('hashchange', urlChangeListener);
    urlChangeListener = null;
  }

  Logger.info('[Content] URL 监听已停止');
}

/**
 * 清洗 URL（用于会话匹配和去重）
 */
function cleanConversationUrl(url: string): string {
  return url.split('#')[0].split('?')[0];
}

/**
 * 兼容提取适配器返回的会话信息结构
 */
function normalizeConversationInfo(
  adapter: PlatformAdapter,
  url: string
): { conversationId: string | null; isNewConversation: boolean } {
  const raw = adapter.extractConversationInfo(url) as any;

  if (raw?.conversationInfo) {
    return {
      conversationId: raw.conversationInfo.conversationId ?? null,
      isNewConversation: !!raw.conversationInfo.isNewConversation,
    };
  }

  return {
    conversationId: raw?.conversationId ?? null,
    isNewConversation: !!raw?.isNewConversation,
  };
}

function normalizeMessageSender(sender: Message['sender']): 'user' | 'assistant' {
  return sender === 'user' ? 'user' : 'assistant';
}

function normalizeMessagesForStorage(messages: Message[]): Message[] {
  return messages.map((message, index) => ({
    ...message,
    sender: normalizeMessageSender(message.sender),
    position: Number.isFinite(message.position) ? message.position : index,
    content: message.content || '',
    thinking: message.thinking || '',
    createdAt: message.createdAt || new Date().toISOString(),
    updatedAt: message.updatedAt || new Date().toISOString(),
  }));
}

function buildMessageSignature(messages: Message[]): string {
  if (!messages.length) {
    return 'empty';
  }

  const tail = messages.slice(-3).map((m) => `${m.messageId}:${m.content.slice(0, 48)}`);
  return `${messages.length}|${tail.join('|')}`;
}

function buildConversationId(
  platform: PlatformName,
  cleanUrl: string,
  externalId: string | null
): string {
  if (externalId) {
    return `${platform}_${externalId}`.replace(/[^\w-]/g, '_');
  }

  const safeUrl = cleanUrl.replace(/^https?:\/\//, '').replace(/[^\w-]/g, '_');
  return `${platform}_${safeUrl}`.slice(0, 180);
}

function getConversationTitle(adapter: PlatformAdapter): string {
  try {
    return adapter.extractTitle?.() || document.title || '新对话';
  } catch {
    return document.title || '新对话';
  }
}

function getResponseField<T>(
  response: ChromeMessageResponse<any>,
  field: string
): T | undefined {
  if (!response) {
    return undefined;
  }
  if ((response as any)[field] !== undefined) {
    return (response as any)[field] as T;
  }
  if (response.data && (response.data as any)[field] !== undefined) {
    return (response.data as any)[field] as T;
  }
  return undefined;
}

async function persistConversationSnapshot(
  platform: PlatformName,
  rawMessages: Message[],
  source: 'auto' | 'manual'
): Promise<boolean> {
  if (hasRuntimeContextInvalidated) {
    return false;
  }

  if (!activeAdapter) {
    Logger.warn('[Content] 无激活适配器，跳过保存');
    return false;
  }

  const currentUrl = window.location.href;
  const cleanUrl = cleanConversationUrl(currentUrl);
  const normalizedMessages = normalizeMessagesForStorage(rawMessages);
  traceSave('extract', {
    platform,
    source,
    messageCount: normalizedMessages.length,
    url: cleanUrl,
  });

  if (normalizedMessages.length === 0) {
    Logger.debug('[Content] 无可保存消息，跳过');
    return false;
  }

  const signature = buildMessageSignature(normalizedMessages);
  const lastSignature = lastSavedSignatureByUrl.get(cleanUrl);
  if (source === 'auto' && lastSignature === signature) {
    Logger.debug('[Content] 消息签名未变化，跳过自动保存');
    return false;
  }

  const info = normalizeConversationInfo(activeAdapter, currentUrl);
  const externalId = info.conversationId;
  traceSave('signature', {
    platform,
    source,
    signature,
    externalId,
  });

  Logger.info('[Content] 开始保存对话快照:', {
    platform,
    source,
    messageCount: normalizedMessages.length,
    externalId,
  });

  const findResp = await chromeMessageAdapter.sendMessage({
    type: 'findConversationByUrl',
    url: cleanUrl,
  });
  traceSave('find/create', {
    platform,
    source,
    url: cleanUrl,
  });
  const existingConversation = getResponseField<Conversation | null>(findResp, 'conversation') || null;

  if (!existingConversation) {
    const conversationId = buildConversationId(platform, cleanUrl, externalId);
    await chromeMessageAdapter.sendMessage({
      type: 'createConversation',
      source,
      conversation: {
        conversationId,
        link: cleanUrl,
        platform,
        title: getConversationTitle(activeAdapter),
        messages: normalizedMessages,
        externalId,
      },
    });

    lastSavedSignatureByUrl.set(cleanUrl, signature);
    reportRuntimeStatus({
      lastSaveAt: new Date().toISOString(),
      lastError: null,
    });
    Logger.info('[Content] 已创建新会话:', conversationId);
    return true;
  }

  const smartResp = await chromeMessageAdapter.sendMessage({
    type: 'smartIncrementalUpdate',
    source,
    conversationId: existingConversation.conversationId,
    currentMessages: normalizedMessages,
  });
  traceSave('smartIncrementalUpdate', {
    platform,
    source,
    conversationId: existingConversation.conversationId,
  });

  const smartSuccess =
    getResponseField<boolean>(smartResp, 'success') ??
    (smartResp.status === 'ok' && !smartResp.error);

  if (!smartSuccess) {
    Logger.warn('[Content] 智能增量更新失败，回退到全量更新');
    traceSave('fallbackUpdate', {
      platform,
      source,
      conversationId: existingConversation.conversationId,
    });
    await chromeMessageAdapter.sendMessage({
      type: 'updateConversation',
      source,
      conversation: {
        ...existingConversation,
        link: cleanUrl,
        platform,
        title: existingConversation.title || getConversationTitle(activeAdapter),
        messages: normalizedMessages,
        externalId: existingConversation.externalId ?? externalId,
      },
    });
  }

  lastSavedSignatureByUrl.set(cleanUrl, signature);
  reportRuntimeStatus({
    lastSaveAt: new Date().toISOString(),
    lastError: null,
  });
  traceSave('saved', {
    platform,
    source,
    conversationId: existingConversation.conversationId,
  });
  Logger.info('[Content] 已更新会话:', existingConversation.conversationId);
  return true;
}

function flushPendingSave(): void {
  if (isSavingConversation || !pendingSaveRequest) {
    return;
  }

  const request = pendingSaveRequest;
  pendingSaveRequest = null;
  isSavingConversation = true;

  void persistConversationSnapshot(request.platform, request.messages, request.source)
    .then((saved) => {
      if (request.source === 'manual' && saved) {
        showSuccessStatus();
      }
    })
    .catch((error) => {
      if (handleRuntimeContextInvalidated('保存对话快照', error)) {
        return;
      }
      Logger.error('[Content] 保存对话快照失败:', error);
      reportRuntimeStatus({
        lastError: stringifyError(error),
      });
    })
    .finally(() => {
      isSavingConversation = false;
      if (pendingSaveRequest && !hasRuntimeContextInvalidated) {
        // 保存期间有新请求，立即继续处理最新快照
        flushPendingSave();
      }
    });
}

function scheduleConversationSave(
  platform: PlatformName,
  messages: Message[],
  source: 'auto' | 'manual' = 'auto'
): void {
  if (hasRuntimeContextInvalidated) {
    return;
  }

  const settings = getCurrentSettings();
  if (source === 'auto' && !settings.autoSave) {
    Logger.debug('[Content] 自动保存已关闭，跳过自动保存请求');
    return;
  }

  pendingSaveRequest = { platform, messages, source };

  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = null;
  }

  if (source === 'manual') {
    flushPendingSave();
    return;
  }

  pendingSaveTimer = window.setTimeout(() => {
    pendingSaveTimer = null;
    flushPendingSave();
  }, AUTO_SAVE_STABLE_MS);
}

// ============================================================================
// 事件处理
// ============================================================================

/**
 * 初始化设置监听
 */
function initSettingsListener(): void {
  if (!isRuntimeContextAvailable()) {
    handleRuntimeContextInvalidated('设置监听初始化', new Error('Extension context invalidated.'));
    return;
  }

  // 监听来自后台脚本的消息
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type !== 'settingsUpdated') {
        return undefined;
      }

      if (message.settings) {
        Logger.info('[Content] 收到设置更新:', message.settings);

        // 更新全局设置
        updateGlobalSettings(message.settings);

        // 更新悬浮标签状态
        updateFloatTagState();
        snippetCaptureController?.refreshForUrlChange();
        initSelectionTranslationToolbar();
      }

      sendResponse({ status: 'ok' });
      return true;
    });
  } catch (error) {
    if (handleRuntimeContextInvalidated('设置监听初始化', error)) {
      return;
    }
    throw error;
  }

  Logger.info('[Content] 设置监听已初始化');
}

/**
 * 初始化手动保存监听
 */
function initManualSaveListener(): void {
  // 监听手动保存事件
  window.addEventListener('sayso-manual-save', async () => {
    Logger.info('[Content] 收到手动保存请求');

    if (hasRuntimeContextInvalidated) {
      Logger.warn('[Content] 当前扩展上下文已失效，请刷新页面后重试');
      return;
    }

    // 检查扩展上下文是否有效
    if (!isRuntimeContextAvailable()) {
      Logger.error('[Content] 扩展上下文已失效');
      return;
    }

    const platform = getCurrentPlatformConfig();
    if (platform && activeAdapter) {
      try {
        const messages = activeAdapter.extractMessages();
        scheduleConversationSave(platform, messages, 'manual');
      } catch (error) {
        Logger.error('[Content] 手动保存提取失败:', error);
      }
    }

    // 保留协议通知（T05 已打通后台响应路径，T06 在内容脚本执行真实保存）
    chromeMessageAdapter.send({
      type: 'manualSave',
      url: window.location.href,
    });
  });

  Logger.info('[Content] 手动保存监听已初始化');
}

function initSnippetCaptureController(): void {
  if (snippetCaptureController) {
    snippetCaptureController.stop();
  }

  snippetCaptureController = createSnippetCaptureController({
    getSettings: () => getCurrentSettings(),
    getActiveAdapter: () => activeAdapter,
    getCurrentPlatform: () => getCurrentPlatformConfig(),
    onSnippetSaved: () => {
      reportRuntimeStatus({
        lastSaveAt: new Date().toISOString(),
        lastError: null,
      });
    },
  });
  snippetCaptureController.start();
}

function initMediaHoverController(): void {
  if (mediaHoverController) {
    mediaHoverController.stop();
  }

  mediaHoverController = createMediaHoverController({
    getSettings: () => getCurrentSettings(),
    getActiveAdapter: () => activeAdapter,
    getCurrentPlatform: () => getCurrentPlatformConfig(),
    onMediaSaved: () => {
      reportRuntimeStatus({
        lastSaveAt: new Date().toISOString(),
        lastError: null,
      });
    },
  });
  mediaHoverController.start();
}

/**
 * 初始化事件总线监听
 */
function initEventBusListeners(): void {
  // 监听消息提取事件
  eventBus.subscribe('messages:extracted', (event) => {
    const payload = event.payload as { platform?: PlatformName; messages?: unknown };
    Logger.info('[Content] 收到提取的消息:', payload.platform, payload.messages);

    if (!payload.platform || !Array.isArray(payload.messages)) {
      Logger.warn('[Content] 提取事件 payload 非法，跳过自动保存');
      return;
    }

    reportRuntimeStatus({
      lastExtractAt: new Date().toISOString(),
      lastError: null,
    });

    scheduleConversationSave(payload.platform, payload.messages as Message[], 'auto');
  });

  Logger.info('[Content] 事件总线监听已初始化');
}

/**
 * 初始化运行态健康监听（供 popup 诊断）
 */
function initRuntimeHealthListener(): void {
  if (!isRuntimeContextAvailable()) {
    handleRuntimeContextInvalidated('运行态监听初始化', new Error('Extension context invalidated.'));
    return;
  }

  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type !== 'content:healthPing') {
        return undefined;
      }

      const platform = getCurrentPlatformConfig();
      reportRuntimeStatus({ injected: true, lastError: null });
      sendResponse({
        status: 'ok',
        type: 'content:healthPong',
        injected: true,
        platform,
        url: window.location.href,
        timestamp: new Date().toISOString(),
        lastSaveAt: contentLastSaveAt,
      });
      return true;
    });
  } catch (error) {
    if (handleRuntimeContextInvalidated('运行态监听初始化', error)) {
      return;
    }
    throw error;
  }

  Logger.info('[Content] 运行态健康监听已初始化');
}

// 整页翻译分批参数：每批的文本块数量与最大并发请求数。
// 批次小→首段译文更快出现；并发→缩短整页总时长。
// 并发=6：实测 DashScope qwen 6 路并发无限流、线性扩展，相比 3 路整页耗时约减半。
const PAGE_TRANSLATION_BATCH_SIZE = 10;
const PAGE_TRANSLATION_CONCURRENCY = 6;

function normalizePageTranslationMode(value: unknown): TranslationMode {
  return value === 'translationOnly' ? 'translationOnly' : 'bilingual';
}

function normalizePageTranslationRange(value: unknown): TranslationRange {
  return value === 'all' || value === 'fullPage' ? 'all' : 'main';
}

function extractTranslationsFromResponse(
  response: ChromeMessageResponse<any>
): Array<{ id: string; text: string }> {
  const payload = response.data || response;
  const translations = payload?.translations;
  return Array.isArray(translations) ? translations : [];
}

function getImmersiveTranslationSettings(): {
  enabled?: boolean;
  selectionToolbarEnabled?: boolean;
  sourceLanguage?: string;
  targetLanguage?: string;
  textToSpeechEnabled?: boolean;
} {
  return ((getCurrentSettings() as any).immersiveTranslation || {}) as {
    enabled?: boolean;
    selectionToolbarEnabled?: boolean;
    sourceLanguage?: string;
    targetLanguage?: string;
    textToSpeechEnabled?: boolean;
  };
}

/** 划词工具栏：把 译/解 结果存为「记录」页的文字记录（翻译 / 提问）。 */
async function saveTextRecord(
  category: 'translation' | 'question',
  sourceText: string,
  resultText: string
): Promise<void> {
  const src = (sourceText || '').trim();
  const result = (resultText || '').trim();
  if (!src || !result) {
    return;
  }
  const label = category === 'translation' ? '翻译' : '提问';
  const url = location.href;
  const title = `${label} · ${src.slice(0, 40)}`.slice(0, 120);
  const body = category === 'translation' ? `${src}\n→ ${result}` : `${src}\n${result}`;
  try {
    await chromeMessageAdapter.sendMessage({
      type: 'upsertSnippet',
      snippet: {
        dedupeKey: `${category}:${url}:${src.slice(0, 80)}`,
        type: 'page_save',
        captureMethod: 'context_menu_page',
        selectionText: title,
        contextText: body,
        selectors: [],
        url,
        title,
        domain: location.hostname || label,
        sourceKind: 'web_page',
        headingPath: [label],
        rawContextMarkdown: body,
        summaryText: result.slice(0, 200),
      },
    });
  } catch {
    // 存记录失败不影响划词主功能
  }
}

/** 页面翻译完成后存一条「翻译」记录（按页 URL 去重，含原/译样本）。 */
async function savePageTranslationRecord(
  pairs: { src: string; tr: string }[]
): Promise<void> {
  const clean = pairs.filter((p) => p.src.trim() && p.tr.trim());
  if (!clean.length) {
    return;
  }
  const SAMPLE = 12;
  const sample = clean
    .slice(0, SAMPLE)
    .map((p) => `${p.src.trim()}\n→ ${p.tr.trim()}`)
    .join('\n\n');
  const body = clean.length > SAMPLE ? `${sample}\n\n…（共 ${clean.length} 段）` : sample;
  const title = `翻译 · ${(document.title || location.hostname).slice(0, 40)}`.slice(0, 120);
  try {
    await chromeMessageAdapter.sendMessage({
      type: 'upsertSnippet',
      snippet: {
        dedupeKey: `translation:page:${location.href}`,
        type: 'page_save',
        captureMethod: 'context_menu_page',
        selectionText: title,
        contextText: body,
        selectors: [],
        url: location.href,
        title,
        domain: location.hostname || '翻译',
        sourceKind: 'web_page',
        headingPath: ['翻译'],
        rawContextMarkdown: body,
        summaryText: clean[0].tr.slice(0, 200),
      },
    });
  } catch {
    // 存记录失败不影响页面翻译
  }
}

async function translateSelectedText(text: string): Promise<string> {
  const settings = getImmersiveTranslationSettings();
  const response = await chromeMessageAdapter.sendMessage({
    type: 'translation:translatePageText',
    request: {
      sourceLanguage: settings.sourceLanguage || 'auto',
      targetLanguage: settings.targetLanguage || 'zh-CN',
      items: [{ id: 'sayso-selection', text }],
    },
  });

  if (response.status === 'error') {
    throw new Error(response.error || '翻译失败');
  }

  const translations = extractTranslationsFromResponse(response as ChromeMessageResponse<any>);
  const translation = translations[0]?.text || '';
  void saveTextRecord('translation', text, translation); // 译 → 翻译记录
  return translation;
}

async function explainSelectedTextForToolbar(text: string): Promise<string> {
  const settings = getImmersiveTranslationSettings();
  const response = await chromeMessageAdapter.sendMessage({
    type: 'translation:explainText',
    request: {
      text,
      targetLanguage: settings.targetLanguage || 'zh-CN',
    },
  });

  if (response.status === 'error') {
    throw new Error(response.error || '解释失败');
  }

  const explanation = response.explanation ?? response.data?.explanation ?? '';
  void saveTextRecord('question', text, explanation); // 解 → 提问记录
  return explanation;
}

function speakSelectedText(text: string): void {
  if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') {
    throw new Error('当前浏览器不支持文本朗读');
  }

  const settings = getImmersiveTranslationSettings();
  const utterance = new SpeechSynthesisUtterance(text);
  if (settings.sourceLanguage && settings.sourceLanguage !== 'auto') {
    utterance.lang = settings.sourceLanguage;
  }
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function initSelectionTranslationToolbar(): void {
  const settings = getImmersiveTranslationSettings();
  if (settings.enabled === false || settings.selectionToolbarEnabled === false) {
    selectionTranslationToolbar?.stop();
    selectionTranslationToolbar = null;
    return;
  }

  if (selectionTranslationToolbar) {
    return;
  }

  selectionTranslationToolbar = createSelectionTranslationToolbar({
    onTranslate: translateSelectedText,
    onExplain: explainSelectedTextForToolbar,
    onSpeak: settings.textToSpeechEnabled === false ? undefined : speakSelectedText,
  });
  selectionTranslationToolbar.start();
  Logger.info('[Content] 选词翻译工具条已初始化');
}

function initPageTranslationListener(): void {
  if (hasInitializedPageTranslationListener) {
    return;
  }
  hasInitializedPageTranslationListener = true;

  if (!isRuntimeContextAvailable()) {
    handleRuntimeContextInvalidated('页面翻译监听初始化', new Error('Extension context invalidated.'));
    return;
  }

  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'translation:clearPageTranslations') {
        clearPageTranslations();
        sendResponse({ status: 'ok' });
        return true;
      }

      if (message.type !== 'translation:translateCurrentPage') {
        return undefined;
      }

      void (async () => {
        try {
          const mode = normalizePageTranslationMode(message.mode);
          const request = collectPageTranslationRequest({
            sourceLanguage: message.sourceLanguage || 'auto',
            targetLanguage: message.targetLanguage || 'zh-CN',
            mode,
            range: normalizePageTranslationRange(message.range),
          });

          if (!request.items.length) {
            sendResponse({ status: 'ok', translatedCount: 0 });
            return;
          }

          // 原文按 id 索引，便于和译文配对存记录
          const origById = new Map(request.items.map((it) => [it.id, it.text]));
          const collectedPairs: { src: string; tr: string }[] = [];

          // 分批并发翻译：每批返回即渲染，译文逐段出现而非整页一次性等待。
          const { translatedCount, firstError } = await runBatchedTranslation({
            items: request.items,
            batchSize: PAGE_TRANSLATION_BATCH_SIZE,
            concurrency: PAGE_TRANSLATION_CONCURRENCY,
            translateBatch: async (batchItems) => {
              const response = await chromeMessageAdapter.sendMessage({
                type: 'translation:translatePageText',
                request: { ...request, items: batchItems },
              });
              if (response.status === 'error') {
                throw new Error(response.error || '翻译失败');
              }
              return extractTranslationsFromResponse(response as ChromeMessageResponse<any>);
            },
            onBatch: (translations) => {
              renderPageTranslations({ mode, translations });
              translations.forEach((t) => {
                const src = origById.get(t.id);
                if (src && t.text) collectedPairs.push({ src, tr: t.text });
              });
            },
          });

          if (translatedCount === 0 && firstError) {
            sendResponse({ status: 'error', error: firstError });
            return;
          }

          // 页面翻译完成 → 存一条「翻译」记录
          void savePageTranslationRecord(collectedPairs);

          sendResponse({
            status: 'ok',
            translatedCount,
          });
        } catch (error) {
          sendResponse({
            status: 'error',
            error: stringifyError(error),
          });
        }
      })();

      return true;
    });
  } catch (error) {
    if (handleRuntimeContextInvalidated('页面翻译监听初始化', error)) {
      return;
    }
    throw error;
  }

  Logger.info('[Content] 页面翻译监听已初始化');
}

// ============================================================================
// 导出全局 API（供原 JavaScript 代码使用）
// ============================================================================
declare global {
  interface Window {
    saySoCommon?: {
      showSuccessStatus: () => void;
      cleanupFloatTags: () => void;
    };
    saySo?: {
      updateSettings: (settings: Partial<AppSettings>) => void;
      resetInitialization?: () => void;
    };
  }
}

// 设置全局 API
window.saySoCommon = {
  showSuccessStatus,
  cleanupFloatTags,
};

window.saySo = {
  ...window.saySo,
  updateSettings: (newSettings: Partial<AppSettings>) => {
    updateGlobalSettings(newSettings);
  },
  resetInitialization: () => {
    Logger.info('[Content] 重置初始化状态');

    // 停用平台适配器
    deactivatePlatform();

    snippetCaptureController?.stop();
    snippetCaptureController = null;
    mediaHoverController?.stop();
    mediaHoverController = null;
    selectionTranslationToolbar?.stop();
    selectionTranslationToolbar = null;

    // 清理悬浮标签
    cleanupFloatTags();

    // 清理侧边栏
    cleanupSidebar();

    // 重新初始化
    void init();
  },
};

// ============================================================================
// 初始化函数
// ============================================================================

/**
 * 初始化内容脚本
 */
async function init(): Promise<void> {
  Logger.info('[Content] 初始化内容脚本');

  try {
    if (!isCapturablePage(window.location.href)) {
      Logger.info('[Content] 当前页面不在可采集范围内');
      return;
    }

    // 加载设置
    await loadSettingsFromStorage();

    Logger.info('[Content] 当前设置:', getCurrentSettings());

    const isPageFrame = isTopLevelFrame();

    if (isPageFrame) {
      // 初始化侧边栏消息监听
      initSidebarMessageListener();

      // 初始化 snippets 采集控制器
      initSnippetCaptureController();
      initMediaHoverController();

      // 激活当前平台
      const currentPlatform = getCurrentPlatformConfig();

      if (currentPlatform) {
        safeInit(() => {
          try {
            initFloatTag();
            validateFloatTagVisibility();
          } catch (error) {
            Logger.error('[Content] 悬浮标签初始化失败:', error);
            reportRuntimeStatus({ lastError: 'FLOAT_TAG_INIT_FAILED' });
          }
        });
        activatePlatform(currentPlatform);
      }
    } else {
      cleanupSidebar();
      cleanupFloatTags();
    }

    // 启动 URL 监听
    if (isPageFrame) {
      startUrlMonitoring();
    }

    // 初始化设置监听
    initSettingsListener();

    // 手动保存针对整页对话，仅顶层页面需要；子 iframe 注册会导致重复/无意义触发。
    if (isPageFrame) {
      initManualSaveListener();
    }

    // 初始化事件总线监听
    initEventBusListeners();

    // 初始化运行态健康监听
    initRuntimeHealthListener();

    // 初始化页面翻译监听
    initPageTranslationListener();
    if (isPageFrame) {
      initSelectionTranslationToolbar();
      // 同声传译音画同步（延迟主视频对齐译音）
      initSimulcastVideoSyncListener();
      // 同声传译视频上字幕叠加
      initSimulcastSubtitleOverlayListener();
    }

    reportRuntimeStatus({
      injected: true,
      lastError: null,
    });

    Logger.info('[Content] 内容脚本初始化完成');
  } catch (error) {
    Logger.error('[Content] 初始化失败:', error);
    reportRuntimeStatus({
      injected: false,
      lastError: stringifyError(error),
    });
  }
}

/**
 * 清理和停止所有功能
 */
function cleanup(): void {
  Logger.info('[Content] 清理内容脚本');

  // 停止平台适配器
  deactivatePlatform();

  // 停止 URL 监听
  stopUrlMonitoring();

  snippetCaptureController?.stop();
  snippetCaptureController = null;
  mediaHoverController?.stop();
  mediaHoverController = null;

  // 清理悬浮标签
  cleanupFloatTags();

  // 清理侧边栏
  cleanupSidebar();

  Logger.info('[Content] 内容脚本已清理');
}

// ============================================================================
// 启动
// ============================================================================

// 根据DOM状态选择合适的初始化时机
safeInit(async () => {
  installGlobalErrorGuard();
  await init();
});

// 如果页面卸载，清理资源
window.addEventListener('beforeunload', () => {
  cleanup();
});

Logger.info('[Content] 内容脚本已加载');
