/**
 * 弹窗主入口模块
 * 初始化弹窗页面，协调各子模块
 */

import type {
  AppSettings,
  StorageUsage,
  Conversation,
  ChromeMessageRequest,
  ChromeMessageResponse,
  TabRuntimeStatus,
  Snippet,
  SnippetGroupDetail,
  SnippetStatus,
  BrowsingHistoryItem,
} from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import { Logger } from '@/core/errors';
import { renderMarkdownToHtml } from './markdown-renderer';
import {
  getPlatformFromUrl,
  isSupportedPlatformUrl,
} from '@/core/platforms';
import {
  initializeSettingsInteractions,
  loadSettings,
  updateUI,
  updateStorageUsageDisplay as refreshStorageUsageDisplay,
  refreshLocalStoreStatus,
  handleAutoSaveToggleChange,
  bindWebCaptureToggleEvents,
  handleExportButtonClick,
  handleClearButtonClick,
  elements as settingsElements,
} from './settings';
import { initBrandColorControl } from './brand-color-control';
import {
  setAllConversations,
  getCurrentConversationId,
  renderConversationCards,
  elements as memoriesListElements,
} from './memories-list';
import {
  renderConversationDetail,
  backToList,
  startInlineEdit,
  saveInlineEdit,
  cancelInlineEdit,
  deleteCurrentConversation,
  copyCurrentConversation,
  openOriginalPage,
  hideMoreActionsDropdown,
  showMoreActionsDropdown,
  elements as conversationDetailElements,
} from './conversation-detail';
import {
  getCurrentFilter,
  handleSearchInput,
  clearSearchInput,
  initializeFilter as initializeSearchFilterModule,
  setFilteredConversationsRenderer,
  setAllConversationsForFilter,
  getFilteredConversations,
  handleDateQuickOptions,
  toggleFilterDropdown,
  togglePlatformSelection,
  applyFilter,
  clearFilter,
  elements as searchElements,
} from './search-filter';
import { I18n } from './i18n';
import { getPageCaptureMode } from '@/core/page-scope';
import {
  isExtensionContextInvalidatedError,
} from '@/core/chrome-message';
import {
  installPopupGlobalErrorGuard,
  safeSendRuntimeMessage,
  safeGetMessage,
  safeCreateTab,
} from './chrome-safe';
import { formatTimestamp, escapeHtml } from './utils/index';
import { exportManager } from './export-manager';
import {
  createPopupRefreshQueue,
  type PopupRefreshQueue,
  type RefreshTaskType,
} from './refresh-queue';
import {
  renderSnippetCards,
  updateCurrentPageSnippetStatus,
  elements as snippetsListElements,
} from './snippets-list';
import {
  renderSnippetDetail,
  hideSnippetDetail,
  getCurrentSnippet,
  getCurrentSnippetDetail,
  openCurrentSnippetOriginalPage,
  openCurrentSnippetSavedCopy,
  elements as snippetDetailElements,
} from './snippet-detail';
import {
  DEFAULT_SNIPPET_FILTER_STATE,
  filterSnippets,
  type SnippetFilterDate,
  type SnippetFilterSource,
  type SnippetFilterState,
  type SnippetFilterType,
} from './snippet-filter';
import { createPopupMessageRouter } from './message-router';
import {
  buildRuntimeDiagnosticsViewModel,
  type RuntimeDiagnosticsViewModel,
} from './runtime-diagnostics';
import { initializeFirstOpenOverlay } from './first-open-overlay';
import {
  onRecommendTabActivated,
  onRecommendTabDeactivated,
} from './recommendation-controller';
import { buildVolcengineAstHeaders } from '@/translation/volcengine-ast';
import {
  applyTranscribeSubtitle,
  resetTranscript,
  loadTranscript,
  getTranscriptText,
  buildTranscriptExport,
  hasTranscript,
  setEditMode,
  isEditMode,
  setSegmentText,
  renameSpeaker,
  type TranscriptExportFormat,
} from './transcribe-view';
import {
  SAYSO_MODES,
  transcribeViaSayso,
  getSaysoBackendUrl,
  setSaysoBackendUrl,
  saysoModeLabel,
  type SaysoMode,
} from './sayso-transcribe';
import { VOLCENGINE_AST_EVENTS } from '@/translation/volcengine-ast-protobuf';
import { normalizeSimulcastPlaybackDelayMs } from '@/offscreen/simulcast-delay';
import {
  loadLocalCredentialPrefill,
  resolveLlmCredentialPrefill,
  resolveSimulcastCredentialPrefill,
} from './local-credential-prefill';
import { formatPageTranslationStatus } from './translation-status';
import {
  formatSimulcastTimestamp,
  reduceSimulcastSpeakerSegments,
  type SimulcastSpeakerSegment,
  type SimulcastSubtitleChannel,
} from './simulcast-speaker-log';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 自定义事件类型
 */
interface DetailEvent {
  conversationId: string;
  conversation?: Partial<Conversation>;
  title?: string;
}

/**
 * 删除对话事件类型
 */
interface DeleteEvent {
  conversationId: string;
  title?: string;
}

/**
 * 编辑对话标题事件
 */
interface EditTitleEvent {
  conversationId: string;
  newTitle: string;
}

// ============================================================================
// 本地状态（T02 最小可用）
// ============================================================================

let cachedConversations: Conversation[] = [];
let cachedSnippets: Snippet[] = [];
let cachedHistory: BrowsingHistoryItem[] = [];
let pendingRecommendParams: { triggerSource: 'from_summary'; summaryTaskId: string } | null = null;
// 翻译 tab 子页：immersive=沉浸式 / simultaneous=同声传译
let translateSub: 'immersive' | 'simultaneous' = 'immersive';
// 总结 tab 子页：summary=总结 / discover=发现（原推荐页）
let summarySub: 'summary' | 'discover' = 'summary';
let snippetFilterState: SnippetFilterState = { ...DEFAULT_SNIPPET_FILTER_STATE };
let snippetSelectionMode = false;
const selectedSnippetIds = new Set<string>();
let snippetSelectionOrder: string[] = [];
let isMultiSelectMode = false;
const selectedConversationIds = new Set<string>();
let runtimeDiagnostics: RuntimeDiagnosticsViewModel | null = null;
let recoveryToastShown = false;
let refreshQueue: PopupRefreshQueue | null = null;
let popupContextInvalidated = false;
let attentionLoadingCount = 0;
let simulcastSpeakerSegments: SimulcastSpeakerSegment[] = [];

const SILENT_MESSAGE_TYPES = new Set(['reportContentRuntime']);
const popupMessageRouter = createPopupMessageRouter({
  silentTypes: SILENT_MESSAGE_TYPES,
});

const runtimeStatusElements = {
  card: document.getElementById('runtime-status-card'),
  badge: document.getElementById('runtime-status-badge'),
  platform: document.getElementById('runtime-platform'),
  lastExtract: document.getElementById('runtime-last-extract'),
  lastSave: document.getElementById('runtime-last-save'),
  lastError: document.getElementById('runtime-last-error'),
  actionTip: document.getElementById('runtime-action-tip'),
  emptySubtitle: document.getElementById('attention-empty-subtitle'),
};

/** 当前注意力筛选 */
type AttentionFilter =
  | 'all'
  | 'aichat'
  | 'highlight'
  | 'dwell'
  | 'history'
  | 'translation'
  | 'question'
  | 'transcribe';
let currentAttentionFilter: AttentionFilter = 'all';

// snippet filter 已由 attention pills 替代，保留空对象兼容
const snippetFilterElements = {
  searchInput: null as HTMLInputElement | null,
  typeSelect: null as HTMLSelectElement | null,
  sourceSelect: null as HTMLSelectElement | null,
  dateSelect: null as HTMLSelectElement | null,
} as const;

const ENABLE_RUNTIME_DIAGNOSTICS = Boolean(runtimeStatusElements.card);

const FILTER_PLATFORMS: Array<{ id: Conversation['platform']; label: string }> = [
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'qwen', label: 'Qwen' },
  { id: 'claude', label: 'Claude' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'kimi', label: 'Kimi' },
  { id: 'doubao', label: '豆包' },
  { id: 'yuanbao', label: '腾讯元宝' },
];

const SIMULCAST_SOURCE_SUBTITLE_EVENTS = new Set<number>([
  VOLCENGINE_AST_EVENTS.SourceSubtitleStart,
  VOLCENGINE_AST_EVENTS.SourceSubtitleResponse,
  VOLCENGINE_AST_EVENTS.SourceSubtitleEnd,
]);

const SIMULCAST_TRANSLATION_SUBTITLE_EVENTS = new Set<number>([
  VOLCENGINE_AST_EVENTS.TranslationSubtitleStart,
  VOLCENGINE_AST_EVENTS.TranslationSubtitleResponse,
  VOLCENGINE_AST_EVENTS.TranslationSubtitleEnd,
]);

const SIMULCAST_SUBTITLE_START_EVENTS = new Set<number>([
  VOLCENGINE_AST_EVENTS.SourceSubtitleStart,
  VOLCENGINE_AST_EVENTS.TranslationSubtitleStart,
]);

interface SimulcastUpdateMessage {
  target?: string;
  status?: {
    kind?: 'success' | 'error' | 'info';
    message?: string;
  };
  subtitle?: {
    event?: number;
    text?: string;
    startTime?: number;
    endTime?: number;
    spkChg?: boolean;
    mutedDurationMs?: number;
    speakerId?: string;
  };
  audio?: {
    base64?: string;
    mime?: string;
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getRefreshQueue(): PopupRefreshQueue {
  if (popupContextInvalidated) {
    throw new Error('Popup context invalidated');
  }

  if (refreshQueue) {
    return refreshQueue;
  }

  refreshQueue = createPopupRefreshQueue(async (taskType: RefreshTaskType) => {
    switch (taskType) {
      case 'refreshConversations':
        await loadConversations();
        break;
      case 'refreshStorageStats':
        refreshStorageStats();
        break;
      case 'refreshSnippets':
        await loadSnippets();
        break;
      case 'refreshLocalStoreStatus':
        await refreshLocalStoreStatus();
        break;
      case 'refreshRuntimeDiagnostics':
        if (ENABLE_RUNTIME_DIAGNOSTICS) {
          await refreshRuntimeDiagnostics();
        }
        break;
      case 'refreshBrowsingHistory':
        await loadBrowsingHistory();
        break;
      default:
        break;
    }
  });

  return refreshQueue;
}

function enqueueRefresh(taskType: RefreshTaskType): void {
  if (popupContextInvalidated) {
    return;
  }
  getRefreshQueue().enqueue(taskType);
}

function renderSupportedPlatforms(): void {
  const container = document.getElementById('supported-platforms-list');
  if (!container) {
    return;
  }

  const supportedPlatforms = [
    FILTER_PLATFORMS.find((item) => item.id === 'chatgpt'),
    FILTER_PLATFORMS.find((item) => item.id === 'gemini'),
    FILTER_PLATFORMS.find((item) => item.id === 'qwen'),
    FILTER_PLATFORMS.find((item) => item.id === 'claude'),
    FILTER_PLATFORMS.find((item) => item.id === 'deepseek'),
    FILTER_PLATFORMS.find((item) => item.id === 'yuanbao'),
    FILTER_PLATFORMS.find((item) => item.id === 'doubao'),
    FILTER_PLATFORMS.find((item) => item.id === 'kimi'),
  ].filter((item): item is { id: Conversation['platform']; label: string } => Boolean(item));

  container.innerHTML = '';
  supportedPlatforms.forEach((platform) => {
    const badge = document.createElement('span');
    badge.className = `platform-tag platform-${platform.id}`;
    badge.textContent = platform.label;
    container.appendChild(badge);
  });
}

function removeLegacyOfficialSiteEntry(): void {
  const legacyNode = document.querySelector('[data-i18n="productWebsite"]');
  if (!legacyNode) {
    return;
  }

  const clickableContainer = legacyNode.closest('a, button, div');
  if (clickableContainer && clickableContainer.parentElement) {
    clickableContainer.parentElement.remove();
    Logger.info('[Popup] 已移除旧版 Official Site 入口');
  }
}

function handleContextInvalidated(operation: string, error: unknown): void {
  Logger.warn(`[Popup] ${operation}失败：扩展上下文已失效，自动刷新已禁用`);
  Logger.debug(`[Popup] ${operation}上下文失效详情:`, error);
  popupContextInvalidated = true;

  if (refreshQueue) {
    refreshQueue.dispose();
    refreshQueue = null;
  }

  if (!recoveryToastShown) {
    showToast('扩展上下文已失效。当前不会自动刷新，请重新打开扩展面板。', 'warning', 5000);
    recoveryToastShown = true;
  }
}

function logPopupError(operation: string, error: unknown): void {
  if (isExtensionContextInvalidatedError(error)) {
    handleContextInvalidated(operation, error);
    return;
  }
  Logger.error(`[Popup] ${operation}失败:`, error);
}

function extractRuntimeStatus(
  response: ChromeMessageResponse<{ runtimeStatus?: TabRuntimeStatus | null }>
): TabRuntimeStatus | null {
  if ((response as any)?.runtimeStatus) {
    return (response as any).runtimeStatus as TabRuntimeStatus;
  }
  if ((response as any)?.data?.runtimeStatus) {
    return (response as any).data.runtimeStatus as TabRuntimeStatus;
  }
  return null;
}

function extractSnippetsFromResponse(
  response: ChromeMessageResponse<{ snippets?: Snippet[] }>
): Snippet[] {
  if (Array.isArray((response as any)?.snippets)) {
    return (response as any).snippets as Snippet[];
  }
  if (Array.isArray((response as any)?.data?.snippets)) {
    return (response as any).data.snippets as Snippet[];
  }
  return [];
}

function extractSnippetStatus(
  response: ChromeMessageResponse<{ snippetStatus?: SnippetStatus }>
): SnippetStatus | null {
  if ((response as any)?.snippetStatus) {
    return (response as any).snippetStatus as SnippetStatus;
  }
  if ((response as any)?.data?.snippetStatus) {
    return (response as any).data.snippetStatus as SnippetStatus;
  }
  return null;
}

function extractSnippetDetailResponse(
  response: ChromeMessageResponse<{ group?: Snippet; items?: SnippetGroupDetail['items'] }>
): SnippetGroupDetail | null {
  const group = (response as any)?.group || (response as any)?.data?.group;
  const items = (response as any)?.items || (response as any)?.data?.items;
  if (!group) {
    return null;
  }
  return {
    group: group as Snippet,
    items: Array.isArray(items) ? items : [],
  };
}

function cleanSnippetUrl(url: string): string {
  return url.split('#')[0].split('?')[0];
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tabs[0] || null;
}

async function pingContentScript(
  tabId: number
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'content:healthPing' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          success: false,
          error: chrome.runtime.lastError.message || '未知错误',
        });
        return;
      }

      const type = response?.type ?? response?.data?.type;
      resolve({
        success: response?.status === 'ok' && type === 'content:healthPong',
      });
    });
  });
}

function getControlValue(id: string, fallback: string): string {
  const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  const value = element?.value;
  return value && value.length > 0 ? value : fallback;
}

function getNumberControlValue(id: string, fallback: number): number {
  const numberValue = Number(getControlValue(id, String(fallback)));
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, numberValue));
}

function getDelayControlValue(id: string): number {
  return normalizeSimulcastPlaybackDelayMs(getControlValue(id, '0'));
}

function setControlValue(id: string, value: string | number | undefined): void {
  const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  if (!element || value === undefined) {
    return;
  }
  element.value = String(value);
}

function getStoredSettings(): Promise<AppSettings | undefined> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['settings'], (result) => {
      resolve(result.settings as AppSettings | undefined);
    });
  });
}

function normalizePopupTranslationMode(value: string): 'bilingual' | 'translationOnly' {
  return value === 'translationOnly' ? 'translationOnly' : 'bilingual';
}

function requestCurrentTabMediaStreamId(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!chrome.tabCapture?.getMediaStreamId) {
      reject(new Error('当前浏览器不支持 tabCapture 音频捕获'));
      return;
    }

    chrome.tabCapture.getMediaStreamId({}, (streamId) => {
      const errorMessage = chrome.runtime.lastError?.message;
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

function setTranslationStatus(
  elementId: string,
  message: string,
  kind: 'info' | 'success' | 'error' = 'info'
): void {
  const element = document.getElementById(elementId);
  if (!element) {
    return;
  }

  const kindClassNames = {
    info: 'text-gray-600 bg-gray-50 border-gray-100',
    success: 'text-green-700 bg-green-50 border-green-100',
    error: 'text-red-700 bg-red-50 border-red-100',
  } as const;

  element.textContent = message;
  element.className = `text-xs rounded-lg px-3 py-2 border ${kindClassNames[kind]}`;
  element.classList.remove('hidden');
}

/**
 * 原文/译文/说话人日志合并为一个「按说话人分段」的流式视图：
 *   说话人N · 00:12
 *   原文…
 *   译文…
 * 源/译文按出现顺序 1:1 配对；每个源片段（reducer 已按 spk_chg 切分）即一次说话人轮次。
 * 火山实时 AST 仅提供 spk_chg（说话人切换），无稳定说话人 ID：
 *   有真·ID 时按 ID 去重编号；否则按轮次顺序编号。
 */
function renderSimulcastPaired(): void {
  const el = document.getElementById('simulcast-paired');
  if (!el) return;
  const sources = simulcastSpeakerSegments.filter((s) => s.channel === 'source');
  const translations = simulcastSpeakerSegments.filter((s) => s.channel === 'translation');
  if (!sources.length && !translations.length) {
    el.innerHTML = '<div class="text-gray-400 text-xs">等待…</div>';
    return;
  }

  const hasRealIds = sources.some((s) => Boolean(s.speakerId && s.speakerId.trim().length > 0));
  const idNumbers = new Map<string, number>();
  const speakerNoFor = (src: SimulcastSpeakerSegment, turnIndex: number): number => {
    if (!hasRealIds) return turnIndex + 1;
    const id = src.speakerId && src.speakerId.trim().length > 0 ? src.speakerId : '__unknown__';
    let n = idNumbers.get(id);
    if (n === undefined) {
      n = idNumbers.size + 1;
      idNumbers.set(id, n);
    }
    return n;
  };

  // 用墙钟时间做时间戳（火山实时 AST 的 startTime 常为 0）：相对会话最早一条计时
  const base = simulcastSpeakerSegments.reduce(
    (min, s) => (s.clockWall > 0 && s.clockWall < min ? s.clockWall : min),
    Number.POSITIVE_INFINITY
  );
  const relTime = (s: SimulcastSpeakerSegment): string =>
    Number.isFinite(base) && s.clockWall > 0
      ? formatSimulcastTimestamp(s.clockWall - base)
      : '--:--';

  const turns = sources.map((src, i) => ({
    no: speakerNoFor(src, i),
    time: relTime(src),
    source: src.text,
    translation: translations[i]?.text ?? '',
  }));

  el.innerHTML = turns
    .slice(-40)
    .map((t) => {
      const head = `<div class="flex items-center gap-2 mb-0.5"><span class="text-xs font-semibold text-brand">说话人${t.no}</span><span class="text-[10px] text-gray-400">${t.time}</span></div>`;
      const srcLine = `<div class="text-gray-800 text-sm leading-relaxed">${escapeHtml(t.source)}</div>`;
      const trLine = t.translation
        ? `<div class="text-gray-500 text-sm leading-relaxed">${escapeHtml(t.translation)}</div>`
        : '';
      return `<div class="border-b border-gray-50 pb-2">${head}${srcLine}${trLine}</div>`;
    })
    .join('');
  el.scrollTop = el.scrollHeight;
}

function appendSimulcastSpeakerLog(
  subtitle: NonNullable<SimulcastUpdateMessage['subtitle']>,
  channel: SimulcastSubtitleChannel,
  text: string
): void {
  simulcastSpeakerSegments = reduceSimulcastSpeakerSegments(simulcastSpeakerSegments, {
    channel,
    text,
    speakerId: subtitle.speakerId,
    startTime: subtitle.startTime,
    endTime: subtitle.endTime,
    spkChg: subtitle.spkChg || SIMULCAST_SUBTITLE_START_EVENTS.has(subtitle.event ?? 0),
    replaceText: !SIMULCAST_SUBTITLE_START_EVENTS.has(subtitle.event ?? 0),
    clockWall: Date.now(),
  });
  if (simulcastSpeakerSegments.length > 120) {
    simulcastSpeakerSegments = simulcastSpeakerSegments.slice(-80);
  }
  renderSimulcastPaired();
}

function clearSimulcastStreamingOutput(): void {
  simulcastSpeakerSegments = [];
  renderSimulcastPaired();
}

function handleSimulcastUpdate(
  message: SimulcastUpdateMessage,
  sendResponse: (response: { status: 'ok' }) => void
): void {
  if (message?.target === 'background') {
    sendResponse({ status: 'ok' });
    return;
  }

  if (message?.audio?.base64) {
    setupTranscribePlayback(message.audio.base64, message.audio.mime || 'audio/webm');
    sendResponse({ status: 'ok' });
    return;
  }

  const subtitle = message?.subtitle;
  const text = typeof subtitle?.text === 'string' ? subtitle.text.trim() : '';
  const statusMessage = message?.status?.message?.trim();

  // 文件/链接转写自动收尾（offscreen 在播放结束时下发）→ 回到空闲态
  if (transcribeActive && statusMessage && statusMessage.includes('转写完成')) {
    transcribeActive = false;
    updateTranscribeControls();
    setTranscribeStatus(statusMessage, 'success');
    sendResponse({ status: 'ok' });
    return;
  }

  if (statusMessage) {
    setTranslationStatus(
      'simulcast-status',
      statusMessage,
      message.status?.kind === 'error' ? 'error' : message.status?.kind === 'info' ? 'info' : 'success'
    );
  }

  if (!subtitle || !text) {
    sendResponse({ status: 'ok' });
    return;
  }

  const event = subtitle.event;
  if (typeof event !== 'number') {
    sendResponse({ status: 'ok' });
    return;
  }

  if (SIMULCAST_SOURCE_SUBTITLE_EVENTS.has(event)) {
    appendSimulcastSpeakerLog(subtitle, 'source', text);
    // 记录首条源字幕墙钟时刻（估算「识别→翻译→译音」滞后）
    if (simulcastRunning && simulcastFirstSourceWall === 0) {
      simulcastFirstSourceWall = Date.now();
    }
    // 同传：把当前句叠加到视频上（新源句先出现，译文随后补上）
    if (simulcastRunning && !transcribeActive) {
      overlaySource = text;
      overlayTranslation = '';
      sendSubtitleToVideo();
    }
    // 转写会话进行中：源字幕同时累积进转写视图
    if (transcribeActive) {
      applyTranscribeSubtitle(subtitle);
    }
  }

  if (SIMULCAST_TRANSLATION_SUBTITLE_EVENTS.has(event)) {
    appendSimulcastSpeakerLog(subtitle, 'translation', text);
    if (simulcastRunning && !transcribeActive) {
      overlayTranslation = text;
      sendSubtitleToVideo();
    }
    // 首条译文到达 → 一次性按实测滞后对齐视频
    maybeAutoMeasureSyncDelay();
  }

  if (!statusMessage) {
    setTranslationStatus('simulcast-status', '同声传译运行中：正在接收字幕和译音。', 'success');
  }
  sendResponse({ status: 'ok' });
}

async function sendMessageToActiveTab<R = any>(
  message: ChromeMessageRequest
): Promise<ChromeMessageResponse<R>> {
  const activeTab = await getActiveTab();
  if (typeof activeTab?.id !== 'number') {
    throw new Error('未找到当前标签页');
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(activeTab.id!, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || '当前页面未响应扩展消息'));
        return;
      }

      resolve((response || {}) as ChromeMessageResponse<R>);
    });
  });
}

async function handleTranslateCurrentPageClick(): Promise<void> {
  try {
    const provider = getControlValue('immersive-provider', 'openaiCompatible');
    if (provider !== 'openaiCompatible') {
      setTranslationStatus('immersive-status', '当前版本先使用 LLM API 通道翻译网页文本。', 'info');
    } else {
      setTranslationStatus('immersive-status', '正在抽取网页文本并翻译...', 'info');
    }

    const activeTab = await getActiveTab();
    if (typeof activeTab?.id !== 'number') {
      throw new Error('未找到当前标签页');
    }

    const response = await safeSendRuntimeMessage<
      unknown,
      { translatedCount?: number; frameCount?: number; failedFrameCount?: number; errorMessage?: string }
    >({
      type: 'translation:translateTabFrames',
      tabId: activeTab.id,
      sourceLanguage: getControlValue('immersive-source-language', 'auto'),
      targetLanguage: getControlValue('immersive-target-language', 'zh-CN'),
      mode: normalizePopupTranslationMode(getControlValue('immersive-mode', 'bilingual')),
      range: getControlValue('immersive-range', 'main'),
    });

    if (response.status === 'error') {
      throw new Error(response.error || '翻译失败');
    }

    const translatedCount = response.translatedCount ?? response.data?.translatedCount ?? 0;
    const frameCount = response.frameCount ?? response.data?.frameCount ?? 1;
    const failedFrameCount = response.failedFrameCount ?? response.data?.failedFrameCount ?? 0;
    const errorMessage = response.errorMessage ?? response.data?.errorMessage;
    const translationStatus = formatPageTranslationStatus({
      translatedCount,
      frameCount,
      failedFrameCount,
      errorMessage,
    });
    setTranslationStatus(
      'immersive-status',
      translationStatus.message,
      translationStatus.kind
    );
    // 内容脚本已存「翻译」记录 → 刷新片段列表，让记录页即时可见
    if (translatedCount > 0) {
      enqueueRefresh('refreshSnippets');
    }
  } catch (error) {
    setTranslationStatus('immersive-status', getErrorMessage(error) || '翻译失败', 'error');
  }
}

async function handleClearPageTranslationsClick(): Promise<void> {
  try {
    const activeTab = await getActiveTab();
    if (typeof activeTab?.id !== 'number') {
      throw new Error('未找到当前标签页');
    }

    await safeSendRuntimeMessage({
      type: 'translation:clearTabTranslations',
      tabId: activeTab.id,
    });
    setTranslationStatus('immersive-status', '已清除当前页译文', 'success');
  } catch (error) {
    setTranslationStatus('immersive-status', getErrorMessage(error) || '清除译文失败', 'error');
  }
}

async function handleSimulcastStartClick(): Promise<void> {
  try {
    clearSimulcastStreamingOutput();
    const credentials = {
      apiKey: getControlValue(
        'simulcast-api-key',
        DEFAULT_SETTINGS.simultaneousInterpretation?.credentials.apiKey ?? ''
      ),
      appId: getControlValue(
        'simulcast-app-id',
        DEFAULT_SETTINGS.simultaneousInterpretation?.credentials.appId ?? ''
      ),
      accessToken: getControlValue(
        'simulcast-access-token',
        DEFAULT_SETTINGS.simultaneousInterpretation?.credentials.accessToken ?? ''
      ),
      secretKey: getControlValue(
        'simulcast-secret-key',
        DEFAULT_SETTINGS.simultaneousInterpretation?.credentials.secretKey ?? ''
      ),
      resourceId: DEFAULT_SETTINGS.simultaneousInterpretation?.credentials.resourceId ?? '',
    };

    buildVolcengineAstHeaders(credentials);
    const streamIdPromise = requestCurrentTabMediaStreamId();
    setTranslationStatus('simulcast-status', '正在创建当前标签页音频捕获会话...', 'info');

    const [streamId, activeTab] = await Promise.all([streamIdPromise, getActiveTab()]);
    if (typeof activeTab?.id !== 'number') {
      throw new Error('未找到当前标签页');
    }

    const response = await safeSendRuntimeMessage<
      unknown,
      { simulcast?: { state?: string } }
    >({
      type: 'simulcast:start',
      tabId: activeTab.id,
      streamId,
      sourceLanguage: getControlValue('simulcast-source-language', 'auto'),
      targetLanguage: getControlValue('simulcast-target-language', 'zh-CN'),
      model: getControlValue(
        'simulcast-model',
        DEFAULT_SETTINGS.simultaneousInterpretation?.model ??
          'Doubao_scene_SLM_Doubao_SI_model2000000748711437826'
      ),
      // 固定「原音混合」：原音/译音都播放，由下方音量滑块控制（不再暴露输出模式选择）
      audioOutputMode: 'mixed',
      originalVolume: getNumberControlValue('simulcast-original-volume', 0.25),
      translatedVolume: getNumberControlValue('simulcast-translated-volume', 1),
      translatedAudioDelayMs: getDelayControlValue('simulcast-translated-delay-ms'),
      subtitleDisplayMode: getControlValue('simulcast-subtitle-mode', 'bilingual'),
      voiceCloneEnabled:
        (document.getElementById('simulcast-voice-clone-toggle') as HTMLInputElement | null)
          ?.checked !== false,
      credentials,
    });

    if (response.status === 'error') {
      throw new Error(response.error || '启动同声传译失败');
    }

    const simulcast = response.simulcast ?? response.data?.simulcast;

    setTranslationStatus(
      'simulcast-status',
      simulcast?.state === 'capturing'
        ? '已开始捕获当前标签页音频，等待接入火山 AST 流式协议输出译音。'
        : '同声传译捕获会话已提交。',
      'success'
    );

    // 音画同步：开局不盲目回退视频（会触发缓冲卡顿且白等），
    // 待首条译文到达、实测真实延迟后一次性对齐（见 maybeAutoMeasureSyncDelay）。
    simulcastRunning = true;
    simulcastFirstSourceWall = 0;
    simulcastSyncMeasured = false;
    updateSimulcastControls();
  } catch (error) {
    setTranslationStatus('simulcast-status', getErrorMessage(error), 'error');
  }
}

/** 停止仅在运行中显示；开始按钮在空闲时占满整行。 */
function updateSimulcastControls(): void {
  const start = document.getElementById('simulcast-start-btn');
  const stop = document.getElementById('simulcast-stop-btn');
  start?.classList.toggle('hidden', simulcastRunning);
  start?.classList.toggle('col-span-2', !simulcastRunning);
  stop?.classList.toggle('hidden', !simulcastRunning);
  stop?.classList.toggle('col-span-2', simulcastRunning);
}

async function handleSimulcastStopClick(): Promise<void> {
  try {
    setTranslationStatus('simulcast-status', '正在停止同声传译...', 'info');
    const response = await safeSendRuntimeMessage({
      type: 'simulcast:stop',
    });

    if (response.status === 'error') {
      throw new Error(response.error || '停止同声传译失败');
    }

    setTranslationStatus('simulcast-status', '已停止同声传译', 'success');
  } catch (error) {
    setTranslationStatus('simulcast-status', getErrorMessage(error), 'error');
  } finally {
    simulcastRunning = false;
    updateSimulcastControls();
    void sendVideoSync(false, 0); // 还原视频延迟
    overlaySource = '';
    overlayTranslation = '';
    sendSubtitleToVideo(true); // 清除视频上字幕
    void saveSimulcastTranslationRecord(); // 同传 → 翻译记录
  }
}

/** 同传停止时，把累计的原文/译文存为「记录」页的翻译记录。 */
async function saveSimulcastTranslationRecord(): Promise<void> {
  const sources = simulcastSpeakerSegments.filter((s) => s.channel === 'source');
  const translations = simulcastSpeakerSegments.filter((s) => s.channel === 'translation');
  if (!sources.length && !translations.length) {
    return;
  }
  const body = sources
    .map((s, i) => `${s.text}\n→ ${translations[i]?.text ?? ''}`.trim())
    .join('\n\n');
  if (!body.trim()) {
    return;
  }
  const first = (sources[0]?.text || translations[0]?.text || '同传').slice(0, 40);
  const title = `翻译 · ${first}`.slice(0, 120);
  try {
    const activeTab = await getActiveTab();
    const url = activeTab?.url || '';
    await safeSendRuntimeMessage({
      type: 'upsertSnippet',
      snippet: {
        dedupeKey: `translation:simulcast:${url}`,
        type: 'page_save',
        captureMethod: 'context_menu_page',
        selectionText: title,
        contextText: body,
        selectors: [],
        url,
        title,
        domain: url ? new URL(url).hostname : 'translation',
        sourceKind: 'web_page',
        headingPath: ['翻译'],
        rawContextMarkdown: body,
        summaryText: (translations[0]?.text || '').slice(0, 200),
      },
    });
  } catch {
    // 存记录失败不影响停止
  }
}

// 音画同步状态
let simulcastRunning = false;
let simulcastFirstSourceWall = 0; // 首条源字幕的墙钟时刻（估算管线滞后用）
let simulcastSyncMeasured = false;

// 视频上字幕叠加：当前句的原文/译文
let overlaySource = '';
let overlayTranslation = '';

/** 把当前句下发到内容脚本，在视频上叠加字幕。 */
function sendSubtitleToVideo(clear = false): void {
  const mode = getControlValue('simulcast-subtitle-mode', 'bilingual');
  void sendMessageToActiveTab({
    type: 'simulcast:subtitle',
    clear,
    source: overlaySource,
    translation: overlayTranslation,
    mode,
  }).catch(() => undefined);
}

// 自动同传：开关持久化 + 触发去抖
const AUTO_SIMULCAST_STORAGE_KEY = 'simulcastAutoStart';
let autoSimulcastEnabled = false;
let autoSimulcastBusy = false;

/** 满足条件则自动开始同传：开关打开、未在运行、凭据齐全。 */
async function maybeAutoStartSimulcast(): Promise<void> {
  if (!autoSimulcastEnabled || simulcastRunning || autoSimulcastBusy) return;
  // 凭据未填则不自动启动（避免反复弹错）
  const hasApiKey = !!getControlValue('simulcast-api-key', '').trim();
  const hasLegacy =
    !!getControlValue('simulcast-app-id', '').trim() &&
    !!getControlValue('simulcast-access-token', '').trim();
  if (!hasApiKey && !hasLegacy) return;
  autoSimulcastBusy = true;
  try {
    await handleSimulcastStartClick();
  } finally {
    autoSimulcastBusy = false;
  }
}

/** 收到内容脚本「视频开始播放」通知 → 尝试自动同传。 */
function handleSimulcastVideoPlaying(
  _message: unknown,
  sendResponse: (response: { status: 'ok' }) => void
): void {
  sendResponse({ status: 'ok' });
  void maybeAutoStartSimulcast();
}

/** popup 打开时：若开关开启且当前页视频正在播放，则自动同传。 */
async function queryActiveTabAndMaybeAutoStart(): Promise<void> {
  if (!autoSimulcastEnabled) return;
  try {
    const resp = await sendMessageToActiveTab<{ playing?: boolean }>({
      type: 'simulcast:queryVideoPlaying',
    });
    const playing = resp?.playing ?? resp?.data?.playing;
    if (playing) void maybeAutoStartSimulcast();
  } catch {
    // 当前页无内容脚本/未响应：忽略
  }
}

function setSimulcastSyncStatus(text: string): void {
  const el = document.getElementById('simulcast-sync-status');
  if (el) el.textContent = text;
}

async function sendVideoSync(
  enabled: boolean,
  delaySec: number,
  options: { silent?: boolean } = {}
): Promise<void> {
  try {
    const resp = await sendMessageToActiveTab<{
      videoFound?: boolean;
      mode?: string;
      videoCount?: number;
    }>({
      type: 'simulcast:syncVideo',
      enabled,
      delaySec,
    });
    if (!enabled) {
      setSimulcastSyncStatus('');
      return;
    }
    const videoFound = resp?.videoFound ?? resp?.data?.videoFound;
    const mode = resp?.mode ?? resp?.data?.mode;
    const videoCount = resp?.videoCount ?? resp?.data?.videoCount;
    if (videoFound === false) {
      setSimulcastSyncStatus(
        videoCount === 0 ? '页面没有视频元素（无法对齐）' : '未找到主视频（在有视频的页面再试）'
      );
    } else if (!options.silent) {
      setSimulcastSyncStatus(`已延迟视频 ${delaySec.toFixed(1)}s 对齐${mode === 'live' ? '（直播缓冲）' : ''}`);
    }
  } catch (error) {
    setSimulcastSyncStatus('同步失败：' + getErrorMessage(error));
  }
}

/**
 * 一次性对齐：用「首条源字幕 → 首条译文」的墙钟间隔估算管线滞后，把视频回退一次。
 * 不用 subtitle.startTime（火山实时常返回 0/会话相对值，会让延迟无限增大→疯狂 seek/循环）。
 * 只对齐一次，不持续重调，避免反复 seek 触发缓冲循环。
 */
function maybeAutoMeasureSyncDelay(): void {
  if (!simulcastRunning || simulcastSyncMeasured) return;
  if (simulcastFirstSourceWall === 0) return; // 还没收到源字幕，无从估算
  const lagSec = (Date.now() - simulcastFirstSourceWall) / 1000;
  const delaySec = Math.min(8, Math.max(1, Math.round(lagSec * 2) / 2));
  simulcastSyncMeasured = true;
  void sendVideoSync(true, delaySec, { silent: true });
  setSimulcastSyncStatus(`自动延迟 ${delaySec.toFixed(1)}s（实测对齐，一次性）`);
}

// 转写会话是否进行中（决定是否把源字幕路由到转写视图）
let transcribeActive = false;
// 转写音频来源：标签页 / 麦克风 / 文件 / 链接
let transcribeSource: 'tab' | 'mic' | 'file' | 'url' = 'tab';
// 文件/链接转写模式（走 Say-So-Scribe 后端）
let transcribeMode: SaysoMode = 'whale';
const TRANSCRIBE_MODE_KEY = 'transcribeMode';
let saysoAbort: AbortController | null = null;

/** 渲染 5 档模式卡 + 选中态。 */
function renderTranscribeModeCards(): void {
  const wrap = document.getElementById('transcribe-mode-cards');
  if (!wrap) return;
  wrap.innerHTML = SAYSO_MODES.map((m) => {
    const active = m.key === transcribeMode;
    const cls = active
      ? 'border-brand bg-brand-light text-brand'
      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50';
    return (
      `<button type="button" data-mode="${m.key}" class="transcribe-mode-btn flex flex-col items-center gap-0.5 rounded-lg border-2 ${cls} py-2 px-1 text-center transition-colors">` +
      `<span class="text-base leading-none">${m.icon}</span>` +
      `<span class="text-xs font-semibold leading-tight">${m.name}</span>` +
      `<span class="text-[10px] leading-tight opacity-70">${m.tier}</span>` +
      `</button>`
    );
  }).join('');
  wrap.querySelectorAll('.transcribe-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      transcribeMode = (btn as HTMLElement).dataset.mode as SaysoMode;
      void chrome.storage.local.set({ [TRANSCRIBE_MODE_KEY]: transcribeMode });
      renderTranscribeModeCards();
    });
  });
}

/** 文件/链接来源时显示模式卡。 */
function updateTranscribeModeVisibility(): void {
  const wrap = document.getElementById('transcribe-mode-wrap');
  const isMedia = transcribeSource === 'file' || transcribeSource === 'url';
  wrap?.classList.toggle('hidden', !isMedia);
}

/** 文件/链接转写：走 Say-So-Scribe 后端的所选模式。 */
async function handleTranscribeViaSayso(): Promise<void> {
  // 运行中再次点击 = 取消
  if (transcribeActive && saysoAbort) {
    saysoAbort.abort();
    return;
  }
  try {
    let file: File | null = null;
    if (transcribeSource === 'file') {
      file = (document.getElementById('transcribe-file') as HTMLInputElement | null)?.files?.[0] ?? null;
      if (!file) throw new Error('请先选择音视频文件');
    } else {
      const url = (document.getElementById('transcribe-url') as HTMLInputElement | null)?.value.trim() || '';
      if (!url) throw new Error('请先输入直链音视频 URL');
      setTranscribeStatus('正在拉取链接...', 'info');
      const blob = await (await fetch(url)).blob();
      file = new File([blob], url.split('/').pop() || 'audio', { type: blob.type || 'audio/mpeg' });
    }

    resetTranscript();
    transcribeActive = true;
    updateTranscribeControls();
    setTranscribeStatus(`正在用「${saysoModeLabel(transcribeMode)}」转写（Say-So-Scribe）…`, 'info');
    const meta = document.getElementById('transcribe-meta');
    if (meta) meta.textContent = '转写中…';

    saysoAbort = new AbortController();
    const lang = getControlValue('transcribe-source-language', 'auto');
    const result = await transcribeViaSayso(file, transcribeMode, lang, saysoAbort.signal);
    loadTranscript(result.segments, result.speakers);
    setTranscribeStatus(`转写完成（${result.segments.length} 段 · ${saysoModeLabel(transcribeMode)}）`, 'success');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      setTranscribeStatus('已取消转写', 'info');
    } else {
      setTranscribeStatus(getErrorMessage(error), 'error');
    }
  } finally {
    transcribeActive = false;
    saysoAbort = null;
    updateTranscribeControls();
  }
}

function readSavedSettings(): Promise<AppSettings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['settings'], (result) => {
      resolve((result.settings as AppSettings) || { ...DEFAULT_SETTINGS });
    });
  });
}

function setTranscribeStatus(text: string, kind: 'info' | 'success' | 'error'): void {
  const el = document.getElementById('transcribe-status');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden', 'text-gray-500', 'text-red-500', 'text-green-600');
  el.classList.add(kind === 'error' ? 'text-red-500' : kind === 'success' ? 'text-green-600' : 'text-gray-500');
}

/**
 * 按来源/状态更新转写按钮：
 * - 标签页/麦克风=实时 → 开始 + 停止
 * - 文件/链接=一次性(自动收尾) → 仅一个按钮，运行中显示「取消」，隐藏停止
 */
function updateTranscribeControls(): void {
  const stopBtn = document.getElementById('transcribe-stop-btn');
  const startLabel = document.getElementById('transcribe-start-label');
  const startIcon = document.getElementById('transcribe-start-icon');
  const isMedia = transcribeSource === 'file' || transcribeSource === 'url';
  stopBtn?.classList.toggle('hidden', isMedia);
  if (startLabel) {
    startLabel.textContent = isMedia && transcribeActive ? '取消' : '开始转写';
  }
  if (startIcon) {
    startIcon.className = `fas ${isMedia && transcribeActive ? 'fa-xmark' : 'fa-circle text-[8px]'}`;
  }
}

async function handleTranscribeStartClick(): Promise<void> {
  // 文件/链接 → Say-So-Scribe 后端（5 档模式）；标签页/麦克风 → 火山实时
  if (transcribeSource === 'file' || transcribeSource === 'url') {
    await handleTranscribeViaSayso();
    return;
  }
  try {
    setTranscribeStatus('正在准备转写会话...', 'info');
    const settings = await readSavedSettings();
    const si = settings.simultaneousInterpretation ?? DEFAULT_SETTINGS.simultaneousInterpretation;
    const saved = si?.credentials;
    const credDefaults = DEFAULT_SETTINGS.simultaneousInterpretation?.credentials;
    // 凭据优先读「同声传译」页输入框（与同传一致），回落到已保存设置/默认
    const credentials = {
      apiKey: getControlValue('simulcast-api-key', saved?.apiKey ?? credDefaults?.apiKey ?? ''),
      appId: getControlValue('simulcast-app-id', saved?.appId ?? credDefaults?.appId ?? ''),
      accessToken: getControlValue('simulcast-access-token', saved?.accessToken ?? credDefaults?.accessToken ?? ''),
      secretKey: getControlValue('simulcast-secret-key', saved?.secretKey ?? credDefaults?.secretKey ?? ''),
      resourceId: saved?.resourceId ?? credDefaults?.resourceId ?? '',
    };
    if (!credentials.apiKey && !(credentials.appId && credentials.accessToken)) {
      throw new Error('请先在「同声传译」页填入火山 AST 凭据（新版 API Key 或 旧版 App ID + Access Token）');
    }
    // 校验凭据是否齐全（缺失会抛错）
    buildVolcengineAstHeaders(credentials);

    const isTab = transcribeSource === 'tab';
    const [streamId, activeTab] = await Promise.all([
      isTab ? requestCurrentTabMediaStreamId() : Promise.resolve(''),
      getActiveTab(),
    ]);
    if (typeof activeTab?.id !== 'number') {
      throw new Error('未找到当前标签页');
    }

    resetTranscript();
    clearTranscribePlayback();
    const response = await safeSendRuntimeMessage<unknown, { simulcast?: { state?: string } }>({
      type: 'simulcast:start',
      tabId: activeTab.id,
      streamId,
      audioSource: transcribeSource,
      recordAudio: true, // 标签页/麦克风：录制以便回放
      sourceLanguage: getControlValue('transcribe-source-language', 'auto'),
      targetLanguage: 'auto',
      model: getControlValue(
        'simulcast-model',
        si?.model ?? DEFAULT_SETTINGS.simultaneousInterpretation?.model ?? ''
      ),
      audioOutputMode: 'subtitlesOnly', // 强制 s2t：仅源字幕，无翻译/TTS
      originalVolume: 0,
      translatedVolume: 0,
      translatedAudioDelayMs: 0,
      subtitleDisplayMode: 'originalOnly',
      voiceCloneEnabled: false,
      credentials,
    });

    if (response.status === 'error') {
      throw new Error(response.error || '启动转写失败');
    }

    transcribeActive = true;
    updateTranscribeControls();
    setTranscribeStatus('转写进行中：正在捕获音频…', 'success');
    const meta = document.getElementById('transcribe-meta');
    if (meta) meta.textContent = '录制中…';
  } catch (error) {
    transcribeActive = false;
    updateTranscribeControls();
    setTranscribeStatus(getErrorMessage(error), 'error');
  }
}

async function handleTranscribeStopClick(): Promise<void> {
  try {
    setTranscribeStatus('正在停止转写...', 'info');
    const response = await safeSendRuntimeMessage({ type: 'simulcast:stop' });
    if (response.status === 'error') {
      throw new Error(response.error || '停止转写失败');
    }
    setTranscribeStatus('已停止转写', 'success');
  } catch (error) {
    setTranscribeStatus(getErrorMessage(error), 'error');
  } finally {
    transcribeActive = false;
    updateTranscribeControls();
  }
}

async function handleTranscribeCopyClick(): Promise<void> {
  const text = getTranscriptText();
  if (!text) {
    setTranscribeStatus('暂无可复制的转写内容', 'info');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setTranscribeStatus('已复制全文', 'success');
  } catch {
    setTranscribeStatus('复制失败，请手动选择文本', 'error');
  }
}

let transcribePlaybackUrl: string | null = null;

function clearTranscribePlayback(): void {
  if (transcribePlaybackUrl) {
    URL.revokeObjectURL(transcribePlaybackUrl);
    transcribePlaybackUrl = null;
  }
  document.getElementById('transcribe-playback')?.classList.add('hidden');
  const audio = document.getElementById('transcribe-audio') as HTMLAudioElement | null;
  if (audio) audio.removeAttribute('src');
}

function setupTranscribePlayback(base64: string, mime: string): void {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    if (transcribePlaybackUrl) URL.revokeObjectURL(transcribePlaybackUrl);
    transcribePlaybackUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const audio = document.getElementById('transcribe-audio') as HTMLAudioElement | null;
    if (audio) audio.src = transcribePlaybackUrl;
    document.getElementById('transcribe-playback')?.classList.remove('hidden');
    setTranscribeStatus('转写完成，可回放音频并点分段跳转', 'success');
  } catch {
    // 忽略无法解码的录音
  }
}

function handleTranscribeSegmentSeek(event: Event): void {
  if (isEditMode()) return; // 编辑模式下点击用于编辑，不跳转
  const row = (event.target as HTMLElement).closest<HTMLElement>('[data-start]');
  const startMs = row?.dataset.start ? Number(row.dataset.start) : NaN;
  const audio = document.getElementById('transcribe-audio') as HTMLAudioElement | null;
  if (!audio || !audio.src || Number.isNaN(startMs)) return;
  audio.currentTime = startMs / 1000;
  void audio.play().catch(() => undefined);
}

function handleTranscribeEditToggle(): void {
  const next = !isEditMode();
  setEditMode(next);
  const btn = document.getElementById('transcribe-edit-btn');
  if (btn) {
    btn.classList.toggle('text-brand', next);
    btn.classList.toggle('bg-brand-light', next);
    btn.classList.toggle('text-gray-600', !next);
    btn.setAttribute('title', next ? '完成编辑' : '编辑');
  }
  setTranscribeStatus(next ? '编辑中：改分段文本 / 点说话人改名' : '已退出编辑', 'info');
}

function handleTranscribeEditCommit(event: Event): void {
  const el = event.target as HTMLElement;
  if (el.dataset.index !== undefined) {
    setSegmentText(Number(el.dataset.index), el.textContent ?? '');
  } else if (el.dataset.speakerId !== undefined) {
    renameSpeaker(el.dataset.speakerId, el.textContent ?? '');
  }
}

function handleTranscribeExport(format: TranscriptExportFormat): void {
  if (!hasTranscript()) {
    setTranscribeStatus('暂无可导出的转写内容', 'info');
    return;
  }
  const mime = format === 'srt' ? 'application/x-subrip' : 'text/plain';
  const blob = new Blob([buildTranscriptExport(format)], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `transcript-${stamp}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setTranscribeStatus(`已导出 ${format.toUpperCase()}`, 'success');
}

async function handleTranscribeSaveClick(): Promise<void> {
  const text = getTranscriptText();
  if (!text) {
    setTranscribeStatus('暂无可保存的转写内容', 'info');
    return;
  }
  try {
    const activeTab = await getActiveTab();
    const url = activeTab?.url || '';
    const pageTitle = activeTab?.title || '转写';
    const domain = url ? new URL(url).hostname : 'transcribe';
    const firstLine = text.split('\n')[0]?.slice(0, 60) ?? '转写';
    const response = await safeSendRuntimeMessage<unknown, { snippet?: { id?: string } }>({
      type: 'upsertSnippet',
      snippet: {
        dedupeKey: `transcript:${Date.now()}`,
        type: 'page_save',
        captureMethod: 'context_menu_page',
        selectionText: `转写 · ${pageTitle}`.slice(0, 120),
        contextText: text,
        selectors: [],
        url,
        title: `转写 · ${pageTitle}`.slice(0, 120),
        domain,
        sourceKind: 'web_page',
        headingPath: ['转写'],
        rawContextMarkdown: buildTranscriptExport('md'),
        summaryText: firstLine,
      },
    });
    if (response.status === 'error') {
      throw new Error(response.error || '保存失败');
    }
    setTranscribeStatus('已存为记录，可在「记录」查看 / 进「总结」', 'success');
  } catch (error) {
    setTranscribeStatus(getErrorMessage(error), 'error');
  }
}

function persistTranslationQuality(quality: 'fast' | 'accurate'): void {
  chrome.storage.sync.get(['settings'], (result) => {
    const settings = (result.settings || { ...DEFAULT_SETTINGS }) as AppSettings;
    const base = settings.immersiveTranslation ?? DEFAULT_SETTINGS.immersiveTranslation;
    settings.immersiveTranslation = base
      ? { ...base, translationQuality: quality }
      : ({ translationQuality: quality } as AppSettings['immersiveTranslation']);
    chrome.storage.sync.set({ settings });
  });
}

function initializeTranslationQualityControl(): void {
  const select = document.getElementById('immersive-quality') as HTMLSelectElement | null;
  if (!select) {
    return;
  }

  void (async () => {
    const settings = await getStoredSettings();
    select.value =
      settings?.immersiveTranslation?.translationQuality === 'accurate' ? 'accurate' : 'fast';
  })();

  select.addEventListener('change', () => {
    persistTranslationQuality(select.value === 'accurate' ? 'accurate' : 'fast');
  });
}

function initializeTranslationActions(): void {
  document
    .getElementById('immersive-translate-current-page')
    ?.addEventListener('click', () => {
      void handleTranslateCurrentPageClick();
    });

  document.getElementById('immersive-clear-page')?.addEventListener('click', () => {
    void handleClearPageTranslationsClick();
  });

  initializeTranslationQualityControl();

  document.getElementById('simulcast-start-btn')?.addEventListener('click', () => {
    void handleSimulcastStartClick();
  });

  document.getElementById('simulcast-stop-btn')?.addEventListener('click', () => {
    void handleSimulcastStopClick();
  });
  updateSimulcastControls();

  document.getElementById('transcribe-start-btn')?.addEventListener('click', () => {
    // 文件/链接：handleTranscribeViaSayso 内部自处理「取消(abort)」；标签页/麦克风：开始
    void handleTranscribeStartClick();
  });
  document.getElementById('transcribe-stop-btn')?.addEventListener('click', () => {
    void handleTranscribeStopClick();
  });
  document.getElementById('transcribe-copy-btn')?.addEventListener('click', () => {
    void handleTranscribeCopyClick();
  });
  document.getElementById('transcribe-export-txt')?.addEventListener('click', () => handleTranscribeExport('txt'));
  document.getElementById('transcribe-export-srt')?.addEventListener('click', () => handleTranscribeExport('srt'));
  document.getElementById('transcribe-export-md')?.addEventListener('click', () => handleTranscribeExport('md'));
  document.getElementById('transcribe-save-btn')?.addEventListener('click', () => {
    void handleTranscribeSaveClick();
  });
  document.getElementById('transcribe-segments')?.addEventListener('click', handleTranscribeSegmentSeek);
  document.getElementById('transcribe-edit-btn')?.addEventListener('click', handleTranscribeEditToggle);
  // contenteditable 失焦提交（blur 不冒泡，用 focusout 委托）
  document.getElementById('transcribe-segments')?.addEventListener('focusout', handleTranscribeEditCommit);
  document.querySelectorAll('.transcribe-source-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (transcribeActive) return; // 会话进行中不切换来源
      const source = (btn as HTMLElement).dataset.source;
      if (source !== 'tab' && source !== 'mic' && source !== 'file' && source !== 'url') return;
      transcribeSource = source;
      document.querySelectorAll('.transcribe-source-btn').forEach((b) => {
        b.classList.toggle('active', (b as HTMLElement).dataset.source === source);
      });
      document.getElementById('transcribe-file')?.classList.toggle('hidden', source !== 'file');
      document.getElementById('transcribe-url')?.classList.toggle('hidden', source !== 'url');
      updateTranscribeControls();
      updateTranscribeModeVisibility();
    });
  });
  updateTranscribeControls();

  // 转写模式（Say-So-Scribe）：渲染卡片 + 载入持久化选择 + 后端地址
  void (async () => {
    const stored = await chrome.storage.local.get(TRANSCRIBE_MODE_KEY);
    const m = stored?.[TRANSCRIBE_MODE_KEY];
    if (SAYSO_MODES.some((x) => x.key === m)) {
      transcribeMode = m as SaysoMode;
    }
    renderTranscribeModeCards();
    updateTranscribeModeVisibility();
    const urlInput = document.getElementById('transcribe-sayso-url') as HTMLInputElement | null;
    if (urlInput) {
      urlInput.value = await getSaysoBackendUrl();
      urlInput.addEventListener('change', () => {
        void setSaysoBackendUrl(urlInput.value);
      });
    }
  })();
}

function renderRuntimeDiagnostics(viewModel: RuntimeDiagnosticsViewModel): void {
  if (runtimeStatusElements.badge) {
    runtimeStatusElements.badge.textContent = viewModel.stateText;
    runtimeStatusElements.badge.className = `px-2 py-0.5 rounded text-xs ${viewModel.stateClassName}`;
  }
  if (runtimeStatusElements.platform) {
    runtimeStatusElements.platform.textContent = viewModel.platformText;
  }
  if (runtimeStatusElements.lastExtract) {
    runtimeStatusElements.lastExtract.textContent = viewModel.lastExtractText;
  }
  if (runtimeStatusElements.lastSave) {
    runtimeStatusElements.lastSave.textContent = viewModel.lastSaveText;
  }
  if (runtimeStatusElements.lastError) {
    runtimeStatusElements.lastError.textContent = viewModel.lastErrorText;
  }
  if (runtimeStatusElements.actionTip) {
    runtimeStatusElements.actionTip.textContent = viewModel.actionTip;
  }
}

function updateEmptyReasonHint(): void {
  const node = runtimeStatusElements.emptySubtitle;
  if (!node) {
    return;
  }

  if (settingsElements.autoSaveToggle && !settingsElements.autoSaveToggle.checked) {
    node.textContent = '自动保存已关闭，请开启后再试，或使用手动保存。';
    return;
  }

  if (!runtimeDiagnostics) {
    node.textContent = '访问支持的 AI 聊天页面开始记录对话';
    return;
  }

  switch (runtimeDiagnostics.state) {
    case 'INJECTED':
      node.textContent = '页面已注入，请发送一轮消息后等待自动保存。';
      break;
    case 'STALE':
      node.textContent = '状态可能过期，请刷新页面后继续对话。';
      break;
    case 'NO_PERMISSION':
      node.textContent = '页面无注入权限，请在扩展详情开启本站访问权限。';
      break;
    case 'NOT_INJECTED':
      node.textContent = '页面未注入，请刷新页面或重新加载扩展。';
      break;
    case 'UNSUPPORTED':
      node.textContent = '当前页面不在支持平台列表中。';
      break;
    default:
      node.textContent = '访问支持的 AI 聊天页面开始记录对话';
      break;
  }
}

async function refreshRuntimeDiagnostics(): Promise<void> {
  if (popupContextInvalidated) {
    return;
  }

  if (!ENABLE_RUNTIME_DIAGNOSTICS) {
    return;
  }

  try {
    const activeTab = await getActiveTab();
    const url = activeTab?.url || '';
    const tabId = activeTab?.id;
    const platform = getPlatformFromUrl(url);
    const injectable = isSupportedPlatformUrl(url);

    let runtimeStatus: TabRuntimeStatus | null = null;
    let pingSuccess = false;
    let pingError: string | undefined;

    if (injectable && typeof tabId === 'number') {
      const statusResponse = await safeSendRuntimeMessage({
        type: 'getTabRuntimeStatus',
        tabId,
      });
      runtimeStatus = extractRuntimeStatus(statusResponse as ChromeMessageResponse<any>);

      if (!runtimeStatus) {
        const pingResult = await pingContentScript(tabId);
        pingSuccess = pingResult.success;
        pingError = pingResult.error;

        if (pingSuccess) {
          const refreshed = await safeSendRuntimeMessage({
            type: 'getTabRuntimeStatus',
            tabId,
          });
          runtimeStatus = extractRuntimeStatus(refreshed as ChromeMessageResponse<any>);
        }
      }
    }

    const viewModel = buildRuntimeDiagnosticsViewModel({
      url,
      platform,
      injectable,
      runtimeStatus,
      pingSuccess,
      pingError,
    });
    runtimeDiagnostics = viewModel;
    renderRuntimeDiagnostics(viewModel);
    updateEmptyReasonHint();
  } catch (error) {
    logPopupError('刷新运行态诊断', error);
  }
}

// ============================================================================
// 初始化
// ============================================================================

/**
 * 初始化弹窗
 */
export function initPopup() {
  Logger.info('[Popup] 初始化弹窗');

  try {
    installPopupGlobalErrorGuard((error) => {
      handleContextInvalidated('全局异常', error);
    });
    getRefreshQueue();

    // 初始化国际化
    I18n.initPageI18n();
    void initializeFirstOpenOverlay();

    // 兼容旧版 DOM：确保 About 区域不出现 Official Site 入口
    removeLegacyOfficialSiteEntry();

    // 设置版本号
    setVersionNumber();
    renderSupportedPlatforms();

    // 初始化设置管理
    initializeSettingsManagement();

    // 初始化筛选功能（模块状态 + UI 事件）
    initializeSearchFilterModule();
    initializeFilterUI();

    // 初始化记忆列表
    initializeMemoriesList();
    initializeTranslationActions();
    if (ENABLE_RUNTIME_DIAGNOSTICS) {
      enqueueRefresh('refreshRuntimeDiagnostics');
    }
    void selectInitialTab();

    // 初始化详情页
    initializeConversationDetail();
    initializeSnippetDetail();

    // 初始化总结页
    initializeSummaryPage();

    // 初始化 LLM 设置
    initializeLlmSettings();
    initializeImmersiveLlmKey();
    initializeSimulcastSettings();

    // 初始化推荐设置
    initializeRecommendSettings();

    // 监听存储变化
    setupStorageChangeListener();

    // 监听后台消息
    setupMessageListeners();

    // 监听页面可见性变化
    setupVisibilityChangeListener();

    // 监听自定义事件
    setupCustomEventListeners();

    Logger.info('[Popup] 弹窗初始化完成');
  } catch (error) {
    logPopupError('弹窗初始化', error);
  }
}

/**
 * 设置版本号显示
 */
function setVersionNumber() {
  try {
    const manifest = chrome.runtime.getManifest();
    const version = manifest.version || '1.0.0';

    const versionElement = document.getElementById('version-number');
    if (versionElement) {
      versionElement.textContent = version;
    }
  } catch (error) {
    logPopupError('获取版本号', error);
  }
}

async function selectInitialTab(): Promise<void> {
  try {
    // 默认打开「翻译 → 同声传译」
    translateSub = 'simultaneous';
    switchTab('translate');
  } catch (error) {
    logPopupError('选择默认标签页', error);
  }
}

/**
 * 初始化设置管理
 */
function initializeSettingsManagement() {
  Logger.debug('[Popup] 初始化设置管理');

  initializeSettingsInteractions();

  // 首次打开加载设置，默认自动保存开启
  loadSettings();
  enqueueRefresh('refreshLocalStoreStatus');

  // 注册自动保存开关监听
  if (settingsElements.autoSaveToggle) {
    settingsElements.autoSaveToggle.addEventListener(
      'change',
      handleAutoSaveToggleChange
    );
  }
  bindWebCaptureToggleEvents();

  // 注册导出按钮监听
  if (settingsElements.exportBtn) {
    settingsElements.exportBtn.addEventListener('click', handleExportButtonClick);
  }

  // 注册清空按钮监听
  if (settingsElements.clearBtn) {
    settingsElements.clearBtn.addEventListener('click', handleClearButtonClick);
  }

  // 创建导出按钮下拉菜单（可选）
  createExportDropdown();

  // 初始化自定义主题色控件
  initBrandColorControl();

  Logger.debug('[Popup] 设置管理已初始化');
}

/**
 * 初始化记忆列表
 */
function initializeMemoriesList() {
  Logger.debug('[Popup] 初始化记忆列表');

  // 注册标签切换监听（5 栏：翻译/转写/记录/总结/设置）
  const tabTranslate = document.getElementById('tab-translate');
  const tabTranscribe = document.getElementById('tab-transcribe');
  const tabAttention = document.getElementById('tab-attention');
  const tabSummary = document.getElementById('tab-summary');
  const tabSettings = document.getElementById('tab-settings');

  if (tabTranslate) {
    tabTranslate.addEventListener('click', () => switchTab('translate'));
  }
  if (tabTranscribe) {
    tabTranscribe.addEventListener('click', () => switchTab('transcribe'));
  }
  if (tabAttention) {
    tabAttention.addEventListener('click', () => switchTab('attention'));
  }
  if (tabSummary) {
    // 从侧栏进入总结默认落「总结」子页
    tabSummary.addEventListener('click', () => {
      summarySub = 'summary';
      switchTab('summary');
    });
  }
  if (tabSettings) {
    tabSettings.addEventListener('click', () => switchTab('settings'));
  }

  // 翻译子页：沉浸式 / 同声传译
  document.querySelectorAll('.translate-subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyTranslateSub((btn as HTMLElement).dataset.translateSub as 'immersive' | 'simultaneous');
    });
  });
  // 总结子页：总结 / 发现
  document.querySelectorAll('.summary-subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      applySummarySub((btn as HTMLElement).dataset.summarySub as 'summary' | 'discover');
    });
  });

  // 注册导航筛选 pill 按钮
  const filterPills = document.querySelectorAll('#attention-filter-pills .attention-pill');
  filterPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      const filter = (pill as HTMLElement).dataset.filter as AttentionFilter;
      if (filter) {
        switchAttentionFilter(filter);
      }
    });
  });

  // 注册返回列表按钮监听（详情页）
  const backBtn = document.getElementById('back-to-list');
  if (backBtn) {
    backBtn.addEventListener('click', backToList);
  }

  // 初始化数据
  enqueueRefresh('refreshConversations');
  enqueueRefresh('refreshSnippets');
  enqueueRefresh('refreshBrowsingHistory');

  Logger.debug('[Popup] 记忆列表已初始化');
}

/**
 * 初始化筛选功能
 */
function initializeFilterUI() {
  Logger.debug('[Popup] 初始化筛选功能');

  setFilteredConversationsRenderer(() => {
    renderCurrentConversationList();
  });

  // 搜索相关
  if (searchElements.searchInput) {
    searchElements.searchInput.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement | null;
      handleSearchInput(target?.value || '');
    });
  }

  if (searchElements.clearSearch) {
    searchElements.clearSearch.addEventListener('click', clearSearchInput);
  }

  if (searchElements.filterToggle) {
    searchElements.filterToggle.addEventListener('click', () => {
      toggleFilterDropdown();
      refreshPlatformOptionState();
    });
  }

  if (searchElements.applyFilter) {
    searchElements.applyFilter.addEventListener('click', () => {
      applyFilter();
    });
  }

  if (searchElements.clearFilter) {
    searchElements.clearFilter.addEventListener('click', () => {
      clearFilter();
      applyFilter();
      refreshPlatformOptionState();
    });
  }

  if (searchElements.dateWeek) {
    searchElements.dateWeek.addEventListener('click', () => {
      handleDateQuickOptions(7);
      applyFilter();
    });
  }

  if (searchElements.dateMonth) {
    searchElements.dateMonth.addEventListener('click', () => {
      handleDateQuickOptions(30);
      applyFilter();
    });
  }

  if (searchElements.platformTagsContainer) {
    searchElements.platformTagsContainer.addEventListener('click', () => {
      if (searchElements.platformDropdownMenu) {
        searchElements.platformDropdownMenu.classList.toggle('hidden');
      }
    });
  }

  renderPlatformFilterOptions();

  // 多选切换
  const multiSelectToggle = document.getElementById('multi-select-toggle');
  if (multiSelectToggle) {
    multiSelectToggle.addEventListener('click', toggleMultiSelectMode);
  }

  // 导出筛选结果
  const exportFilteredMerged = document.getElementById('export-filtered-merged');
  if (exportFilteredMerged) {
    exportFilteredMerged.addEventListener('click', () => {
      void handleExportFilteredConversations({ exportType: 'merged' });
    });
  }

  const exportFilteredSeparate = document.getElementById('export-filtered-separate');
  if (exportFilteredSeparate) {
    exportFilteredSeparate.addEventListener('click', () => {
      void handleExportFilteredConversations({ exportType: 'separate' });
    });
  }

  const exportFilteredBtn = document.getElementById('export-filtered-btn');
  if (exportFilteredBtn) {
    exportFilteredBtn.addEventListener('click', (event) => {
      event.preventDefault();
      toggleFilteredExportDropdown();
    });
  }

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }

    const exportDropdown = document.getElementById('export-filtered-dropdown');
    if (exportDropdown && !exportDropdown.classList.contains('hidden')) {
      const exportBtn = document.getElementById('export-filtered-btn');
      const inExportArea =
        exportDropdown.contains(target) || (exportBtn ? exportBtn.contains(target) : false);
      if (!inExportArea) {
        exportDropdown.classList.add('hidden');
      }
    }

    if (searchElements.platformDropdownMenu && !searchElements.platformDropdownMenu.classList.contains('hidden')) {
      const inPlatformArea =
        searchElements.platformDropdownMenu.contains(target) ||
        (searchElements.platformTagsContainer
          ? searchElements.platformTagsContainer.contains(target)
          : false);
      if (!inPlatformArea) {
        searchElements.platformDropdownMenu.classList.add('hidden');
      }
    }
  });

  Logger.debug('[Popup] 筛选功能已初始化');
}

/**
 * 初始化对话详情
 */
function initializeConversationDetail() {
  Logger.debug('[Popup] 初始化对话详情');

  const editBtn = conversationDetailElements.editTitle;
  const titleInput = conversationDetailElements.detailTitleInput as HTMLInputElement | null;
  const moreActionsBtn = conversationDetailElements.moreActions;
  const dropdown = conversationDetailElements.moreActionsDropdown;

  if (editBtn) {
    editBtn.addEventListener('click', () => {
      if (titleInput && !titleInput.classList.contains('hidden')) {
        saveInlineEdit();
      } else {
        startInlineEdit();
      }
    });
  }

  if (titleInput) {
    titleInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        saveInlineEdit();
      } else if (event.key === 'Escape') {
        cancelInlineEdit();
      }
    });
    titleInput.addEventListener('blur', () => {
      if (!titleInput.classList.contains('hidden')) {
        saveInlineEdit();
      }
    });
  }

  if (moreActionsBtn && dropdown) {
    moreActionsBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      dropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (!dropdown.classList.contains('hidden')) {
        const clickedInside =
          dropdown.contains(target) || moreActionsBtn.contains(target);
        if (!clickedInside) {
          hideMoreActionsDropdown();
        }
      }
    });
  }

  if (conversationDetailElements.openOriginal) {
    conversationDetailElements.openOriginal.addEventListener('click', () => {
      openOriginalPage();
    });
  }

  if (conversationDetailElements.copyConversation) {
    conversationDetailElements.copyConversation.addEventListener('click', () => {
      copyCurrentConversation();
    });
  }

  if (conversationDetailElements.deleteConversationDetail) {
    conversationDetailElements.deleteConversationDetail.addEventListener('click', () => {
      deleteCurrentConversation();
    });
  }

  // 初始化状态同步
  syncDetailPageState();

  Logger.debug('[Popup] 对话详情已初始化');
}

function initializeSnippetDetail() {
  snippetsListElements.saveCurrentPage?.addEventListener('click', () => {
    void handleSaveCurrentPageSnippet();
  });

  snippetsListElements.toggleMergeMode?.addEventListener('click', () => {
    toggleSnippetSelectionMode();
  });

  snippetsListElements.mergeSelected?.addEventListener('click', () => {
    void mergeSelectedSnippets();
  });

  snippetDetailElements.back?.addEventListener('click', () => {
    hideSnippetDetail();
    switchTab('attention');
  });

  snippetDetailElements.openOriginal?.addEventListener('click', () => {
    openCurrentSnippetOriginalPage();
  });

  snippetDetailElements.openSavedCopy?.addEventListener('click', () => {
    openCurrentSnippetSavedCopy();
  });

  snippetDetailElements.rebuildBtn?.addEventListener('click', () => {
    void rebuildCurrentTabHighlights();
  });

  snippetDetailElements.deleteBtn?.addEventListener('click', () => {
    const snippet = getCurrentSnippet();
    if (!snippet) {
      return;
    }
    void deleteSnippetById(snippet.id);
  });

  snippetFilterElements.searchInput?.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | null;
    updateSnippetFilters({
      query: target?.value || '',
    });
  });

  snippetFilterElements.typeSelect?.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement | null;
    updateSnippetFilters({
      type: (target?.value || 'all') as SnippetFilterType,
    });
  });

  snippetFilterElements.sourceSelect?.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement | null;
    updateSnippetFilters({
      source: (target?.value || 'all') as SnippetFilterSource,
    });
  });

  snippetFilterElements.dateSelect?.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement | null;
    updateSnippetFilters({
      dateRange: (target?.value || 'all') as SnippetFilterDate,
    });
  });

  syncSnippetFilterUI();
  updateSnippetMergeControls();
}

/**
 * 同步详情页状态
 */
function syncDetailPageState() {
  const detailPage = document.getElementById('conversation-detail');
  const memoriesTab = document.getElementById('tab-attention');

  if (!detailPage || !memoriesTab) {
    return;
  }

  const isDetailVisible = !detailPage.classList.contains('hidden');

  if (!isDetailVisible) {
    Logger.debug('[Popup] 详情页隐藏，无需同步');
    return;
  }

  // 详情页可见，标签页隐藏 - 说明用户在详情页
  if (!memoriesTab.classList.contains('active')) {
    Logger.debug('[Popup] 标签页未激活');
    return;
  }

  Logger.debug('[Popup] 同步详情页状态');
}

// ============================================================================
// 存储变化监听
// ============================================================================

/**
 * 设置存储变化监听
 */
function setupStorageChangeListener() {
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.sidebar_refresh_trigger) {
      Logger.info('[Popup] 检测到存储变化');

      // 刷新列表数据
      enqueueRefresh('refreshConversations');
      enqueueRefresh('refreshSnippets');

      // 刷新存储使用情况
      enqueueRefresh('refreshStorageStats');
      enqueueRefresh('refreshLocalStoreStatus');

      // 如果当前在详情页，也刷新详情页
      refreshDetailPageIfActive();
    }
  });
}

// ============================================================================
// 后台消息监听
// ============================================================================

/**
 * 设置后台消息监听
 */
function setupMessageListeners() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const messageType = message?.type;
    Logger.debug('[Popup] 收到后台消息:', messageType);

    const asyncHandlers: Record<string, (m: any, r: (resp: any) => void) => Promise<void>> = {
      manualSave: handleManualSave,
      toggleSidebar: handleToggleSidebar,
      exportConversations: handleExportConversations,
    };

    const notificationHandlers: Record<string, (m: any, r: (resp: any) => void) => void> = {
      settingsUpdated: handleSettingsUpdated,
      'simulcast:update': handleSimulcastUpdate,
      'simulcast:popupUpdate': handleSimulcastUpdate,
      'simulcast:videoPlaying': handleSimulcastVideoPlaying,
    };

    const handler = typeof messageType === 'string' ? asyncHandlers[messageType] : undefined;
    const notificationHandler =
      typeof messageType === 'string' ? notificationHandlers[messageType] : undefined;
    const decision = popupMessageRouter.classify(messageType, Boolean(handler));

    if (decision.kind === 'notification' && notificationHandler) {
      notificationHandler(message, sendResponse);
      return false;
    }

    if (decision.kind === 'handled' && handler) {
      void handler(message, sendResponse);
      return true;
    }

    if (decision.kind === 'unknown' && decision.shouldLogUnknown) {
      Logger.debug('[Popup] 未识别消息类型（采样日志）:', messageType);
    }

    return false;
  });
}

/**
 * 处理获取所有对话
 */
async function handleGetAllConversations(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  try {
    const response = await safeSendRuntimeMessage<unknown, Conversation[]>({
      type: 'getAllConversations',
    });
    const conversations = extractConversationsFromResponse(response);

    cachedConversations = conversations;
    setAllConversations(conversations);
    renderCurrentConversationList();

    sendResponse({ status: 'ok', conversations });
  } catch (error) {
    logPopupError('获取对话列表', error);
    sendResponse({
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 处理设置更新
 */
function handleSettingsUpdated(
  message: any,
  sendResponse: (response: any) => void
): void {
  if (message.settings) {
    updateUI(message.settings);
    enqueueRefresh('refreshLocalStoreStatus');
    enqueueRefresh('refreshStorageStats');
  }

  sendResponse({ status: 'ok' });
}

/**
 * 处理获取设置
 */
async function handleGetSettings(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  try {
    const result = await safeSendRuntimeMessage({
      type: 'getSettings',
    });

    if (result.settings) {
      updateUI(result.settings);
      enqueueRefresh('refreshLocalStoreStatus');
      enqueueRefresh('refreshStorageStats');
    }

    sendResponse(result);
  } catch (error) {
    logPopupError('获取设置', error);
    sendResponse({ status: 'error', error: getErrorMessage(error) });
  }
}

/**
 * 处理手动保存
 */
async function handleManualSave(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  try {
    if (message.url) {
      // 执行手动保存逻辑
      Logger.info('[Popup] 执行手动保存:', message.url);

      // 可以在这里添加保存动画或通知
      showToast(chrome.i18n.getMessage('saveSuccess') || '已保存', 'success');
    }
  } catch (error) {
    logPopupError('手动保存', error);
  }

  sendResponse({ status: 'ok' });
}

/**
 * 处理切换侧边栏
 */
async function handleToggleSidebar(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  try {
    Logger.info('[Popup] 切换侧边栏');

    await safeSendRuntimeMessage({
      type: 'toggleSidebar',
    });

    sendResponse({ status: 'ok' });
  } catch (error) {
    logPopupError('切换侧边栏', error);
    sendResponse({ status: 'error', error: getErrorMessage(error) });
  }
}

/**
 * 处理导出对话
 */
async function handleExportConversations(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  try {
    Logger.info('[Popup] 导出对话:', message.exportType);

    // 触发导出事件到记忆列表模块处理
    window.dispatchEvent(
      new CustomEvent('export-conversations', {
        detail: message.detail,
      })
    );

    sendResponse({ status: 'ok' });
  } catch (error) {
    logPopupError('导出对话', error);
    sendResponse({ status: 'error', error: getErrorMessage(error) });
  }
}

// ============================================================================
// 页面可见性变化监听
// ============================================================================

/**
 * 设置页面可见性变化监听
 */
function setupVisibilityChangeListener() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      Logger.debug('[Popup] 弹窗变为可见');

      // 如果当前在记忆列表页面，刷新列表
      if (
        memoriesListElements.memoriesContent &&
        memoriesListElements.memoriesContent.classList.contains('active')
      ) {
        enqueueRefresh('refreshConversations');
      }

      if (
        snippetsListElements.snippetsContent &&
        snippetsListElements.snippetsContent.classList.contains('active')
      ) {
        enqueueRefresh('refreshSnippets');
      }

      // 刷新存储存储使用情况
      enqueueRefresh('refreshStorageStats');
      enqueueRefresh('refreshLocalStoreStatus');
      if (ENABLE_RUNTIME_DIAGNOSTICS) {
        enqueueRefresh('refreshRuntimeDiagnostics');
      }

      // 如果当前在详情页，也刷新详情页
      refreshDetailPageIfActive();
    }
  });
}

// ============================================================================
// 自定义事件监听
// ============================================================================

/**
 * 设置自定义事件监听
 */
function setupCustomEventListeners() {
  // 对话详情事件
  document.addEventListener('show-conversation', (event) => {
    const detailEvent = event as CustomEvent;
    handleShowConversation(detailEvent.detail);
  });

  document.addEventListener('edit-conversation', (event) => {
    const editEvent = event as CustomEvent;
    handleEditConversation(editEvent.detail);
  });

  document.addEventListener('delete-conversation', (event) => {
    const deleteEvent = event as CustomEvent;
    handleDeleteConversation(deleteEvent.detail);
  });

  document.addEventListener('show-snippet', (event) => {
    const snippetEvent = event as CustomEvent<{ snippetId?: string; snippet?: Snippet }>;
    const snippetId = snippetEvent.detail?.snippetId || snippetEvent.detail?.snippet?.id;
    if (!snippetId) {
      return;
    }
    void openSnippetDetailById(snippetId);
  });

  document.addEventListener('toggle-snippet-selection', (event) => {
    const selectionEvent = event as CustomEvent<{ snippetId?: string }>;
    const snippetId = selectionEvent.detail?.snippetId;
    if (!snippetSelectionMode || !snippetId) {
      return;
    }

    if (selectedSnippetIds.has(snippetId)) {
      selectedSnippetIds.delete(snippetId);
      snippetSelectionOrder = snippetSelectionOrder.filter((id) => id !== snippetId);
    } else {
      selectedSnippetIds.add(snippetId);
      snippetSelectionOrder.push(snippetId);
    }

    updateSnippetMergeControls();
    renderCurrentSnippetList();
  });

  document.addEventListener('focus-snippet-item', (event) => {
    const focusEvent = event as CustomEvent<{ itemId?: string }>;
    const itemId = focusEvent.detail?.itemId;
    if (!itemId) {
      return;
    }
    void focusSnippetItemInActiveTab(itemId);
  });

  document.addEventListener('delete-snippet-item', (event) => {
    const deleteEvent = event as CustomEvent<{ itemId?: string }>;
    const itemId = deleteEvent.detail?.itemId;
    if (!itemId) {
      return;
    }
    void deleteSnippetItemById(itemId);
  });

  // 切换多选模式
  document.addEventListener('toggle-multi-select', () => {
    toggleMultiSelectMode();
  });

  document.addEventListener('toggle-conversation-selection', (event) => {
    const selectionEvent = event as CustomEvent<{ conversationId?: string }>;
    const conversationId = selectionEvent.detail?.conversationId;
    if (!conversationId) {
      return;
    }

    if (selectedConversationIds.has(conversationId)) {
      selectedConversationIds.delete(conversationId);
    } else {
      selectedConversationIds.add(conversationId);
    }
    renderCurrentConversationList();
  });

  // 导出筛选结果
  document.addEventListener('export-filtered-conversations', (event) => {
    const exportEvent = event as CustomEvent;
    void handleExportFilteredConversations(exportEvent.detail);
  });

  document.addEventListener('export-all-conversations', () => {
    void handleExportFilteredConversations({
      exportType: 'separate',
      scope: 'all',
    });
  });

  document.addEventListener('copy-current-conversation', (event) => {
    const copyEvent = event as CustomEvent<Conversation>;
    const conversation = copyEvent.detail;
    if (!conversation) {
      return;
    }
    void copyConversationToClipboard(conversation);
  });

  // 清空存储
  document.addEventListener('show-clear-confirm', () => {
    void handleClearStorage();
  });
}

/**
 * 处理显示对话事件
 */
function handleShowConversation(detail: any): void {
  if (!detail || !detail.conversation) {
    return;
  }

  renderConversationDetail(detail.conversation);
}

/**
 * 处理编辑对话事件
 */
function handleEditConversation(detail: any): void {
  if (!detail || !detail.conversationId) {
    return;
  }

  const newTitle = prompt(
    chrome.i18n.getMessage('editConversationTitle') || '编辑标题',
    detail.title || ''
  );
  if (!newTitle || !newTitle.trim() || newTitle.trim() === detail.title) {
    return;
  }

  void updateConversationTitle(detail.conversationId, newTitle.trim());
}

/**
 * 处理删除对话事件
 */
function handleDeleteConversation(detail: any): void {
  if (!detail || !detail.conversationId) {
    return;
  }

  showDeleteModal(detail.conversationId, detail.title);
}

// ============================================================================
// 标签切换
// ============================================================================

/**
 * 切换标签页
 */
// ============================================================================
// 总结页逻辑
// ============================================================================

let currentSummaryMode: 'weekly' | 'topic' | 'psychology' = 'weekly';
let summaryPollTimer: ReturnType<typeof setInterval> | null = null;

const MODE_LABELS: Record<string, string> = {
  weekly: 'AI 互动周报',
  topic: '主题复盘',
  psychology: '心理洞察',
};

function initializeSummaryPage(): void {
  // 模式 pill 切换
  const pills = document.querySelectorAll('.summary-mode-pill');
  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      const mode = (pill as HTMLElement).dataset.summaryMode as typeof currentSummaryMode;
      if (!mode) return;
      currentSummaryMode = mode;

      pills.forEach((p) => {
        const el = p as HTMLElement;
        if (el.dataset.summaryMode === mode) {
          el.classList.add('active');
          el.classList.remove('bg-gray-100', 'text-gray-600');
        } else {
          el.classList.remove('active');
          el.classList.add('bg-gray-100', 'text-gray-600');
        }
      });

      const topicGroup = document.getElementById('topic-input-group');
      if (topicGroup) {
        topicGroup.classList.toggle('hidden', mode !== 'topic');
      }
    });
  });

  // 生成按钮
  const generateBtn = document.getElementById('generate-summary-btn');
  if (generateBtn) {
    generateBtn.addEventListener('click', () => {
      void handleCreateSummaryTask();
    });
  }

  // 返回按钮（结果详情 → 任务列表）
  const backBtn = document.getElementById('summary-result-back');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      showSummaryTaskList();
    });
  }

  // 加载已有任务
  void refreshSummaryTasks();
}

async function handleCreateSummaryTask(): Promise<void> {
  const topic = (document.getElementById('summary-topic-input') as HTMLInputElement | null)?.value || '';

  try {
    await safeSendRuntimeMessage({
      type: 'createSummaryTask',
      mode: currentSummaryMode,
      topic,
      conversations: cachedConversations,
      snippets: cachedSnippets,
      history: cachedHistory,
    });
    showToast('任务已创建', 'success');
    void refreshSummaryTasks();
    startSummaryPolling();
  } catch (error) {
    logPopupError('创建总结任务', error);
  }
}

function startSummaryPolling(): void {
  stopSummaryPolling();
  summaryPollTimer = setInterval(() => {
    void refreshSummaryTasks();
  }, 3000);
}

function stopSummaryPolling(): void {
  if (summaryPollTimer) {
    clearInterval(summaryPollTimer);
    summaryPollTimer = null;
  }
}

async function refreshSummaryTasks(): Promise<void> {
  if (popupContextInvalidated) {
    stopSummaryPolling();
    return;
  }

  try {
    const response = await safeSendRuntimeMessage({ type: 'getSummaryTasks' });
    const tasks: any[] = (response as any)?.tasks || (response as any)?.data?.tasks || [];
    renderSummaryTaskList(tasks);

    const hasActive = tasks.some((t: any) => t.status === 'running' || t.status === 'pending');
    if (!hasActive) {
      stopSummaryPolling();
    }
  } catch (error) {
    stopSummaryPolling();
    logPopupError('获取总结任务', error);
  }
}

function showSummaryTaskList(): void {
  const listEl = document.getElementById('summary-task-list');
  const resultView = document.getElementById('summary-result-view');
  const emptyEl = document.getElementById('summary-empty');
  const recommendBtn = document.getElementById('summary-to-recommend-btn');
  if (listEl) listEl.classList.remove('hidden');
  if (resultView) resultView.classList.add('hidden');
  if (emptyEl) emptyEl.classList.add('hidden');
  if (recommendBtn) recommendBtn.classList.add('hidden');
}

function renderSummaryTaskList(tasks: any[]): void {
  const listEl = document.getElementById('summary-task-list');
  const emptyEl = document.getElementById('summary-empty');
  const resultView = document.getElementById('summary-result-view');

  if (!listEl) return;
  // 如果结果详情正在显示，不覆盖
  if (resultView && !resultView.classList.contains('hidden')) return;

  if (!tasks.length) {
    listEl.classList.add('hidden');
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }

  if (emptyEl) emptyEl.classList.add('hidden');
  listEl.classList.remove('hidden');

  const container = listEl.querySelector('div') || listEl;
  container.innerHTML = '';

  tasks.forEach((task: any) => {
    const card = document.createElement('div');
    card.className = 'memory-card bg-white p-3 rounded-lg shadow-sm';

    const modeLabel = MODE_LABELS[task.mode] || task.mode;
    const topicSuffix = task.topic ? `: ${escapeHtml(task.topic)}` : '';
    const time = formatTimestamp(task.createdAt);

    let statusIcon = '';
    let statusText = '';
    let statusClass = '';
    let clickable = false;

    switch (task.status) {
      case 'pending':
        statusIcon = '<i class="fas fa-clock text-gray-400"></i>';
        statusText = '等待中...';
        statusClass = 'text-gray-400';
        break;
      case 'running':
        statusIcon = '<i class="fas fa-spinner fa-spin text-brand"></i>';
        statusText = task.progress || '生成中...';
        statusClass = 'text-brand';
        break;
      case 'done':
        statusIcon = '<i class="fas fa-check-circle text-green-500"></i>';
        statusText = '已完成';
        statusClass = 'text-green-600';
        clickable = true;
        break;
      case 'error':
        statusIcon = '<i class="fas fa-exclamation-circle text-red-500"></i>';
        statusText = task.error || '失败';
        statusClass = 'text-red-500';
        break;
    }

    if (clickable) {
      card.classList.add('cursor-pointer', 'hover:border-gray-300');
      card.addEventListener('click', () => {
        void viewSummaryResult(task.id, `${modeLabel}${topicSuffix}`);
      });
    }

    card.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="flex-shrink-0">${statusIcon}</div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-gray-800 truncate">${escapeHtml(modeLabel)}${topicSuffix}</div>
          <div class="flex items-center gap-2 mt-1">
            <span class="text-xs ${statusClass}">${escapeHtml(statusText)}</span>
            <span class="text-xs text-gray-300">&middot;</span>
            <span class="text-xs text-gray-400">${time}</span>
          </div>
        </div>
        ${clickable ? '<i class="fas fa-chevron-right text-gray-300 text-xs flex-shrink-0"></i>' : ''}
      </div>
    `;

    container.appendChild(card);
  });
}

async function viewSummaryResult(taskId: string, title: string): Promise<void> {
  const listEl = document.getElementById('summary-task-list');
  const resultView = document.getElementById('summary-result-view');
  const resultContent = document.getElementById('summary-result-content');
  const resultTitle = document.getElementById('summary-result-title');

  if (listEl) listEl.classList.add('hidden');
  if (resultView) resultView.classList.remove('hidden');
  if (resultTitle) resultTitle.textContent = title;
  if (resultContent) resultContent.innerHTML = '<i class="fas fa-spinner fa-spin text-gray-400"></i>';

  try {
    const response = await safeSendRuntimeMessage({ type: 'getSummaryTaskResult', taskId });
    const result = (response as any)?.result || (response as any)?.data?.result;

    if (resultContent) {
      resultContent.innerHTML = result ? renderMarkdownToHtml(result) : '<p class="text-gray-400">无内容</p>';
    }
  } catch (error) {
    logPopupError('获取总结结果', error);
    if (resultContent) {
      resultContent.innerHTML = `<p class="text-red-500">获取失败</p>`;
    }
  }

  const recommendBtn = document.getElementById('summary-to-recommend-btn') as HTMLButtonElement | null;
  if (recommendBtn) {
    recommendBtn.classList.remove('hidden');
    recommendBtn.disabled = false;
    recommendBtn.onclick = () => {
      recommendBtn.disabled = true;
      jumpToRecommendFromSummary(taskId);
    };
  }
}

// ============================================================================
// LLM 设置
// ============================================================================

function initializeSimulcastSettings(): void {
  void (async () => {
    const [settings, localPrefill] = await Promise.all([
      getStoredSettings(),
      loadLocalCredentialPrefill(),
    ]);
    const defaults = DEFAULT_SETTINGS.simultaneousInterpretation;
    if (!defaults) {
      return;
    }

    const simulcast = resolveSimulcastCredentialPrefill(
      settings?.simultaneousInterpretation,
      localPrefill.simultaneousInterpretation,
      defaults
    );

    setControlValue('simulcast-source-language', simulcast.sourceLanguage);
    setControlValue('simulcast-target-language', simulcast.targetLanguage);
    setControlValue('simulcast-model', simulcast.model);
    setControlValue('simulcast-api-key', simulcast.credentials.apiKey);
    setControlValue('simulcast-app-id', simulcast.credentials.appId);
    setControlValue('simulcast-access-token', simulcast.credentials.accessToken);
    setControlValue('simulcast-secret-key', simulcast.credentials.secretKey);
    setControlValue('simulcast-output-mode', simulcast.audioOutputMode);
    setControlValue('simulcast-subtitle-mode', simulcast.subtitleDisplayMode);
    setControlValue('simulcast-original-volume', simulcast.originalVolume);
    setControlValue('simulcast-translated-volume', simulcast.translatedVolume);
    setControlValue('simulcast-translated-delay-ms', simulcast.translatedAudioDelayMs);

    const voiceCloneToggle = document.getElementById(
      'simulcast-voice-clone-toggle'
    ) as HTMLInputElement | null;
    if (voiceCloneToggle) {
      voiceCloneToggle.checked = simulcast.voiceCloneEnabled;
    }

    // 自动同传开关：持久化 + 打开页面时若视频在播放则自动启动
    const autoToggle = document.getElementById('simulcast-auto-toggle') as HTMLInputElement | null;
    if (autoToggle) {
      const stored = await chrome.storage.local.get(AUTO_SIMULCAST_STORAGE_KEY);
      autoSimulcastEnabled = stored?.[AUTO_SIMULCAST_STORAGE_KEY] === true;
      autoToggle.checked = autoSimulcastEnabled;
      autoToggle.addEventListener('change', () => {
        autoSimulcastEnabled = autoToggle.checked;
        void chrome.storage.local.set({ [AUTO_SIMULCAST_STORAGE_KEY]: autoSimulcastEnabled });
        if (autoSimulcastEnabled) void queryActiveTabAndMaybeAutoStart();
      });
      if (autoSimulcastEnabled) void queryActiveTabAndMaybeAutoStart();
    }
  })();
}

function initializeLlmSettings(): void {
  const providerSelect = document.getElementById('llm-provider') as HTMLSelectElement | null;
  const baseUrlGroup = document.getElementById('llm-base-url-group');
  const saveBtn = document.getElementById('save-llm-config');
  const statusEl = document.getElementById('llm-config-status');

  // 显示/隐藏 base URL
  providerSelect?.addEventListener('change', () => {
    if (baseUrlGroup) {
      baseUrlGroup.classList.toggle('hidden', providerSelect.value !== 'custom');
    }
  });

  // 加载已保存的配置
  void (async () => {
    const [settings, localPrefill] = await Promise.all([
      getStoredSettings(),
      loadLocalCredentialPrefill(),
    ]);
    const llm = resolveLlmCredentialPrefill(
      settings?.llmApi ?? DEFAULT_SETTINGS.llmApi,
      localPrefill.llmApi
    );
    if (llm) {
      if (providerSelect) providerSelect.value = llm.provider || 'bailian';
      const keyInput = document.getElementById('llm-api-key') as HTMLInputElement | null;
      if (keyInput) keyInput.value = llm.apiKey || '';
      const baseUrlInput = document.getElementById('llm-base-url') as HTMLInputElement | null;
      if (baseUrlInput) baseUrlInput.value = llm.baseUrl || '';
      const modelInput = document.getElementById('llm-model') as HTMLInputElement | null;
      if (modelInput) modelInput.value = llm.model || 'qwen-plus';
      if (baseUrlGroup) {
        baseUrlGroup.classList.toggle('hidden', llm.provider !== 'custom');
      }
    }
  })();

  // 保存
  saveBtn?.addEventListener('click', () => {
    const provider = (providerSelect?.value || 'bailian') as 'bailian' | 'openai' | 'custom';
    const apiKey = (document.getElementById('llm-api-key') as HTMLInputElement | null)?.value || '';
    const baseUrl = (document.getElementById('llm-base-url') as HTMLInputElement | null)?.value || '';
    const model = (document.getElementById('llm-model') as HTMLInputElement | null)?.value || 'qwen-plus';

    if (!apiKey) {
      if (statusEl) {
        statusEl.textContent = '请输入 API Key';
        statusEl.className = 'text-xs text-red-500 text-center';
        statusEl.classList.remove('hidden');
      }
      return;
    }

    chrome.storage.sync.get(['settings'], (result) => {
      const settings: AppSettings = result.settings || { ...DEFAULT_SETTINGS };
      settings.llmApi = { provider, apiKey, baseUrl: baseUrl || undefined, model: model || undefined };
      chrome.storage.sync.set({ settings }, () => {
        if (statusEl) {
          statusEl.textContent = '✓ 已保存';
          statusEl.className = 'text-xs text-green-600 text-center';
          statusEl.classList.remove('hidden');
          setTimeout(() => statusEl.classList.add('hidden'), 2000);
        }
      });
    });
  });
}

/** 沉浸式翻译页的 LLM API Key：与「设置」页共用 settings.llmApi.apiKey。 */
function initializeImmersiveLlmKey(): void {
  const input = document.getElementById('immersive-llm-api-key') as HTMLInputElement | null;
  if (!input) return;

  void Promise.all([getStoredSettings(), loadLocalCredentialPrefill()]).then(
    ([settings, localPrefill]) => {
      const llm = resolveLlmCredentialPrefill(
        settings?.llmApi ?? DEFAULT_SETTINGS.llmApi,
        localPrefill.llmApi
      );
      input.value = llm?.apiKey || '';
    }
  );

  input.addEventListener('change', () => {
    chrome.storage.sync.get(['settings'], (result) => {
      const settings: AppSettings = result.settings || { ...DEFAULT_SETTINGS };
      const base = settings.llmApi ?? DEFAULT_SETTINGS.llmApi ?? { provider: 'bailian' as const };
      settings.llmApi = { ...base, apiKey: input.value.trim() };
      chrome.storage.sync.set({ settings });
      // 同步「设置」页同一字段
      const settingsKey = document.getElementById('llm-api-key') as HTMLInputElement | null;
      if (settingsKey) settingsKey.value = input.value;
    });
  });
}

// ============================================================================
// 推荐设置
// ============================================================================

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function initializeRecommendSettings(): void {
  const saveBtn = settingsElements.recommendSaveBtn;
  const statusEl = settingsElements.recommendSaveStatus;

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const enabled = settingsElements.recommendEnabledToggle?.checked ?? false;
      const exaApiKey = (settingsElements.recommendExaKey?.value ?? '').trim();
      const dataWindowDays = clamp(parseInt(settingsElements.recommendWindowDays?.value ?? '14', 10), 1, 30);
      const cacheTtlHours = clamp(parseInt(settingsElements.recommendCacheHours?.value ?? '24', 10), 1, 168);

      await chrome.runtime.sendMessage({
        type: 'updateSettings',
        settings: {
          recommend: { enabled, exaApiKey, dataWindowDays, cacheTtlHours },
        },
      });

      if (statusEl) {
        statusEl.classList.remove('hidden');
        setTimeout(() => statusEl.classList.add('hidden'), 2000);
      }
    });
  }
}

type PopupTabName = 'translate' | 'transcribe' | 'attention' | 'summary' | 'settings';

function switchTab(tabName: PopupTabName): void {
  Logger.debug(`[Popup] 切换标签页: ${tabName}`);

  const tabs = document.querySelectorAll('.sidebar-btn');
  const contents = document.querySelectorAll('.tab-content');

  // 隐藏详情页
  if (conversationDetailElements.conversationDetail) {
    conversationDetailElements.conversationDetail.classList.add('hidden');
  }
  hideSnippetDetail();

  // 更新标签按钮样式
  tabs.forEach((tab) => {
    tab.classList.toggle('active', tab.id === `tab-${tabName}`);
  });

  // 先隐藏全部面板
  contents.forEach((content) => {
    content.classList.remove('active');
    content.classList.add('hidden');
  });

  // 显示当前面板：翻译/总结由子页决定，其余按 `${tab}-content`
  if (tabName === 'translate') {
    applyTranslateSub(translateSub);
  } else if (tabName === 'summary') {
    applySummarySub(summarySub);
  } else {
    const el = document.getElementById(`${tabName}-content`);
    if (el) {
      el.classList.add('active');
      el.classList.remove('hidden');
    }
    onRecommendTabDeactivated();
  }

  // 显示主导航和概览（从详情页返回时）
  const dataOverview = document.querySelector('header');
  if (dataOverview && tabName !== 'settings') {
    dataOverview.classList.remove('hidden');
  }

  // 刷新数据
  if (tabName === 'attention') {
    enqueueRefresh('refreshConversations');
    enqueueRefresh('refreshSnippets');
    enqueueRefresh('refreshBrowsingHistory');
    enqueueRefresh('refreshStorageStats');
  }
}

/** 翻译 tab 子页切换：沉浸式 / 同声传译。 */
function applyTranslateSub(sub: 'immersive' | 'simultaneous'): void {
  translateSub = sub;
  document.querySelectorAll('.translate-subtab').forEach((btn) => {
    const el = btn as HTMLElement;
    el.classList.toggle('active', el.dataset.translateSub === sub);
  });
  const immersive = document.getElementById('immersive-translation-content');
  const simultaneous = document.getElementById('simultaneous-interpretation-content');
  const show = sub === 'immersive' ? immersive : simultaneous;
  const hide = sub === 'immersive' ? simultaneous : immersive;
  hide?.classList.remove('active');
  hide?.classList.add('hidden');
  show?.classList.add('active');
  show?.classList.remove('hidden');
  onRecommendTabDeactivated();
}

/** 总结 tab 子页切换：总结 / 发现（发现复用原推荐页与控制器）。 */
function applySummarySub(sub: 'summary' | 'discover'): void {
  summarySub = sub;
  document.querySelectorAll('.summary-subtab').forEach((btn) => {
    const el = btn as HTMLElement;
    el.classList.toggle('active', el.dataset.summarySub === sub);
  });
  const summaryEl = document.getElementById('summary-content');
  const recEl = document.getElementById('recommend-content');
  if (sub === 'discover') {
    summaryEl?.classList.remove('active');
    summaryEl?.classList.add('hidden');
    recEl?.classList.add('active');
    recEl?.classList.remove('hidden');
    const params = pendingRecommendParams;
    pendingRecommendParams = null;
    void onRecommendTabActivated(params ?? undefined);
  } else {
    recEl?.classList.remove('active');
    recEl?.classList.add('hidden');
    summaryEl?.classList.add('active');
    summaryEl?.classList.remove('hidden');
    onRecommendTabDeactivated();
  }
}

/**
 * 切换注意力筛选
 */
function switchAttentionFilter(filter: AttentionFilter): void {
  currentAttentionFilter = filter;

  // 更新 pill 按钮样式
  const pills = document.querySelectorAll('#attention-filter-pills .attention-pill');
  pills.forEach((pill) => {
    const el = pill as HTMLElement;
    if (el.dataset.filter === filter) {
      el.classList.add('active');
      el.classList.remove('bg-gray-100', 'text-gray-600');
    } else {
      el.classList.remove('active');
      el.classList.add('bg-gray-100', 'text-gray-600');
    }
  });

  // 显示/隐藏片段相关操作按钮
  const actionsEl = document.getElementById('attention-actions');
  if (actionsEl) {
    const readOnly =
      filter === 'aichat' ||
      filter === 'history' ||
      filter === 'translation' ||
      filter === 'question' ||
      filter === 'transcribe';
    actionsEl.classList.toggle('hidden', readOnly);
  }


  // 退出选择合并模式（如果切换到非片段筛选）
  if (filter === 'aichat' && snippetSelectionMode) {
    toggleSnippetSelectionMode(false);
  }

  renderAttentionList();
}

// ============================================================================
// 统一加载状态管理
// ============================================================================

function showAttentionLoading(): void {
  attentionLoadingCount++;
  const el = document.getElementById('attention-loading');
  if (el) el.classList.remove('hidden');
}

function hideAttentionLoading(): void {
  attentionLoadingCount = Math.max(0, attentionLoadingCount - 1);
  if (attentionLoadingCount === 0) {
    const el = document.getElementById('attention-loading');
    if (el) el.classList.add('hidden');
  }
}

// ============================================================================
// 列表数据加载与本地操作（T02 最小实现）
// ============================================================================

function extractConversationsFromResponse(
  response: ChromeMessageResponse<Conversation[]>
): Conversation[] {
  if (Array.isArray(response)) {
    return response as unknown as Conversation[];
  }
  if (Array.isArray(response?.conversations)) {
    return response.conversations as Conversation[];
  }
  if (Array.isArray(response?.data)) {
    return response.data as Conversation[];
  }
  return [];
}

function renderCurrentConversationList(): void {
  renderAttentionList();
}

function syncSnippetFilterUI(): void {
  // Snippet filter dropdowns removed; filter is now driven by attention pills
}

function renderCurrentSnippetList(): void {
  renderAttentionList();
}

/** 文字记录归类：按标题前缀 / headingPath 区分 翻译·提问·转写。 */
function matchRecordCategory(
  snippet: Snippet,
  filter: 'translation' | 'question' | 'transcribe'
): boolean {
  const title = (snippet.title || '').trim();
  const heading = Array.isArray(snippet.headingPath) ? snippet.headingPath[0] : undefined;
  if (filter === 'transcribe') {
    return title.startsWith('转写 ·') || title.startsWith('转写·') || heading === '转写';
  }
  if (filter === 'translation') {
    return title.startsWith('翻译 ·') || title.startsWith('翻译·') || heading === '翻译';
  }
  return title.startsWith('提问 ·') || title.startsWith('提问·') || heading === '提问';
}

/**
 * 统一渲染注意力列表（根据当前筛选）
 */
function renderAttentionList(): void {
  const listEl = document.getElementById('attention-list');
  const emptyEl = document.getElementById('attention-empty');
  const loadingEl = document.getElementById('attention-loading');

  if (!listEl) return;

  const listContainer = listEl.querySelector('div') || listEl;

  // 隐藏加载状态
  if (loadingEl) loadingEl.classList.add('hidden');

  const filter = currentAttentionFilter;

  if (filter === 'aichat') {
    // 仅展示 AI 对话
    const conversations = getFilteredConversations();
    if (!conversations.length) {
      listEl.classList.add('hidden');
      if (emptyEl) { emptyEl.classList.remove('hidden'); }
      return;
    }
    if (emptyEl) { emptyEl.classList.add('hidden'); }
    listEl.classList.remove('hidden');
    listContainer.innerHTML = '';
    renderConversationCards({
      conversations,
      isMultiSelectMode,
      selectedConversationIds,
    });
  } else if (filter === 'history') {
    // 仅展示浏览历史
    if (!cachedHistory.length) {
      listEl.classList.add('hidden');
      if (emptyEl) { emptyEl.classList.remove('hidden'); }
      return;
    }
    if (emptyEl) { emptyEl.classList.add('hidden'); }
    listEl.classList.remove('hidden');
    listContainer.innerHTML = '';
    renderHistoryCards(cachedHistory, listContainer);
  } else if (filter === 'highlight' || filter === 'dwell') {
    // 仅展示指定类型的片段
    const filtered = cachedSnippets.filter((s) => s.type === filter);
    if (!filtered.length) {
      listEl.classList.add('hidden');
      if (emptyEl) { emptyEl.classList.remove('hidden'); }
      updateSnippetMergeControls();
      return;
    }
    if (emptyEl) { emptyEl.classList.add('hidden'); }
    listEl.classList.remove('hidden');
    listContainer.innerHTML = '';
    renderSnippetCards(filtered, {
      selectionMode: snippetSelectionMode,
      selectedSnippetIds,
    });
    updateSnippetMergeControls();
  } else if (filter === 'translation' || filter === 'question' || filter === 'transcribe') {
    // 文字记录：翻译 / 提问 / 转写（按标题前缀归类）
    const filtered = cachedSnippets.filter((s) => matchRecordCategory(s, filter));
    if (!filtered.length) {
      listEl.classList.add('hidden');
      if (emptyEl) { emptyEl.classList.remove('hidden'); }
      updateSnippetMergeControls();
      return;
    }
    if (emptyEl) { emptyEl.classList.add('hidden'); }
    listEl.classList.remove('hidden');
    listContainer.innerHTML = '';
    renderSnippetCards(filtered, {
      selectionMode: false,
      selectedSnippetIds,
    });
    updateSnippetMergeControls();
  } else {
    // 全部模式：混合展示
    const conversations = getFilteredConversations();
    const snippets = cachedSnippets;

    if (!conversations.length && !snippets.length) {
      listEl.classList.add('hidden');
      if (emptyEl) { emptyEl.classList.remove('hidden'); }
      return;
    }
    if (emptyEl) { emptyEl.classList.add('hidden'); }
    listEl.classList.remove('hidden');
    listContainer.innerHTML = '';

    // 构建混合时间线
    type TimelineItem = { time: number; type: 'conversation'; data: Conversation } | { time: number; type: 'snippet'; data: Snippet };
    const timeline: TimelineItem[] = [];

    conversations.forEach((c) => {
      timeline.push({
        time: new Date(c.updatedAt || c.createdAt).getTime(),
        type: 'conversation',
        data: c,
      });
    });
    snippets.forEach((s) => {
      timeline.push({
        time: new Date(s.updatedAt || s.createdAt).getTime(),
        type: 'snippet',
        data: s,
      });
    });

    timeline.sort((a, b) => b.time - a.time);

    // 分批渲染：先渲染对话，再渲染片段（各自的 render 函数会 append 到 listContainer）
    // 但由于 renderConversationCards 和 renderSnippetCards 会清空容器，
    // 我们需要逐个创建卡片。使用各自的渲染但分开处理。
    // 简化方案：先渲染对话卡片，再渲染片段卡片，利用 DOM 排序
    const convBatch = timeline.filter((i) => i.type === 'conversation').map((i) => i.data as Conversation);
    const snippetBatch = timeline.filter((i) => i.type === 'snippet').map((i) => i.data as Snippet);

    if (convBatch.length) {
      renderConversationCards({
        conversations: convBatch,
        isMultiSelectMode,
        selectedConversationIds,
        clearContainer: false,
      });
    }
    if (snippetBatch.length) {
      renderSnippetCards(snippetBatch, {
        selectionMode: snippetSelectionMode,
        selectedSnippetIds,
        clearContainer: false,
      });
    }
    updateSnippetMergeControls();
  }
}

function renderHistoryCards(items: BrowsingHistoryItem[], container: Element): void {
  items.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'memory-card bg-white p-3 rounded-lg shadow-sm cursor-pointer';
    card.addEventListener('click', () => {
      void safeCreateTab(item.url);
    });

    const visitTime = formatTimestamp(item.lastVisitTime);
    const domainDisplay = escapeHtml(item.domain);
    const titleDisplay = escapeHtml(item.title || item.url);

    card.innerHTML = `
      <div class="flex items-start gap-2">
        <div class="flex-shrink-0 w-6 h-6 rounded bg-green-50 flex items-center justify-center mt-0.5">
          <i class="fas fa-globe text-green-500 text-xs"></i>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-gray-800 truncate">${titleDisplay}</div>
          <div class="flex items-center gap-2 mt-1">
            <span class="text-xs text-gray-400 truncate">${domainDisplay}</span>
            <span class="text-xs text-gray-300">·</span>
            <span class="text-xs text-gray-400">${item.visitCount} 次访问</span>
          </div>
          <div class="text-xs text-gray-400 mt-1">${visitTime}</div>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

function updateSnippetFilters(partial: Partial<SnippetFilterState>): void {
  snippetFilterState = {
    ...snippetFilterState,
    ...partial,
  };
  syncSnippetFilterUI();
  renderCurrentSnippetList();
}

function getFilteredSnippets(): Snippet[] {
  return filterSnippets(cachedSnippets, snippetFilterState);
}

function clearSnippetSelection(): void {
  selectedSnippetIds.clear();
  snippetSelectionOrder = [];
}

function toggleSnippetSelectionMode(force?: boolean): void {
  snippetSelectionMode = typeof force === 'boolean' ? force : !snippetSelectionMode;
  if (!snippetSelectionMode) {
    clearSnippetSelection();
  }
  updateSnippetMergeControls();
  renderCurrentSnippetList();
}

function getSelectedMergeCandidateSnippets(): Snippet[] {
  return snippetSelectionOrder
    .map((id) => cachedSnippets.find((snippet) => snippet.id === id))
    .filter((snippet): snippet is Snippet => Boolean(snippet && selectedSnippetIds.has(snippet.id)));
}

function canMergeSelectedSnippets(): boolean {
  const selected = getSelectedMergeCandidateSnippets();
  if (selected.length < 2) {
    return false;
  }

  const [first] = selected;
  return selected.every((snippet) => {
    return (
      snippet.type === 'highlight' &&
      snippet.url === first.url &&
      snippet.sourceKind === first.sourceKind
    );
  });
}

function updateSnippetMergeControls(): void {
  if (snippetsListElements.toggleMergeMode) {
    snippetsListElements.toggleMergeMode.textContent = snippetSelectionMode ? '取消选择' : '选择合并';
    snippetsListElements.toggleMergeMode.className = snippetSelectionMode
      ? 'px-3 py-2 text-xs font-medium bg-amber-100 text-amber-800 rounded-lg hover:bg-amber-200 transition-colors'
      : 'px-3 py-2 text-xs font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors';
  }

  const mergeEnabled = canMergeSelectedSnippets();
  if (snippetsListElements.mergeSelected) {
    snippetsListElements.mergeSelected.disabled = !mergeEnabled;
    snippetsListElements.mergeSelected.classList.toggle('opacity-50', !mergeEnabled);
    snippetsListElements.mergeSelected.classList.toggle('cursor-not-allowed', !mergeEnabled);
    snippetsListElements.mergeSelected.textContent = snippetSelectionMode
      ? `合并所选${selectedSnippetIds.size ? ` (${selectedSnippetIds.size})` : ''}`
      : '合并所选';
  }

  if (snippetsListElements.mergeHint) {
    snippetsListElements.mergeHint.classList.toggle('hidden', !snippetSelectionMode);
  }
}

async function getActiveTabIfAvailable(): Promise<chrome.tabs.Tab | null> {
  try {
    return await getActiveTab();
  } catch (error) {
    logPopupError('获取当前标签页', error);
    return null;
  }
}

async function rebuildCurrentTabHighlights(silent = false): Promise<void> {
  const activeTab = await getActiveTabIfAvailable();
  if (!activeTab?.id) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(activeTab.id, { type: 'rebuildSnippetHighlights' });
    if (!silent) {
      showToast('已重新恢复页面高光', 'success');
    }
  } catch (error) {
    logPopupError('恢复页面高光', error);
  }
}

async function focusSnippetItemInActiveTab(itemId: string): Promise<void> {
  const activeTab = await getActiveTabIfAvailable();
  if (!activeTab?.id) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(activeTab.id, { type: 'focusSnippetItem', itemId });
  } catch (error) {
    logPopupError('定位片段高光', error);
  }
}

async function openSnippetDetailById(id: string): Promise<void> {
  try {
    const response = await safeSendRuntimeMessage({
      type: 'getSnippetGroupById',
      id,
    });
    const detail = extractSnippetDetailResponse(response as ChromeMessageResponse<any>);
    if (!detail) {
      return;
    }

    hideSnippetDetail();
    renderSnippetDetail(detail);
    document.querySelectorAll('.tab-content').forEach((tab) => {
      if (tab.id !== 'snippet-detail') {
        tab.classList.add('hidden');
        tab.classList.remove('active');
      }
    });
  } catch (error) {
    logPopupError('加载片段详情', error);
  }
}

async function loadConversations(): Promise<void> {
  if (popupContextInvalidated) {
    return;
  }

  showAttentionLoading();

  try {
    const response = await safeSendRuntimeMessage<unknown, Conversation[]>({
      type: 'getAllConversations',
    });
    const conversations = extractConversationsFromResponse(response).sort((a, b) => {
      const aTime = new Date(a.updatedAt || a.createdAt).getTime();
      const bTime = new Date(b.updatedAt || b.createdAt).getTime();
      return bTime - aTime;
    });
    cachedConversations = conversations;
    setAllConversations(conversations);
    setAllConversationsForFilter(conversations);
    applyFilter();
    renderAttentionList();
    enqueueRefresh('refreshStorageStats');
    if (ENABLE_RUNTIME_DIAGNOSTICS) {
      enqueueRefresh('refreshRuntimeDiagnostics');
    }
  } catch (error) {
    logPopupError('加载对话', error);
  } finally {
    hideAttentionLoading();
  }
}

async function loadSnippets(): Promise<void> {
  if (popupContextInvalidated) {
    return;
  }

  showAttentionLoading();

  try {
    const response = await safeSendRuntimeMessage<unknown, { snippets?: Snippet[] }>({
      type: 'getAllSnippets',
    });
    const snippets = extractSnippetsFromResponse(response).sort((a, b) => {
      const aTime = new Date(a.updatedAt || a.createdAt).getTime();
      const bTime = new Date(b.updatedAt || b.createdAt).getTime();
      return bTime - aTime;
    });
    cachedSnippets = snippets;
    Array.from(selectedSnippetIds).forEach((id) => {
      if (!snippets.some((snippet) => snippet.id === id)) {
        selectedSnippetIds.delete(id);
      }
    });
    snippetSelectionOrder = snippetSelectionOrder.filter((id) => selectedSnippetIds.has(id));
    renderCurrentSnippetList();

    const activeTab = await getActiveTab();
    const url = activeTab?.url || '';
    const captureMode = getPageCaptureMode(url);
    if (snippetsListElements.saveCurrentPage) {
      snippetsListElements.saveCurrentPage.disabled = captureMode === 'unsupported';
      snippetsListElements.saveCurrentPage.classList.toggle('opacity-50', captureMode === 'unsupported');
      snippetsListElements.saveCurrentPage.classList.toggle('cursor-not-allowed', captureMode === 'unsupported');
    }
    if (url) {
      const statusResponse = await safeSendRuntimeMessage({
        type: 'getSnippetStatusForTab',
        url,
      });
      const status = extractSnippetStatus(statusResponse as ChromeMessageResponse<any>);
      updateCurrentPageSnippetStatus(Boolean(status?.hasSnippet));
    } else {
      updateCurrentPageSnippetStatus(false);
    }
  } catch (error) {
    logPopupError('加载片段', error);
    updateCurrentPageSnippetStatus(false);
  } finally {
    hideAttentionLoading();
  }
}

async function loadBrowsingHistory(): Promise<void> {
  if (popupContextInvalidated) return;

  try {
    const response = await safeSendRuntimeMessage<unknown, { history?: BrowsingHistoryItem[] }>({
      type: 'getBrowsingHistory',
      days: 7,
    });
    const items = (response as any)?.history || (response as any)?.data?.history || [];
    cachedHistory = Array.isArray(items) ? items : [];
    renderAttentionList();
  } catch (error) {
    logPopupError('加载浏览历史', error);
  }
}

async function handleSaveCurrentPageSnippet(): Promise<void> {
  const activeTab = await getActiveTab();
  if (!activeTab?.id || getPageCaptureMode(activeTab.url || '') === 'unsupported') {
    return;
  }

  try {
    await chrome.tabs.sendMessage(activeTab.id, { type: 'capturePageFromContextMenu' });
    showToast(safeGetMessage('saveSuccess', 'Save successful'), 'success');
    window.setTimeout(() => {
      enqueueRefresh('refreshSnippets');
    }, 300);
  } catch (error) {
    logPopupError('保存当前页面片段', error);
  }
}

async function deleteSnippetById(id: string): Promise<void> {
  try {
    const currentDetail = getCurrentSnippetDetail();
    await safeSendRuntimeMessage({
      type: 'deleteSnippet',
      id,
    });
    if (currentDetail?.group.url) {
      await rebuildCurrentTabHighlights(true);
    }
    hideSnippetDetail();
    switchTab('attention');
    enqueueRefresh('refreshSnippets');
  } catch (error) {
    logPopupError('删除片段', error);
  }
}

async function mergeSelectedSnippets(): Promise<void> {
  if (!canMergeSelectedSnippets()) {
    return;
  }

  const selected = getSelectedMergeCandidateSnippets();
  const [target, ...sources] = selected;
  if (!target || sources.length === 0) {
    return;
  }

  try {
    const response = await safeSendRuntimeMessage({
      type: 'mergeSnippets',
      targetId: target.id,
      sourceIds: sources.map((snippet) => snippet.id),
    });
    const detail = extractSnippetDetailResponse(response as ChromeMessageResponse<any>);

    clearSnippetSelection();
    toggleSnippetSelectionMode(false);
    enqueueRefresh('refreshSnippets');
    await rebuildCurrentTabHighlights(true);
    showToast('已合并选中的 snippets', 'success');

    if (detail) {
      renderSnippetDetail(detail);
      document.querySelectorAll('.tab-content').forEach((tab) => {
        if (tab.id !== 'snippet-detail') {
          tab.classList.add('hidden');
          tab.classList.remove('active');
        }
      });
    }
  } catch (error) {
    logPopupError('合并片段', error);
    showToast('合并失败，请确认选择的是同一页面的高亮记录', 'error');
  }
}

async function deleteSnippetItemById(id: string): Promise<void> {
  try {
    const currentDetail = getCurrentSnippetDetail();
    if (!currentDetail) {
      return;
    }

    await safeSendRuntimeMessage({
      type: 'deleteSnippetItem',
      id,
    });

    await rebuildCurrentTabHighlights(true);
    enqueueRefresh('refreshSnippets');

    const detailResponse = await safeSendRuntimeMessage({
      type: 'getSnippetGroupById',
      id: currentDetail.group.id,
    });
    const detail = extractSnippetDetailResponse(detailResponse as ChromeMessageResponse<any>);
    if (!detail) {
      hideSnippetDetail();
      switchTab('attention');
      return;
    }

    renderSnippetDetail(detail);
  } catch (error) {
    logPopupError('删除划词条目', error);
  }
}

function toggleFilteredExportDropdown(): void {
  const dropdown = document.getElementById('export-filtered-dropdown');
  if (!dropdown) {
    return;
  }
  dropdown.classList.toggle('hidden');
}

function toggleMultiSelectMode(): void {
  isMultiSelectMode = !isMultiSelectMode;
  if (!isMultiSelectMode) {
    selectedConversationIds.clear();
  }
  renderCurrentConversationList();
}

async function handleExportFilteredConversations(detail?: any): Promise<void> {
  try {
    const exportType = detail?.exportType === 'merged' ? 'merged' : 'separate';
    const scope = detail?.scope === 'all' ? 'all' : 'filtered';

    const sourceConversations =
      scope === 'all' ? cachedConversations : getFilteredConversations();
    const exportTarget =
      isMultiSelectMode && selectedConversationIds.size > 0
        ? sourceConversations.filter((conversation) =>
            selectedConversationIds.has(conversation.conversationId)
          )
        : sourceConversations;

    if (!exportTarget.length) {
      showToast(chrome.i18n.getMessage('noMemoriesSaved') || '没有可导出的记录', 'warning');
      return;
    }

    showToast(chrome.i18n.getMessage('exporting') || '正在导出...', 'info');
    await exportManager.exportConversations({
      conversationIds: exportTarget.map((conversation) => conversation.conversationId),
      format: exportType,
      metadata: {
        exportMode: scope,
        totalCount: exportTarget.length,
        exportedAt: new Date().toISOString(),
      },
      buttonElement: settingsElements.exportBtn || undefined,
    });
  } catch (error) {
    logPopupError('导出筛选对话', error);
    showToast('导出失败，请重试', 'error');
  }
}

async function handleClearStorage(): Promise<void> {
  const confirmed = confirm(
    chrome.i18n.getMessage('clearConfirm') || '确定要清空所有聊天记录吗？'
  );
  if (!confirmed) {
    return;
  }

  try {
    const response = await safeSendRuntimeMessage({ type: 'clearStorage' });

    if (response?.status === 'ok') {
      cachedConversations = [];
      setAllConversations([]);
      setAllConversationsForFilter([]);
      renderCurrentConversationList();
      refreshStorageUsageDisplay();
      showToast(chrome.i18n.getMessage('clearSuccess') || '已清空', 'success');
    } else {
      Logger.error('[Popup] 清空存储失败:', response);
      showToast(chrome.i18n.getMessage('clearFailed') || '清空失败', 'error');
    }
  } catch (error) {
    logPopupError('清空存储', error);
    showToast(chrome.i18n.getMessage('clearFailed') || '清空失败', 'error');
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

function renderPlatformFilterOptions(): void {
  if (!searchElements.platformDropdownMenu) {
    return;
  }

  searchElements.platformDropdownMenu.innerHTML = FILTER_PLATFORMS.map(
    (platform) => `
      <button
        class="platform-filter-option w-full text-left px-3 py-2 text-xs hover:bg-gray-50 transition-colors flex items-center justify-between"
        data-platform="${platform.id}"
      >
        <span>${platform.label}</span>
        <i class="fas fa-check text-brand hidden"></i>
      </button>
    `
  ).join('');

  searchElements.platformDropdownMenu
    .querySelectorAll<HTMLElement>('.platform-filter-option')
    .forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        const platform = button.dataset.platform as Conversation['platform'] | undefined;
        if (!platform) {
          return;
        }
        togglePlatformSelection(platform);
        refreshPlatformOptionState();
        applyFilter();
      });
    });

  refreshPlatformOptionState();
}

function refreshPlatformOptionState(): void {
  const selectedPlatforms = getCurrentFilter().platforms;
  if (!searchElements.platformDropdownMenu) {
    return;
  }

  searchElements.platformDropdownMenu
    .querySelectorAll<HTMLElement>('.platform-filter-option')
    .forEach((button) => {
      const icon = button.querySelector('i');
      const platform = button.dataset.platform as Conversation['platform'] | undefined;
      const selected = !!platform && selectedPlatforms.has(platform);
      button.classList.toggle('bg-brand-light', selected);
      if (icon) {
        icon.classList.toggle('hidden', !selected);
      }
    });
}

async function updateConversationTitle(
  conversationId: string,
  title: string
): Promise<void> {
  try {
    const target = cachedConversations.find(
      (conversation) => conversation.conversationId === conversationId
    );
    if (!target) {
      return;
    }

    const response = await safeSendRuntimeMessage({
      type: 'updateConversation',
      conversation: {
        ...target,
        title,
      },
    });

    if (response?.status !== 'error') {
      await loadConversations();
    } else {
      showToast(chrome.i18n.getMessage('saveFailed') || '保存失败，请重试', 'error');
    }
  } catch (error) {
    logPopupError('更新对话标题', error);
    showToast(chrome.i18n.getMessage('saveFailed') || '保存失败，请重试', 'error');
  }
}

async function deleteConversationById(
  conversationId: string,
  title?: string
): Promise<void> {
  try {
    const confirmed = confirm(
      (chrome.i18n.getMessage('deleteConfirm') || '确定要删除这个对话吗？') +
        (title ? `\n\n${title}` : '')
    );
    if (!confirmed) {
      return;
    }

    const response = await safeSendRuntimeMessage({
      type: 'deleteConversation',
      conversationId,
    });

    if (response?.status !== 'error') {
      await loadConversations();
      showToast(chrome.i18n.getMessage('deleteSuccess') || '删除成功', 'success');
    } else {
      showToast(chrome.i18n.getMessage('deleteFailed') || '删除失败，请重试', 'error');
    }
  } catch (error) {
    logPopupError('删除对话', error);
    showToast(chrome.i18n.getMessage('deleteFailed') || '删除失败，请重试', 'error');
  }
}

async function copyConversationToClipboard(conversation: Conversation): Promise<void> {
  const text = formatConversationForClipboard(conversation);
  try {
    await navigator.clipboard.writeText(text);
    showToast(chrome.i18n.getMessage('copySuccess') || '已复制', 'success');
  } catch (error) {
    logPopupError('复制', error);
    showToast(chrome.i18n.getMessage('copyFailed') || '复制失败', 'error');
  }
}

function formatConversationForClipboard(conversation: Conversation): string {
  const lines = [
    `# ${conversation.title || 'No Title'}`,
    `${conversation.link || ''}`,
    '',
  ];

  conversation.messages.forEach((message) => {
    const role = message.sender === 'user' ? 'User' : 'Assistant';
    lines.push(`${role}: ${message.content}`);
    if (message.thinking) {
      lines.push(`Thinking: ${message.thinking}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * 导出按钮下拉菜单创建（可选）
 */
function createExportDropdown(): void {
  Logger.debug('[Popup] 创建导出按钮下拉菜单');
  // 原始实现可以稍后添加
}

/**
 * 更新存储使用显示
 */
function refreshStorageStats(): void {
  refreshStorageUsageDisplay();
}

/**
 * 显示Toast 通知
 */
function showToast(message: string, type = 'info', duration = 3000): void {
  // 创建 toast 元素
  const toastContainer = document.getElementById('toast-container');
  if (!toastContainer) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  // 根据类型设置图标
  let icon = '';
  switch (type) {
    case 'success':
      icon = '<i class="fas fa-check"></i>';
      break;
    case 'error':
      icon = '<i class="fas fa-times"></i>';
      break;
    case 'warning':
      icon = '<i class="fas fa-exclamation-triangle"></i>';
      break;
    default:
      icon = '<i class="fas fa-info-circle"></i>';
      break;
  }

  toast.innerHTML = `${icon}<span>${message}</span>`;
  toastContainer.appendChild(toast);

  // 触发显示动画
  setTimeout(() => {
    toast.classList.add('show');
  }, 10);

  // 自动移除
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }, duration);
}

/**
 * 显示删除确认模态框
 */
function showDeleteModal(conversationId: string, title?: string): void {
  Logger.info(`[Popup] 删除对话确认: ${conversationId}`);
  void deleteConversationById(conversationId, title);
}

/**
 * 隐藏删除确认模态框
 */
function hideDeleteModal(): void {
  Logger.debug('[Popup] 隐藏删除确认');
  // 初始化隐藏模态框
}

/**
 * 显示修改标题模态框
 */
function showEditTitleModal(): void {
  Logger.info('[Popup] 显示编辑标题');
  // 初始化编辑模态框
}

/**
 * 隐藏修改标题模态框
 */
function hideEditTitleModal(): void {
  Logger.info('[Popup] 隐藏编辑标题');
}

/**
 * 刷新详情页（如果当前在详情页）
 */
function refreshDetailPageIfActive(): void {
  syncDetailPageState();
}

// ============================================================================
// 页面加载时初始化
// ============================================================================

// 等待 DOM 加载完成后初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPopup);
} else {
  // DOM 已经加载完成，直接初始化
  initPopup();
}

// 声明：此模块作为弹窗页面主入口
// - 协调各子模块（设置、记忆列表、对话详情、搜索筛选）
// - 处理后台消息和自定义事件
// - 提供导出按钮下拉菜单管理（可选）

export function jumpToRecommendFromSummary(summaryTaskId: string): void {
  pendingRecommendParams = { triggerSource: 'from_summary', summaryTaskId };
  summarySub = 'discover';
  switchTab('summary');
}
