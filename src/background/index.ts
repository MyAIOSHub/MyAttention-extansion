/**
 * SaySo 后台服务入口
 * 作为扩展的核心部分，负责数据库操作和消息处理
 */

import { Logger, ErrorFactory } from '@/core/errors';
import { messageHandlers } from './handlers';
import { chromeMessageAdapter } from '@/core/chrome-message';
import { eventBus } from '@/core/event-bus';
import { cleanUrl } from '@/core/url';
import { DEFAULT_SETTINGS, type AppSettings, type ChromeMessageRequest, type ChromeMessageResponse } from '@/types';
import { isCapturablePage } from '@/core/page-scope';
import { CONTEXT_MENU_IDS } from '@/core/constants';
import {
  ensureLocalStoreMetaDefaults,
  getLocalStoreMeta,
  updateLocalStoreMeta,
} from './local-store-meta';
import { localStoreClient } from './local-store-client';
import { localStoreMigrator } from './migration/local-store-migrator';
import { messageDispatcher } from './message-dispatcher';
import { refreshSnippetBadge } from './snippet-status';
import { getBackgroundWebCaptureSettings } from './settings';
import { localStoreSyncService } from './local-store-sync-service';
import { FIRST_OPEN_WELCOME_PENDING_KEY } from '@/core/first-open';
import { fetchBrowsingHistory } from './history-tracker';
import { createSummaryTask, getSummaryTasks, getSummaryTaskResult } from './attention-summarizer';
import {
  createSession as createRecommendationSession,
  getSession as getRecommendationSession,
  markInteracted as markRecommendationInteracted,
  sweepInterruptedSessions,
} from './recommendation-engine';
import { startTabMonitor, cleanupTabMonitor } from './tab-monitor';
import { notifySummaryCompleted } from './myisland-client';
import {
  SimulcastRuntime,
  type StartSimulcastRequest,
} from './simulcast-runtime';
import { normalizeSimulcastPlaybackDelayMs } from '@/offscreen/simulcast-delay';
import {
  TranslationIframeRuntime,
  type PageTranslationFrameRequest,
  type TranslationFrameInfo,
} from './translation-iframe-runtime';
import {
  installVolcengineAstAuthRule,
  removeVolcengineAstAuthRule,
} from './volcengine-ast-auth-rules';

// 后台异步初始化（设置 / Local Store 等）的就绪 Promise。
// 事件监听器在顶层同步注册，但消息处理需等待初始化完成后再分发，
// 避免在 Service Worker 冷启动时读到未初始化状态。
let readyPromise: Promise<void> = Promise.resolve();

// ============================================================================
// 初始化设置
// ============================================================================

/**
 * 初始化设置
 */
async function initializeSettings(): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(['settings'], (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        // 如果没有设置，使用默认设置
        if (!result.settings) {
          chrome.storage.sync.set({ settings: DEFAULT_SETTINGS }, () => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
            } else {
              Logger.info('[Background] 初始化设置完成');
              resolve();
            }
          });
        } else {
          resolve();
        }
      }
    });
  });
}

function stringifyError(error: unknown): string {
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

async function initializeLocalStore(): Promise<void> {
  await ensureLocalStoreMetaDefaults();
  const meta = await getLocalStoreMeta();

  if (!meta.local_store_enabled) {
    Logger.warn('[Background] Local Store 已禁用，跳过初始化');
    return;
  }

  try {
    const health = await localStoreClient.health();
    if (health.dbPath) {
      await updateLocalStoreMeta({
        local_store_path: health.dbPath,
      });
    }
    await updateLocalStoreMeta({
      local_store_last_error: '',
    });
  } catch (error) {
    const message = stringifyError(error);
    await updateLocalStoreMeta({
      local_store_last_error: message,
    });
    Logger.error('[Background] Local Store 健康检查失败:', message);
    return;
  }

  const latest = await getLocalStoreMeta();
  if (latest.local_store_migration_state === 'pending') {
    await localStoreMigrator.migrateIfNeeded();
  }

  try {
    await localStoreSyncService.hydrateMirrorFromLocalStore();
    await localStoreSyncService.syncPending('initializeLocalStore');
  } catch (error) {
    Logger.warn('[Background] Local Store 镜像初始化失败', stringifyError(error));
  }
}

// ============================================================================
// 标签页行为管理
// ============================================================================

/**
 * 检查 URL 是否支持内容脚本注入
 */
function isInjectablePage(url: string): boolean {
  return isCapturablePage(url);
}

/**
 * 根据当前标签页动态设置 popup 行为
 */
function updatePopupBehavior(tabId: number, url: string): void {
  if (isInjectablePage(url)) {
    // 支持页面：移除默认 popup，让工具栏图标点击走和悬浮按钮一致的侧边栏。
    chrome.action.setPopup({ tabId, popup: '' });
  } else {
    // 非支持平台：使用回退 popup
    chrome.action.setPopup({ tabId, popup: 'html/fallback_popup.html' });
  }
}

const CONTENT_SCRIPT_FILES = {
  css: ['css/content.css'],
  js: ['content-script.js'],
} as const;

function getChromeLastErrorMessage(): string | null {
  try {
    return chrome.runtime.lastError?.message || null;
  } catch {
    return null;
  }
}

function getTabMediaStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const errorMessage = getChromeLastErrorMessage();
      if (errorMessage) {
        reject(new Error(errorMessage));
        return;
      }
      if (!streamId) {
        reject(new Error('无法获取当前标签页音频流'));
        return;
      }
      resolve(streamId);
    });
  });
}

function sendRuntimeMessageToOffscreen(message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const errorMessage = getChromeLastErrorMessage();
      if (errorMessage) {
        reject(new Error(errorMessage));
        return;
      }
      if (response?.status === 'error') {
        reject(new Error(response.error || 'offscreen 同传任务失败'));
        return;
      }
      resolve(response);
    });
  });
}

function broadcastRuntimeNotification(message: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, () => {
      // 广播投递：接收端不存在（如 popup 未打开）是正常情况，不当作失败拒绝；
      // 但记录到 debug 以便区分预期的“无接收端”与真实投递错误。
      const errorMessage = getChromeLastErrorMessage();
      if (errorMessage) {
        Logger.debug('[Background] 广播通知未送达', {
          type: message.type,
          error: errorMessage,
        });
      }
      resolve();
    });
  });
}

const simulcastRuntime = new SimulcastRuntime({
  hasOffscreenDocument: () => chrome.offscreen.hasDocument(),
  createOffscreenDocument: (parameters) =>
    chrome.offscreen.createDocument({
      url: parameters.url,
      reasons: parameters.reasons.map(
        (reason) => chrome.offscreen.Reason[reason as keyof typeof chrome.offscreen.Reason]
      ),
      justification: parameters.justification,
    }),
  closeOffscreenDocument: () => chrome.offscreen.closeDocument(),
  getTabMediaStreamId,
  sendRuntimeMessage: sendRuntimeMessageToOffscreen,
  installAstAuthRule: (headers) =>
    installVolcengineAstAuthRule(chrome.declarativeNetRequest, headers),
  removeAstAuthRule: () => removeVolcengineAstAuthRule(chrome.declarativeNetRequest),
  now: () => new Date().toISOString(),
  wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
});

function getAllFramesForTab(tabId: number): Promise<TranslationFrameInfo[]> {
  return new Promise((resolve, reject) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      const errorMessage = getChromeLastErrorMessage();
      if (errorMessage) {
        reject(new Error(errorMessage));
        return;
      }

      resolve(
        (frames || []).map((frame) => ({
          frameId: frame.frameId,
          parentFrameId: frame.parentFrameId,
          url: frame.url,
        }))
      );
    });
  });
}

function sendMessageToFrame(
  tabId: number,
  frameId: number,
  message: ChromeMessageRequest
): Promise<ChromeMessageResponse<{ translatedCount?: number }>> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
      const errorMessage = getChromeLastErrorMessage();
      if (errorMessage) {
        reject(new Error(errorMessage));
        return;
      }

      resolve((response || {}) as ChromeMessageResponse<{ translatedCount?: number }>);
    });
  });
}

async function ensureFrameContentScript(tabId: number, frameId: number): Promise<void> {
  await chrome.scripting.insertCSS({
    target: { tabId, frameIds: [frameId] },
    files: [...CONTENT_SCRIPT_FILES.css],
  });
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: [...CONTENT_SCRIPT_FILES.js],
  });
}

type RuntimeMessageParams = Record<string, unknown>;

const translationIframeRuntime = new TranslationIframeRuntime({
  getAllFrames: getAllFramesForTab,
  sendMessageToFrame,
  ensureFrameContentScript,
  now: () => Date.now(),
});

function getStringParam(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function getRecordParam(value: unknown): RuntimeMessageParams {
  return typeof value === 'object' && value !== null ? (value as RuntimeMessageParams) : {};
}

function buildStartSimulcastRequest(params: RuntimeMessageParams): StartSimulcastRequest {
  if (typeof params.tabId !== 'number') {
    throw new Error('启动同声传译需要当前标签页 ID');
  }

  const credentials = getRecordParam(params.credentials);

  return {
    tabId: params.tabId,
    streamId: getStringParam(params.streamId, '') || undefined,
    audioSource: ((): 'tab' | 'mic' | 'file' | 'url' => {
      const s = getStringParam(params.audioSource, 'tab');
      return s === 'mic' || s === 'file' || s === 'url' ? s : 'tab';
    })(),
    fileData: typeof params.fileData === 'string' ? params.fileData : undefined,
    mediaUrl: getStringParam(params.mediaUrl, '') || undefined,
    mediaMime: getStringParam(params.mediaMime, '') || undefined,
    recordAudio: params.recordAudio === true,
    sourceLanguage: getStringParam(params.sourceLanguage, 'auto'),
    targetLanguage: getStringParam(params.targetLanguage, 'zh-CN'),
    model: getStringParam(
      params.model,
      'Doubao_scene_SLM_Doubao_SI_model2000000748711437826'
    ),
    audioOutputMode: getStringParam(
      params.audioOutputMode,
      'translatedOnly'
    ) as StartSimulcastRequest['audioOutputMode'],
    originalVolume: normalizeVolume(params.originalVolume, 0.25),
    translatedVolume: normalizeVolume(params.translatedVolume, 1),
    translatedAudioDelayMs: normalizeSimulcastPlaybackDelayMs(params.translatedAudioDelayMs),
    translatedMaxPlaybackRate:
      typeof params.translatedMaxPlaybackRate === 'number'
        ? params.translatedMaxPlaybackRate
        : undefined,
    subtitleDisplayMode: getStringParam(
      params.subtitleDisplayMode,
      'bilingual'
    ) as StartSimulcastRequest['subtitleDisplayMode'],
    voiceCloneEnabled: params.voiceCloneEnabled !== false,
    credentials: {
      apiKey: getStringParam(credentials.apiKey, ''),
      appId: getStringParam(credentials.appId, ''),
      accessToken: getStringParam(credentials.accessToken, ''),
      secretKey: getStringParam(credentials.secretKey, ''),
      resourceId: getStringParam(credentials.resourceId, ''),
    },
  };
}

function normalizeVolume(value: unknown, fallback: number): number {
  const numberValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, numberValue));
}

function getRequiredTabId(params: RuntimeMessageParams, operation: string): number {
  if (typeof params.tabId !== 'number') {
    throw new Error(`${operation}需要当前标签页 ID`);
  }
  return params.tabId;
}

function buildPageTranslationFrameRequest(
  params: RuntimeMessageParams
): PageTranslationFrameRequest {
  return {
    sourceLanguage: getStringParam(params.sourceLanguage, 'auto'),
    targetLanguage: getStringParam(params.targetLanguage, 'zh-CN'),
    mode: getStringParam(params.mode, 'bilingual') as PageTranslationFrameRequest['mode'],
    range: getStringParam(params.range, 'main') as PageTranslationFrameRequest['range'],
  };
}

async function pingContentScript(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'content:healthPing' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }

        const type = response?.type ?? response?.data?.type;
        resolve(response?.status === 'ok' && type === 'content:healthPong');
      });
    } catch {
      resolve(false);
    }
  });
}

async function injectContentScript(tabId: number): Promise<void> {
  await chrome.scripting.insertCSS({
    target: { tabId, allFrames: true },
    files: [...CONTENT_SCRIPT_FILES.css],
  });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: [...CONTENT_SCRIPT_FILES.js],
  });
}

async function ensureContentScriptInjected(
  tabId: number,
  url: string,
  reason: string
): Promise<boolean> {
  if (!isInjectablePage(url)) {
    return false;
  }

  const isAlive = await pingContentScript(tabId);
  if (isAlive) {
    return false;
  }

  try {
    await injectContentScript(tabId);
    Logger.info('[Background] 已重注入内容脚本', { tabId, reason });
    return true;
  } catch (error) {
    Logger.warn('[Background] 内容脚本重注入失败', {
      tabId,
      url,
      reason,
      error: stringifyError(error),
    });
    return false;
  }
}

async function restoreContentScriptsForOpenTabs(reason: string): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map(async (tab) => {
        if (!tab.id || !tab.url || !isInjectablePage(tab.url)) {
          return;
        }
        await ensureContentScriptInjected(tab.id, tab.url, reason);
      })
    );
  } catch (error) {
    Logger.warn('[Background] 扫描恢复内容脚本失败', {
      reason,
      error: stringifyError(error),
    });
  }
}

/**
 * 设置标签页行为监听器
 */
function setupTabBehaviorListeners(): void {
  // 监听标签页 URL 变化，动态设置 popup 行为
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // 当 URL 变化或页面加载完成时更新 popup 行为
    if (changeInfo.url || changeInfo.status === 'complete') {
      updatePopupBehavior(tabId, tab.url || '');
      void refreshSnippetBadge(tabId, tab.url || '');
    }
  });

  // 监听标签页切换，动态设置 popup 行为
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (tab && tab.url) {
        updatePopupBehavior(activeInfo.tabId, tab.url);
        await refreshSnippetBadge(activeInfo.tabId, tab.url);
      }
    } catch (error) {
      // 标签页可能已关闭，忽略错误
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    messageHandlers.handleClearTabRuntimeStatus(tabId);
    cleanupTabMonitor(tabId);
    translationIframeRuntime.clearTabState(tabId);
  });

  chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId === 0) {
      translationIframeRuntime.clearTabState(details.tabId);
      return;
    }
    translationIframeRuntime.clearFrameState(details.tabId, details.frameId);
  });

  chrome.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId === 0) {
      return;
    }

    void translationIframeRuntime.handleFrameCompleted({
      tabId: details.tabId,
      frameId: details.frameId,
    }).catch((error) => {
      Logger.warn('[Background] iframe 翻译运行时注入失败', {
        tabId: details.tabId,
        frameId: details.frameId,
        error: stringifyError(error),
      });
    });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes.settings) {
      return;
    }

    void refreshContextMenus();
    void refreshAllTabSnippetBadges();
  });

  void chrome.tabs.query({}).then((tabs) => {
    tabs.forEach((tab) => {
      if (tab.id && tab.url) {
        updatePopupBehavior(tab.id, tab.url);
      }
    });
  });
}

// ============================================================================
// 扩展生命周期监听
// ============================================================================

/**
 * 检查是否为主要版本更新（主版本号变化）
 */
function isMajorVersionUpdate(oldVersion?: string, newVersion?: string): boolean {
  if (!oldVersion || !newVersion) return false;

  const oldMajor = parseInt(oldVersion.split('.')[0]);
  const newMajor = parseInt(newVersion.split('.')[0]);

  return newMajor > oldMajor;
}

/**
 * 检查是否为次要版本更新（次版本号变化）
 */
function isMinorVersionUpdate(oldVersion?: string, newVersion?: string): boolean {
  if (!oldVersion || !newVersion) return false;

  const oldParts = oldVersion.split('.');
  const newParts = newVersion.split('.');

  const oldMajor = parseInt(oldParts[0]);
  const newMajor = parseInt(newParts[0]);
  const oldMinor = parseInt(oldParts[1]);
  const newMinor = parseInt(newParts[1]);

  // 主版本号相同，但次版本号增加
  return oldMajor === newMajor && newMinor > oldMinor;
}

/**
 * 设置扩展生命周期监听器
 */
function setupLifecycleListeners(): void {
  chrome.runtime.onStartup.addListener(() => {
    void restoreContentScriptsForOpenTabs('runtime.onStartup');
  });

  // 扩展安装或更新时
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      Logger.info('[Background] 首次安装');
      chrome.storage.local.set({ [FIRST_OPEN_WELCOME_PENDING_KEY]: true });
    } else if (details.reason === 'update') {
      const currentVersion = chrome.runtime.getManifest().version;
      const previousVersion = details.previousVersion;

      Logger.info('[Background] 插件已从版本', {
        from: previousVersion,
        to: currentVersion,
      });

      // 检查是否为主要版本或次要版本更新
      if (
        isMajorVersionUpdate(previousVersion, currentVersion) ||
        isMinorVersionUpdate(previousVersion, currentVersion)
      ) {
        // TODO: 替换为新的更新页面 URL
        Logger.info('[Background] 版本更新，跳过打开更新页面');
        Logger.info('[Background] 已打开更新了示页面');
      } else {
        Logger.info('[Background] 当前版本无需显示更新了示');
      }
    }

    if (details.reason === 'install' || details.reason === 'update') {
      void restoreContentScriptsForOpenTabs(`runtime.onInstalled:${details.reason}`);
    }
  });
}

// ============================================================================
// 消息处理器映射
// ============================================================================

/**
 * 消息处理器映射表
 */
const messageHandlersMap: Record<
  string,
  (params: any, sender: chrome.runtime.MessageSender) => Promise<any>
> = {
  'connectDB': async () => {
    await messageHandlers.handleConnectDB();
    return { status: 'ok' };
  },

  'findConversationByUrl': async (params) => {
    const conversation = await messageHandlers.handleFindConversationByUrl(params.url);
    return { conversation };
  },

  'createConversation': async (params) => {
    const conversationId = await messageHandlers.handleCreateConversation(params.conversation);
    return { conversationId };
  },

  'updateConversation': async (params) => {
    await messageHandlers.handleUpdateConversation(params.conversation);
    return { status: 'ok' };
  },

  'getConversationById': async (params) => {
    const conversation = await messageHandlers.handleGetConversationById(params.conversationId);
    return { conversation };
  },

  'getAllConversations': async () => {
    const conversations = await messageHandlers.handleGetAllConversations();
    return { conversations };
  },

  'getConversationsByIds': async (params) => {
    const conversations = await messageHandlers.handleGetConversationsByIds(
      params.conversationIds || []
    );
    return { conversations };
  },

  'deleteConversation': async (params) => {
    await messageHandlers.handleDeleteConversation(params.conversationId);
    return { status: 'ok' };
  },

  'getStorageUsage': async () => {
    const usage = await messageHandlers.handleGetStorageUsage();
    return { usage };
  },

  'updateSettings': async (params) => {
    await messageHandlers.handleUpdateSettings(params.settings);
    return { status: 'ok' };
  },

  'getSettings': async () => {
    const settings = await messageHandlers.handleGetSettings();
    return { settings };
  },

  'translation:translatePageText': async (params) => {
    const result = await messageHandlers.handleTranslatePageText(params.request || params);
    return result;
  },

  'translation:explainText': async (params) => {
    return await messageHandlers.handleExplainText(params.request || params);
  },

  'translation:translateTabFrames': async (params) => {
    return await translationIframeRuntime.translateTabFrames(
      getRequiredTabId(params, '翻译当前页面'),
      buildPageTranslationFrameRequest(params)
    );
  },

  'translation:clearTabTranslations': async (params) => {
    return await translationIframeRuntime.clearTabTranslations(
      getRequiredTabId(params, '清除当前页面译文')
    );
  },

  'simulcast:start': async (params) => {
    const simulcast = await simulcastRuntime.start(buildStartSimulcastRequest(params));
    return { simulcast };
  },

  'simulcast:stop': async () => {
    const simulcast = await simulcastRuntime.stop();
    return { simulcast };
  },

  'simulcast:videoStopped': async (params, sender) => {
    const tabId =
      typeof params.tabId === 'number'
        ? params.tabId
        : typeof sender.tab?.id === 'number'
          ? sender.tab.id
          : undefined;
    const current = simulcastRuntime.getStatus();
    if (
      current.state !== 'capturing' ||
      typeof tabId !== 'number' ||
      current.tabId !== tabId
    ) {
      return { status: 'ok', stopped: false };
    }

    const simulcast = await simulcastRuntime.stop();
    await broadcastRuntimeNotification({
      type: 'simulcast:popupUpdate',
      tabId,
      videoStopped: true,
      status: {
        kind: 'success',
        message: '视频已停止，同声传译已停止。',
      },
    });
    return { status: 'ok', stopped: true, simulcast };
  },

  'simulcast:getStatus': async () => {
    return { simulcast: simulcastRuntime.getStatus() };
  },

  'simulcast:updatePlayback': async (params) => {
    const current = simulcastRuntime.getStatus();
    const tabId =
      typeof params.tabId === 'number'
        ? params.tabId
        : typeof current.tabId === 'number'
          ? current.tabId
          : undefined;

    if (
      current.state !== 'capturing' ||
      typeof tabId !== 'number' ||
      current.tabId !== tabId
    ) {
      return { status: 'ok', updated: false, simulcast: current };
    }

    const simulcast = await simulcastRuntime.updatePlaybackSettings({
      tabId,
      originalVolume: normalizeVolume(params.originalVolume, 0.25),
      translatedVolume: normalizeVolume(params.translatedVolume, 1),
      translatedAudioDelayMs: normalizeSimulcastPlaybackDelayMs(params.translatedAudioDelayMs),
      translatedMaxPlaybackRate:
        typeof params.translatedMaxPlaybackRate === 'number'
          ? params.translatedMaxPlaybackRate
          : undefined,
    });
    return { status: 'ok', updated: true, simulcast };
  },

  'simulcast:update': async (params) => {
    Logger.debug('[Background] 同声传译更新:', {
      tabId: params.tabId,
      subtitle: params.subtitle,
      status: params.status,
      translatedAudio: params.translatedAudio,
    });
    await broadcastRuntimeNotification({
      type: 'simulcast:popupUpdate',
      tabId: params.tabId,
      subtitle: params.subtitle,
      status: params.status,
      translatedAudio: params.translatedAudio,
      audio: params.audio, // 转写录音回放（停止时一次性下发）
    });
    return { status: 'ok' };
  },

  'simulcast:videoClock': async (params, sender) => {
    const tabId =
      typeof params.tabId === 'number'
        ? params.tabId
        : typeof sender.tab?.id === 'number'
          ? sender.tab.id
          : undefined;
    await broadcastRuntimeNotification({
      type: 'simulcast:popupUpdate',
      tabId,
      videoClock: {
        mode: params.mode,
        mediaTime: params.mediaTime,
        expectedDisplayTime: params.expectedDisplayTime,
        performanceNow: params.performanceNow,
        currentTime: params.currentTime,
        playbackRate: params.playbackRate,
        paused: params.paused,
        ended: params.ended,
        presentedFrames: params.presentedFrames,
      },
    });
    return { status: 'ok' };
  },

  'simulcast:popupUpdate': async () => {
    return { status: 'ok' };
  },

  'exportConversationsByRange': async (params) => {
    const url = await messageHandlers.handleExportConversations(params);
    return { url };
  },

  'clearStorage': async () => {
    await messageHandlers.handleClearStorage();
    return { status: 'ok' };
  },

  'manualSave': async (params) => {
    const result = await messageHandlers.handleManualSave({ url: params.url });
    return result;
  },

  'openSidePanel': async (params, sender) => {
    await messageHandlers.handleOpenSidePanel(sender);
    return { status: 'ok' };
  },

  'incrementalUpdate': async (params) => {
    const result = await messageHandlers.handleIncrementalUpdate(params);
    return result;
  },

  'smartIncrementalUpdate': async (params) => {
    const result = await messageHandlers.handleSmartIncrementalUpdate(params);
    return result;
  },

  'getConversation': async (params) => {
    const conversation = await messageHandlers.handleGetConversation(params.conversationId);
    return { conversation };
  },

  'reportContentRuntime': async (params, sender) => {
    const runtimeStatus = await messageHandlers.handleReportContentRuntime(params, sender);
    return { runtimeStatus };
  },

  'getTabRuntimeStatus': async (params, sender) => {
    const runtimeStatus = await messageHandlers.handleGetTabRuntimeStatus(params, sender);
    return { runtimeStatus };
  },

  'getLocalStoreStatus': async () => {
    const localStore = await messageHandlers.handleGetLocalStoreStatus();
    return { localStore };
  },

  'getBrowserSyncStatus': async () => {
    const browserSync = await messageHandlers.handleGetBrowserSyncStatus();
    return { browserSync };
  },

  'setLocalStorePath': async (params) => {
    const localStore = await messageHandlers.handleSetLocalStorePath(params.path);
    return { localStore };
  },

  'startLocalStoreMigration': async () => {
    const migration = await messageHandlers.handleStartLocalStoreMigration();
    return { migration };
  },

  'getLocalStoreMigrationState': async () => {
    const migration = await messageHandlers.handleGetLocalStoreMigrationState();
    return { migration };
  },

  'upsertSnippet': async (params, sender) => {
    const snippet = await messageHandlers.handleUpsertSnippet(params.snippet);
    if (sender.tab?.id && snippet.url) {
      void refreshSnippetBadge(sender.tab.id, snippet.url);
    }
    return { snippet };
  },

  'saveMediaSnippet': async (params, sender) => {
    const detail = await messageHandlers.handleSaveMediaSnippet({
      snippet: params.snippet,
      upload: params.upload,
    });
    if (sender.tab?.id && detail?.group.url) {
      void refreshSnippetBadge(sender.tab.id, detail.group.url);
    }
    return detail || { group: null, items: [] };
  },

  'upsertSnippetSelection': async (params, sender) => {
    const result = await messageHandlers.handleUpsertSnippetSelection(params.selection);
    if (sender.tab?.id && result.group.url) {
      void refreshSnippetBadge(sender.tab.id, result.group.url);
    }
    return result;
  },

  'getAllSnippets': async () => {
    const snippets = await messageHandlers.handleGetAllSnippets();
    return { snippets };
  },

  'getSnippetsByUrl': async (params) => {
    const snippets = await messageHandlers.handleGetSnippetsByUrl(params.url || '');
    return { snippets };
  },

  'getSnippetById': async (params) => {
    const snippet = await messageHandlers.handleGetSnippetById(params.id);
    return { snippet };
  },

  'getSnippetGroupById': async (params) => {
    const detail = await messageHandlers.handleGetSnippetGroupById(params.id);
    return detail || { group: null, items: [] };
  },

  'mergeSnippets': async (params, sender) => {
    const detail = await messageHandlers.handleMergeSnippets({
      targetId: params.targetId || '',
      sourceIds: Array.isArray(params.sourceIds) ? params.sourceIds : [],
    });
    if (sender.tab?.id && detail?.group.url) {
      void refreshSnippetBadge(sender.tab.id, detail.group.url);
    }
    return detail || { group: null, items: [] };
  },

  'deleteSnippet': async (params, sender) => {
    await messageHandlers.handleDeleteSnippet(params.id);
    if (sender.tab?.id && sender.tab.url) {
      void refreshSnippetBadge(sender.tab.id, sender.tab.url);
    }
    return { status: 'ok' };
  },

  'deleteSnippetItem': async (params, sender) => {
    await messageHandlers.handleDeleteSnippetItem(params.id);
    if (sender.tab?.id && sender.tab.url) {
      void refreshSnippetBadge(sender.tab.id, sender.tab.url);
    }
    return { status: 'ok' };
  },

  'clearSnippets': async () => {
    await messageHandlers.handleClearSnippets();
    return { status: 'ok' };
  },

  'getSnippetStatusForTab': async (params) => {
    const snippetStatus = await messageHandlers.handleGetSnippetStatusForTab(params.url || '');
    return { snippetStatus };
  },

  'getBrowsingHistory': async (params) => {
    const days = typeof params.days === 'number' ? params.days : 7;
    const history = await fetchBrowsingHistory(days);
    return { history };
  },

  'refreshBrowsingHistory': async (params) => {
    const days = typeof params.days === 'number' ? params.days : 7;
    const history = await fetchBrowsingHistory(days);
    return { history };
  },

  'createSummaryTask': async (params) => {
    return createSummaryTask({
      mode: params.mode || 'weekly',
      topic: params.topic,
      conversations: params.conversations || [],
      snippets: params.snippets || [],
      history: params.history || [],
    });
  },

  'getSummaryTasks': async () => {
    return { tasks: await getSummaryTasks() };
  },

  'getSummaryTaskResult': async (params) => {
    return await getSummaryTaskResult(params.taskId);
  },

  'createRecommendationSession': async (params) => {
    const triggerSource = params.triggerSource === 'standalone' ? 'standalone' : 'from_summary';
    let summaryText: string | undefined;
    if (triggerSource === 'from_summary') {
      if (!params.summaryTaskId) {
        return { status: 'error', error: 'summaryTaskId is required for from_summary trigger' };
      }
      const taskResult = await getSummaryTaskResult(params.summaryTaskId);
      if (!taskResult || !taskResult.result) {
        return { status: 'error', error: 'summary task not found or has no result' };
      }
      summaryText = taskResult.result;
    } else {
      return { status: 'error', error: 'standalone trigger is not supported in M1' };
    }
    return createRecommendationSession({
      triggerSource,
      summaryTaskId: params.summaryTaskId,
      summaryText,
    });
  },

  'getRecommendationSession': async (params) => {
    const session = await getRecommendationSession(params?.sessionId);
    return { session };
  },

  'markRecommendationInteracted': async (params) => {
    await markRecommendationInteracted({
      sessionId: params.sessionId,
      cardId: params.cardId,
      action: params.action,
      savedSnippetId: params.savedSnippetId,
    });
    return { status: 'ok' };
  },
};

function normalizeMessageResponse(result: any): any {
  if (result && typeof result === 'object') {
    if ('status' in result || 'error' in result) {
      return {
        status: (result as any).status || ((result as any).error ? 'error' : 'ok'),
        ...result,
        data: (result as any).data ?? (result as any),
      };
    }

    return {
      status: 'ok',
      data: result,
      ...result,
    };
  }

  return {
    status: 'ok',
    data: result,
  };
}

// ============================================================================
// 消息监听器
// ============================================================================

const ENABLE_MESSAGE_DISPATCHER = true;

/**
 * 设置消息监听器
 */
function setupMessageListeners(): void {
  chrome.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {
      // onMessage 接收任意来源的对象，运行时不保证 message.type 是字符串。
      if (!message || typeof message.type !== 'string' || message.type.length === 0) {
        Logger.warn('[Background] 非法消息类型:', typeof message?.type, message?.type);
        sendResponse({ status: 'error', error: 'Message type must be a non-empty string' });
        return false;
      }

      Logger.debug('[Background] 收到消息:', message.type);

      const handler = messageHandlersMap[message.type];

      if (!handler) {
        Logger.warn('[Background] 未知的消息类型:', message.type);
        sendResponse({ status: 'error', error: 'Unknown message type' });
        return false;
      }

      // LLM 调用等长时操作绕过 dispatcher 超时
      const BYPASS_DISPATCHER_TYPES = new Set([
        'createSummaryTask',
        'createRecommendationSession',
        'translation:translatePageText',
        'translation:explainText',
        'translation:translateTabFrames',
      ]);

      const dispatchPromise = readyPromise.then(() =>
        (ENABLE_MESSAGE_DISPATCHER && !BYPASS_DISPATCHER_TYPES.has(message.type))
          ? messageDispatcher.dispatch({
              messageType: message.type,
              params: message,
              sender,
              handler,
            })
          : handler(message, sender)
      );

      dispatchPromise
        .then((result) => {
          sendResponse(normalizeMessageResponse(result));
        })
        .catch((error) => {
          Logger.error('[Background] 处理消息失败:', error);
          sendResponse({
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        });

      // 关键：同步返回 true，保持消息通道，等待异步 sendResponse
      return true;
    }
  );
}

// ============================================================================
// 图标点击监听器
// ============================================================================

/**
 * 设置图标点击监听器
 */
function setupActionListener(): void {
  chrome.action.onClicked.addListener(async (tab) => {
    Logger.info('[Background] 扩展图标被点击');

    // 检查是否在支持的页面
    const url = tab.url || '';

    if (!isInjectablePage(url)) {
      Logger.info('[Background] 当前页面不支持使用侧边栏');
      return;
    }

    // 工具栏图标与悬浮按钮保持一致：统一打开注入式侧边栏。
    if (tab.id) {
      await ensureContentScriptInjected(tab.id, url, 'action.onClicked');
      chrome.tabs.sendMessage(tab.id, { type: 'toggleSidebar' }).catch((error) => {
        Logger.error('[Background] 发送打开侧边栏消息失败:', error);
      });
    }
  });
}

let contextMenuListenerBound = false;

function removeAllContextMenus(): Promise<void> {
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      // 读取 lastError 以消除「Unchecked runtime.lastError: No SW」（SW 生命周期瞬态）
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function createContextMenu(options: chrome.contextMenus.CreateProperties): Promise<void> {
  return new Promise((resolve) => {
    chrome.contextMenus.create(options, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

async function refreshActiveTabSnippetBadge(): Promise<void> {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const activeTab = tabs[0];
  if (activeTab?.id && activeTab.url) {
    await refreshSnippetBadge(activeTab.id, activeTab.url);
  }
}

async function refreshAllTabSnippetBadges(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id && tab.url) {
        await refreshSnippetBadge(tab.id, tab.url);
      }
    })
  );
}

async function refreshContextMenus(): Promise<void> {
  await removeAllContextMenus();

  try {
    // 翻译菜单独立于网页采集功能：只要沉浸式翻译未被关闭就提供。
    const settings = (await messageHandlers.handleGetSettings()) as AppSettings;
    if (settings.immersiveTranslation?.enabled !== false) {
      await createContextMenu({
        id: CONTEXT_MENU_IDS.TRANSLATE_PAGE,
        title: '翻译当前页面',
        contexts: ['page'],
      });
    }

    const webCapture = await getBackgroundWebCaptureSettings();
    if (!webCapture.enabled || !webCapture.contextMenuEnabled) {
      return;
    }

    await createContextMenu({
      id: CONTEXT_MENU_IDS.SELECTION,
      title: '保存选中文本到 SaySo Scribe',
      contexts: ['selection'],
    });
    await createContextMenu({
      id: CONTEXT_MENU_IDS.PAGE,
      title: '保存当前页面片段到 SaySo Scribe',
      contexts: ['page'],
    });
    await createContextMenu({
      id: CONTEXT_MENU_IDS.LINK,
      title: '保存链接文本到 SaySo Scribe',
      contexts: ['link'],
    });
    if (webCapture.mediaEnabled !== false) {
      await createContextMenu({
        id: CONTEXT_MENU_IDS.MEDIA,
        title: '保存媒体到 SaySo Scribe',
        contexts: ['image', 'video', 'audio'],
      });
    }
  } catch (error) {
    Logger.error('[Background] 更新右键菜单失败:', stringifyError(error));
  }
}

function setupContextMenus(): void {
  if (!contextMenuListenerBound) {
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      void handleContextMenuClick(info, tab);
    });
    contextMenuListenerBound = true;
  }

  void refreshContextMenus();
}

function normalizeContextMenuMediaKind(mediaType?: string): 'image' | 'video' | 'audio' {
  if (mediaType === 'video') {
    return 'video';
  }
  if (mediaType === 'audio') {
    return 'audio';
  }
  return 'image';
}

async function fallbackSaveMediaFromContextMenu(
  info: chrome.contextMenus.OnClickData,
  tabId: number,
  tabUrl: string,
  tabTitle: string,
  webCapture: Awaited<ReturnType<typeof getBackgroundWebCaptureSettings>>
): Promise<void> {
  const sourceUrl = String(info.srcUrl || '').trim();
  if (!sourceUrl) {
    return;
  }

  const mediaKind = normalizeContextMenuMediaKind(info.mediaType);
  const normalizedTabUrl = cleanUrl(tabUrl);
  const summaryText = sourceUrl.split('/').pop() || `${mediaKind} resource`;
  const allowLocalCopy = webCapture.mediaLocalCopyEnabled !== false;

  await messageHandlers.handleSaveMediaSnippet({
    snippet: {
      dedupeKey: `media_save:${normalizedTabUrl}:${sourceUrl}:web_page`,
      type: 'media_save',
      captureMethod: 'hover_media_save',
      selectionText: summaryText,
      contextText: sourceUrl,
      selectors: [],
      url: normalizedTabUrl,
      title: tabTitle,
      sourceKind: 'web_page',
      media: {
        kind: mediaKind,
        sourceUrl,
        previewUrl: sourceUrl,
        downloadStatus: allowLocalCopy ? 'pending' : 'url_only',
        savedFrom: allowLocalCopy ? 'url_pull' : 'url_only',
      },
      semanticBlockKey: `media:${normalizedTabUrl}:${sourceUrl}`,
      headingPath: [],
      blockKind: 'media',
      rawContextText: sourceUrl,
      rawContextMarkdown: sourceUrl,
      summaryText,
    },
  });
  await refreshSnippetBadge(tabId, tabUrl);
}

async function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab
): Promise<void> {
  const tabId = tab?.id;
  const tabUrl = tab?.url || '';
  const tabTitle = tab?.title || tabUrl || 'Untitled Page';

  if (!tabId || !tabUrl) {
    return;
  }

  // 翻译当前页面：独立于网页采集开关，单独处理。
  if (info.menuItemId === CONTEXT_MENU_IDS.TRANSLATE_PAGE) {
    try {
      const settings = (await messageHandlers.handleGetSettings()) as AppSettings;
      const immersive = settings.immersiveTranslation;
      await translationIframeRuntime.translateTabFrames(tabId, {
        sourceLanguage: immersive?.sourceLanguage || 'auto',
        targetLanguage: immersive?.targetLanguage || 'zh-CN',
        mode: (immersive?.mode as PageTranslationFrameRequest['mode']) || 'bilingual',
        range: (immersive?.range as PageTranslationFrameRequest['range']) || 'main',
      });
    } catch (error) {
      Logger.error('[Background] 右键翻译当前页面失败:', error);
    }
    return;
  }

  try {
    const webCapture = await getBackgroundWebCaptureSettings();
    if (!webCapture.enabled || !webCapture.contextMenuEnabled) {
      return;
    }

    if (
      info.menuItemId === CONTEXT_MENU_IDS.SELECTION ||
      info.menuItemId === CONTEXT_MENU_IDS.PAGE ||
      info.menuItemId === CONTEXT_MENU_IDS.MEDIA
    ) {
      await ensureContentScriptInjected(tabId, tabUrl, `contextMenu:${String(info.menuItemId)}`);
    }

    if (info.menuItemId === CONTEXT_MENU_IDS.SELECTION) {
      await chrome.tabs.sendMessage(tabId, {
        type: 'captureSelectionFromContextMenu',
        selectionText: info.selectionText || '',
      });
      return;
    }

    if (info.menuItemId === CONTEXT_MENU_IDS.PAGE) {
      await chrome.tabs.sendMessage(tabId, {
        type: 'capturePageFromContextMenu',
      });
      return;
    }

    if (info.menuItemId === CONTEXT_MENU_IDS.MEDIA) {
      if (!info.srcUrl) {
        return;
      }

      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'captureMediaFromContextMenu',
          srcUrl: info.srcUrl,
          mediaType: info.mediaType || '',
        });
        return;
      } catch {
        await fallbackSaveMediaFromContextMenu(info, tabId, tabUrl, tabTitle, webCapture);
        return;
      }
    }

    if (info.menuItemId === CONTEXT_MENU_IDS.LINK) {
      await messageHandlers.handleUpsertSnippet({
        dedupeKey: `highlight:${tabUrl}:${(info.linkUrl || '').slice(0, 120)}`,
        type: 'highlight',
        captureMethod: 'context_menu_selection',
        selectionText: info.linkUrl || '',
        contextText: '',
        selectors: [],
        url: tabUrl,
        title: tabTitle,
        sourceKind: 'web_page',
      });
      await refreshSnippetBadge(tabId, tabUrl);
      return;
    }
  } catch (error) {
    if (info.menuItemId === CONTEXT_MENU_IDS.MEDIA && info.srcUrl) {
      const webCapture = await getBackgroundWebCaptureSettings();
      await fallbackSaveMediaFromContextMenu(info, tabId, tabUrl, tabTitle, webCapture);
      return;
    }

    if (info.menuItemId === CONTEXT_MENU_IDS.SELECTION && info.selectionText) {
      await messageHandlers.handleUpsertSnippet({
        dedupeKey: `highlight:${tabUrl}:${info.selectionText.slice(0, 120)}`,
        type: 'highlight',
        captureMethod: 'context_menu_selection',
        selectionText: info.selectionText,
        contextText: '',
        selectors: [],
        url: tabUrl,
        title: tabTitle,
        sourceKind: 'web_page',
      });
      await refreshSnippetBadge(tabId, tabUrl);
    }
  }
}

// ============================================================================
// 应用入口
// ============================================================================

/**
 * 初始化应用
 */
/**
 * 同步已有总结任务到 MyIsland（启动时调用一次）
 */
async function syncExistingTasksToMyIsland(): Promise<void> {
  try {
    const tasks = await getSummaryTasks();
    console.log(`[MyIsland Sync] Found ${tasks.length} tasks, statuses:`, tasks.map(t => `${t.id}:${t.status}`));
    for (const task of tasks) {
      if (task.status === 'done' || task.status === 'error') {
        const result = await getSummaryTaskResult(task.id);
        console.log(`[MyIsland Sync] Syncing task ${task.id} (${task.mode}, ${task.status}), hasResult: ${!!result?.result}`);
        notifySummaryCompleted(
          task.id,
          task.mode,
          task.topic,
          task.status as 'done' | 'error',
          result?.result?.slice(0, 500)
        );
      }
    }
  } catch (e) {
    console.warn('[MyIsland Sync] Failed to sync tasks:', e);
  }
}

// 同步注册所有 chrome.* 事件监听器。
// 必须在任何 await 之前的首个同步周期内完成，否则 MV3 冷启动时
// 唤醒 Service Worker 的那个事件（图标点击 / 消息 / alarm）会丢失。
function registerEventListeners(): void {
  // 设置标签页行为监听器
  setupTabBehaviorListeners();

  // 设置扩展生命周期监听器
  setupLifecycleListeners();

  // 设置消息监听器
  setupMessageListeners();

  // 设置图标点击监听器
  setupActionListener();

  // 设置右键菜单入口
  setupContextMenus();

  // 启动后台标签页监控（MyIsland 通知）
  startTabMonitor();
}

// 异步初始化（监听器注册后再执行）。消息分发会 await 此 Promise。
async function initialize(): Promise<void> {
  Logger.info('[Background] 初始化 My Attention 后台服务');

  try {
    // 初始化设置
    await initializeSettings();

    try {
      localStoreSyncService.initialize();
    } catch (error) {
      Logger.warn('[Background] localStore 同步服务初始化失败', stringifyError(error));
    }

    // 初始化 Local Store（健康检查 + 首次迁移）
    try {
      await initializeLocalStore();
    } catch (error) {
      Logger.error('[Background] Local Store 初始化失败，将保持服务并等待手动恢复:', error);
    }

    // 启动后主动修复已打开标签页中的失效内容脚本（无页面刷新）
    await restoreContentScriptsForOpenTabs('background.initialize');

    // 同步已有总结任务到 MyIsland（覆盖扩展安装前已完成的任务）
    void syncExistingTasksToMyIsland();

    try {
      await sweepInterruptedSessions();
    } catch (error) {
      Logger.warn('[Background] sweepInterruptedSessions 失败', error);
    }

    Logger.info('[Background] 后台服务初始化完成');
  } catch (error) {
    Logger.error('[Background] 后台服务初始化失败:', stringifyError(error));
  }
}

// 启动应用：先同步注册监听器，再触发异步初始化。
registerEventListeners();
readyPromise = initialize();
readyPromise.catch((error) => {
  Logger.error('[Background] 应用启动失败:', error);
});

// ============================================================================
// 导出（用于测试）
// ============================================================================

export { initialize, messageHandlersMap };
