/**
 * 设置页面模块
 * 负责自动保存设置、存储使用显示、本地存储状态展示
 */

import type {
  AppSettings,
  LocalStoreFallbackMode,
  StorageUsage,
  LocalStoreStatus,
  LocalStoreMigrationState,
  BrowserSyncStatus,
} from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import { Logger } from '@/core/errors';
import { isExtensionContextInvalidatedError } from '@/core/chrome-message';
import {
  safeSendRuntimeMessage,
  safeGetMessage,
} from './chrome-safe';
import { formatBytes } from './utils/index';
import { syncBrandColor } from './brand-color-control';

const STORAGE_WARNING_PERCENT = 80;

export const elements = {
  autoSaveToggle: document.getElementById('auto-save-toggle') as HTMLInputElement | null,
  webCaptureToggle: document.getElementById('web-capture-toggle') as HTMLInputElement | null,
  highlightCaptureToggle: document.getElementById('highlight-capture-toggle') as HTMLInputElement | null,
  dwellCaptureToggle: document.getElementById('dwell-capture-toggle') as HTMLInputElement | null,
  mediaCaptureToggle: document.getElementById('media-capture-toggle') as HTMLInputElement | null,
  mediaLocalCopyToggle: document.getElementById('media-local-copy-toggle') as HTMLInputElement | null,
  contextMenuCaptureToggle: document.getElementById('context-menu-capture-toggle') as HTMLInputElement | null,
  snippetBadgeToggle: document.getElementById('snippet-badge-toggle') as HTMLInputElement | null,
  highlightOverlayToggle: document.getElementById('highlight-overlay-toggle') as HTMLInputElement | null,
  highlightReplayToggle: document.getElementById('highlight-replay-toggle') as HTMLInputElement | null,
  semanticMergeToggle: document.getElementById('semantic-merge-toggle') as HTMLInputElement | null,
  llmStructuringToggle: document.getElementById('llm-structuring-toggle') as HTMLInputElement | null,
  exportBtn: document.getElementById('export-btn') as HTMLButtonElement | null,
  exportDropdown: document.getElementById('export-dropdown') as HTMLDivElement | null,
  exportSeparate: document.getElementById('export-separate') as HTMLButtonElement | null,
  exportMerged: document.getElementById('export-merged') as HTMLButtonElement | null,
  clearBtn: document.getElementById('clear-btn') as HTMLButtonElement | null,
  storageUsage: document.getElementById('storage-usage'),
  storageBar: document.getElementById('storage-bar'),
  totalConversations: document.getElementById('total-conversations'),
  todayConversations: document.getElementById('today-conversations'),
  localStoreConnection: document.getElementById('local-store-connection'),
  localStorePath: document.getElementById('local-store-path'),
  localStoreMigrationState: document.getElementById('local-store-migration-state'),
  localStoreLastError: document.getElementById('local-store-last-error'),
  browserSyncConnection: document.getElementById('browser-sync-connection'),
  browserSyncDetails: document.getElementById('browser-sync-details'),
  browserSyncLastError: document.getElementById('browser-sync-last-error'),
  localStoreChangePath: document.getElementById('local-store-change-path') as HTMLButtonElement | null,
  localStoreRetryMigration: document.getElementById('local-store-retry-migration') as HTMLButtonElement | null,
  recommendEnabledToggle: document.getElementById('recommend-enabled-toggle') as HTMLInputElement | null,
  recommendExaKey: document.getElementById('recommend-exa-key') as HTMLInputElement | null,
  recommendWindowDays: document.getElementById('recommend-window-days') as HTMLInputElement | null,
  recommendCacheHours: document.getElementById('recommend-cache-hours') as HTMLInputElement | null,
  recommendSaveBtn: document.getElementById('recommend-save-btn') as HTMLButtonElement | null,
  recommendSaveStatus: document.getElementById('recommend-save-status') as HTMLElement | null,
};

let localStoreSnapshot: LocalStoreStatus | null = null;
let interactionsInitialized = false;

interface MemoryHubStatus {
  connected: boolean;
  baseUrl?: string;
  lastError?: string;
}

function parseBrowserSyncStatus(response: any): BrowserSyncStatus | null {
  if (!response || typeof response !== 'object') {
    return null;
  }

  const payload = response.browserSync || response.data?.browserSync || response.data || response;
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  return {
    running: Boolean(payload.running),
    last_poll_at: typeof payload.last_poll_at === 'string' ? payload.last_poll_at : undefined,
    last_success_at:
      typeof payload.last_success_at === 'string' ? payload.last_success_at : undefined,
    last_error: typeof payload.last_error === 'string' ? payload.last_error : undefined,
    conversation_cursor:
      payload.conversation_cursor && typeof payload.conversation_cursor === 'object'
        ? payload.conversation_cursor
        : undefined,
    snippet_cursor:
      payload.snippet_cursor && typeof payload.snippet_cursor === 'object'
        ? payload.snippet_cursor
        : undefined,
    pending_conversations:
      typeof payload.pending_conversations === 'number' ? payload.pending_conversations : 0,
    pending_snippets:
      typeof payload.pending_snippets === 'number' ? payload.pending_snippets : 0,
    in_progress_conversations:
      typeof payload.in_progress_conversations === 'number'
        ? payload.in_progress_conversations
        : 0,
    in_progress_snippets:
      typeof payload.in_progress_snippets === 'number' ? payload.in_progress_snippets : 0,
    imported_conversations:
      typeof payload.imported_conversations === 'number' ? payload.imported_conversations : 0,
    imported_snippets:
      typeof payload.imported_snippets === 'number' ? payload.imported_snippets : 0,
  };
}

function logSettingsError(operation: string, error: unknown): void {
  if (isExtensionContextInvalidatedError(error)) {
    Logger.warn(`[Settings] ${operation}失败：扩展上下文已失效`);
    return;
  }
  Logger.error(`[Settings] ${operation}失败:`, error);
}

function parseLocalStoreStatus(response: any): LocalStoreStatus | null {
  if (!response) {
    return null;
  }

  const payload = response.localStore || response.data?.localStore;
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const migrationState = (payload.migrationState || 'pending') as LocalStoreMigrationState;

  return {
    enabled: payload.enabled !== false,
    connected: Boolean(payload.connected),
    fallbackMode:
      payload.fallbackMode === 'offline' || payload.fallbackMode === 'syncing'
        ? (payload.fallbackMode as LocalStoreFallbackMode)
        : 'online',
    pendingOpsCount:
      typeof payload.pendingOpsCount === 'number' && Number.isFinite(payload.pendingOpsCount)
        ? Math.max(0, Math.round(payload.pendingOpsCount))
        : 0,
    version: typeof payload.version === 'string' ? payload.version : undefined,
    path: typeof payload.path === 'string' ? payload.path : undefined,
    migrationState,
    lastError:
      typeof payload.lastError === 'string' && payload.lastError.trim().length > 0
        ? payload.lastError
        : undefined,
    lastMigratedAt:
      typeof payload.lastMigratedAt === 'string' ? payload.lastMigratedAt : undefined,
    lastSyncAt: typeof payload.lastSyncAt === 'string' ? payload.lastSyncAt : undefined,
  };
}

export function initializeSettingsInteractions(): void {
  if (interactionsInitialized) {
    return;
  }

  interactionsInitialized = true;

  elements.exportSeparate?.addEventListener('click', (event) => {
    event.preventDefault();
    closeExportDropdown();
    document.dispatchEvent(
      new CustomEvent('export-filtered-conversations', {
        detail: {
          exportType: 'separate',
          scope: 'all',
        },
      })
    );
  });

  elements.exportMerged?.addEventListener('click', (event) => {
    event.preventDefault();
    closeExportDropdown();
    document.dispatchEvent(
      new CustomEvent('export-filtered-conversations', {
        detail: {
          exportType: 'merged',
          scope: 'all',
        },
      })
    );
  });

  document.addEventListener('click', (event) => {
    const target = event.target as Node | null;
    if (!target) {
      return;
    }

    if (!elements.exportDropdown || !elements.exportBtn) {
      return;
    }

    const clickedInside =
      elements.exportDropdown.contains(target) ||
      elements.exportBtn.contains(target);

    if (!clickedInside) {
      closeExportDropdown();
    }
  });

  elements.localStoreChangePath?.addEventListener('click', () => {
    void handleChangeLocalStorePath();
  });

  elements.localStoreRetryMigration?.addEventListener('click', () => {
    void handleRetryMigration();
  });
}

export function loadSettings(): void {
  void (async () => {
    try {
      const response = await safeSendRuntimeMessage({ type: 'getSettings' });
      if (response?.settings) {
        updateUI(response.settings);
      } else {
        updateUI(DEFAULT_SETTINGS);
      }
    } catch (error) {
      logSettingsError('加载设置', error);
      updateUI(DEFAULT_SETTINGS);
    }

    await refreshLocalStoreStatus();
  })();
}

export function updateUI(settings: AppSettings): void {
  if (elements.autoSaveToggle) {
    elements.autoSaveToggle.checked = settings.autoSave !== false;
  }

  if (elements.webCaptureToggle) {
    elements.webCaptureToggle.checked = settings.webCapture?.enabled !== false;
  }
  if (elements.highlightCaptureToggle) {
    elements.highlightCaptureToggle.checked = settings.webCapture?.highlightEnabled !== false;
  }
  if (elements.dwellCaptureToggle) {
    elements.dwellCaptureToggle.checked = settings.webCapture?.dwellEnabled !== false;
  }
  if (elements.mediaCaptureToggle) {
    elements.mediaCaptureToggle.checked = settings.webCapture?.mediaEnabled !== false;
  }
  if (elements.mediaLocalCopyToggle) {
    elements.mediaLocalCopyToggle.checked = settings.webCapture?.mediaLocalCopyEnabled !== false;
  }
  if (elements.contextMenuCaptureToggle) {
    elements.contextMenuCaptureToggle.checked = settings.webCapture?.contextMenuEnabled !== false;
  }
  if (elements.snippetBadgeToggle) {
    elements.snippetBadgeToggle.checked = settings.webCapture?.badgeEnabled !== false;
  }
  if (elements.highlightOverlayToggle) {
    elements.highlightOverlayToggle.checked = settings.webCapture?.highlightOverlayEnabled !== false;
  }
  if (elements.highlightReplayToggle) {
    elements.highlightReplayToggle.checked = settings.webCapture?.highlightReplayEnabled !== false;
  }
  if (elements.semanticMergeToggle) {
    elements.semanticMergeToggle.checked = settings.webCapture?.semanticMergeEnabled !== false;
  }
  if (elements.llmStructuringToggle) {
    elements.llmStructuringToggle.checked = settings.webCapture?.llmStructuringEnabled !== false;
  }

  if (elements.recommendEnabledToggle) {
    elements.recommendEnabledToggle.checked = settings.recommend?.enabled ?? false;
  }
  if (elements.recommendExaKey) {
    elements.recommendExaKey.value = settings.recommend?.exaApiKey ?? '';
  }
  if (elements.recommendWindowDays) {
    elements.recommendWindowDays.value = String(settings.recommend?.dataWindowDays ?? 14);
  }
  if (elements.recommendCacheHours) {
    elements.recommendCacheHours.value = String(settings.recommend?.cacheTtlHours ?? 24);
  }

  syncBrandColor(settings.brandColor);

  updateStorageUsageDisplay();
}

export function updateStorageUsageDisplay(): void {
  void (async () => {
    try {
      const response = await safeSendRuntimeMessage({ type: 'getStorageUsage' });
      if (response?.usage) {
        updateUIFromUsage(response.usage);
      }
    } catch (error) {
      logSettingsError('获取存储使用', error);
    }
  })();
}

function updateUIFromUsage(usage: StorageUsage): void {
  const { totalConversations, todayNewConversations } = usage;

  if (elements.totalConversations) {
    elements.totalConversations.textContent = totalConversations.toString();
  }

  if (elements.todayConversations) {
    elements.todayConversations.textContent = todayNewConversations.toString();
  }

  if (elements.storageUsage && elements.storageBar) {
    const maxStorage = 1024 * 1024 * 1024;
    const usedBytes = totalConversations * 50 * 1024;
    const usagePercent = Math.min((usedBytes / maxStorage) * 100, 100);

    elements.storageUsage.textContent = `${formatBytes(usedBytes)} / ${formatBytes(maxStorage)}`;
    elements.storageBar.style.width = `${usagePercent}%`;
    elements.storageBar.className = getStorageBarColor(usagePercent);
  }
}

function getStorageBarColor(percent: number): string {
  if (percent > STORAGE_WARNING_PERCENT) {
    return 'bg-red-600 h-2 rounded-full transition-all';
  }
  if (percent > 60) {
    return 'bg-yellow-600 h-2 rounded-full transition-all';
  }
  return 'btn-brand h-2 rounded-full transition-all';
}

function closeExportDropdown(): void {
  if (!elements.exportDropdown) {
    return;
  }

  elements.exportDropdown.classList.add('hidden');
}

function toggleExportDropdown(): void {
  if (!elements.exportDropdown) {
    // 向后兼容：没有下拉时按旧逻辑直接导出
    document.dispatchEvent(new CustomEvent('export-all-conversations'));
    return;
  }

  elements.exportDropdown.classList.toggle('hidden');
}

export function handleAutoSaveToggleChange(): void {
  if (!elements.autoSaveToggle) {
    return;
  }

  const toggleElement = elements.autoSaveToggle;
  const autoSave = toggleElement.checked;

  void (async () => {
    try {
      const response = await safeSendRuntimeMessage({
        type: 'updateSettings',
        settings: {
          autoSave,
        },
      });

      if (response?.status === 'ok') {
        Logger.info('[Settings] 自动保存设置已更新:', autoSave);
      } else {
        Logger.error('[Settings] 自动保存设置更新失败:', response);
        toggleElement.checked = !autoSave;
      }
    } catch (error) {
      logSettingsError('自动保存设置更新', error);
      toggleElement.checked = !autoSave;
    }
  })();
}

async function updateWebCaptureSettings(partial: NonNullable<AppSettings['webCapture']>): Promise<void> {
  const response = await safeSendRuntimeMessage({
    type: 'updateSettings',
    settings: {
      webCapture: partial,
    },
  });

  if (response?.status === 'ok') {
    return;
  }

  throw new Error('Failed to update webCapture settings');
}

function getWebCaptureSettingsFromInputs(): NonNullable<AppSettings['webCapture']> {
  return {
    enabled: !!elements.webCaptureToggle?.checked,
    highlightEnabled: !!elements.highlightCaptureToggle?.checked,
    dwellEnabled: !!elements.dwellCaptureToggle?.checked,
    mediaEnabled: !!elements.mediaCaptureToggle?.checked,
    mediaLocalCopyEnabled: !!elements.mediaLocalCopyToggle?.checked,
    contextMenuEnabled: !!elements.contextMenuCaptureToggle?.checked,
    badgeEnabled: !!elements.snippetBadgeToggle?.checked,
    highlightOverlayEnabled: !!elements.highlightOverlayToggle?.checked,
    highlightReplayEnabled: !!elements.highlightReplayToggle?.checked,
    semanticMergeEnabled: !!elements.semanticMergeToggle?.checked,
    llmStructuringEnabled: !!elements.llmStructuringToggle?.checked,
  };
}

export function bindWebCaptureToggleEvents(): void {
  elements.webCaptureToggle?.addEventListener('change', () => {
    void updateWebCaptureSettings(getWebCaptureSettingsFromInputs()).catch((error) =>
      logSettingsError('更新网页记录开关', error)
    );
  });

  elements.highlightCaptureToggle?.addEventListener('change', () => {
    void updateWebCaptureSettings(getWebCaptureSettingsFromInputs()).catch((error) =>
      logSettingsError('更新划词记录开关', error)
    );
  });

  elements.dwellCaptureToggle?.addEventListener('change', () => {
    void updateWebCaptureSettings(getWebCaptureSettingsFromInputs()).catch((error) =>
      logSettingsError('更新停留记录开关', error)
    );
  });

  elements.mediaCaptureToggle?.addEventListener('change', () => {
    void updateWebCaptureSettings(getWebCaptureSettingsFromInputs()).catch((error) =>
      logSettingsError('更新媒体悬浮保存开关', error)
    );
  });

  elements.mediaLocalCopyToggle?.addEventListener('change', () => {
    void updateWebCaptureSettings(getWebCaptureSettingsFromInputs()).catch((error) =>
      logSettingsError('更新媒体本地副本开关', error)
    );
  });

  elements.contextMenuCaptureToggle?.addEventListener('change', () => {
    void updateWebCaptureSettings(getWebCaptureSettingsFromInputs()).catch((error) =>
      logSettingsError('更新右键菜单开关', error)
    );
  });

  elements.snippetBadgeToggle?.addEventListener('change', () => {
    void updateWebCaptureSettings(getWebCaptureSettingsFromInputs()).catch((error) =>
      logSettingsError('更新状态徽标开关', error)
    );
  });

  elements.highlightOverlayToggle?.addEventListener('change', () => {
    void updateWebCaptureSettings(getWebCaptureSettingsFromInputs()).catch((error) =>
      logSettingsError('更新网页高光开关', error)
    );
  });

  elements.highlightReplayToggle?.addEventListener('change', () => {
    void updateWebCaptureSettings(getWebCaptureSettingsFromInputs()).catch((error) =>
      logSettingsError('更新高光恢复开关', error)
    );
  });

  elements.semanticMergeToggle?.addEventListener('change', () => {
    void updateWebCaptureSettings(getWebCaptureSettingsFromInputs()).catch((error) =>
      logSettingsError('更新同上下文合并开关', error)
    );
  });

  elements.llmStructuringToggle?.addEventListener('change', () => {
    void updateWebCaptureSettings(getWebCaptureSettingsFromInputs()).catch((error) =>
      logSettingsError('更新 LLM 结构化开关', error)
    );
  });
}

export function handleExportButtonClick(event?: Event): void {
  event?.preventDefault();
  toggleExportDropdown();
}

export function handleClearButtonClick(): void {
  document.dispatchEvent(new CustomEvent('show-clear-confirm'));
}

export async function refreshLocalStoreStatus(): Promise<void> {
  try {
    const [response, hubResponse, browserSyncResponse] = await Promise.all([
      safeSendRuntimeMessage({ type: 'getLocalStoreStatus' }),
      safeSendRuntimeMessage({ type: 'getEverMemOSStatus' }),
      safeSendRuntimeMessage({ type: 'getBrowserSyncStatus' }),
    ]);
    const status = parseLocalStoreStatus(response);
    if (status) {
      localStoreSnapshot = status;
      renderLocalStoreStatus(
        status,
        parseMemoryHubStatus(hubResponse),
        parseBrowserSyncStatus(browserSyncResponse)
      );
    }
  } catch (error) {
    logSettingsError('刷新本地存储状态', error);
  }
}

function parseMemoryHubStatus(response: any): MemoryHubStatus | null {
  if (!response || typeof response !== 'object') {
    return null;
  }

  const payload = response.data || response;
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  return {
    connected: Boolean(payload.connected),
    baseUrl: typeof payload.baseUrl === 'string' ? payload.baseUrl : undefined,
    lastError:
      typeof payload.lastError === 'string' && payload.lastError.trim().length > 0
        ? payload.lastError
        : undefined,
  };
}

function renderLocalStoreStatus(
  status: LocalStoreStatus,
  hubStatus: MemoryHubStatus | null,
  browserSyncStatus: BrowserSyncStatus | null
): void {
  if (elements.localStoreConnection) {
    const pendingSuffix = status.pendingOpsCount > 0 ? `（${status.pendingOpsCount} 条待同步）` : '';
    const hubConnected = hubStatus?.connected ?? false;
    const stateText =
      status.fallbackMode === 'syncing'
        ? `同步中${pendingSuffix}`
        : status.connected && hubConnected
        ? '中枢在线'
        : status.connected || hubConnected
        ? `部分在线${pendingSuffix}`
        : `未连接${pendingSuffix}`;
    elements.localStoreConnection.textContent = stateText;
    elements.localStoreConnection.className =
      status.fallbackMode === 'syncing'
        ? 'text-xs px-2 py-0.5 rounded bg-yellow-100 text-yellow-700'
        : status.connected && hubConnected
        ? 'text-xs px-2 py-0.5 rounded bg-green-100 text-green-700'
        : status.connected || hubConnected
        ? 'text-xs px-2 py-0.5 rounded bg-orange-100 text-orange-700'
        : 'text-xs px-2 py-0.5 rounded bg-red-100 text-red-700';
  }

  if (elements.localStorePath) {
    const hubBaseUrl = hubStatus?.baseUrl || '-';
    elements.localStorePath.textContent = hubBaseUrl;
    elements.localStorePath.setAttribute('title', hubBaseUrl);
  }

  if (elements.localStoreMigrationState) {
    const stateText =
      status.migrationState === 'done'
        ? '已完成'
        : status.migrationState === 'running'
        ? '进行中'
        : status.migrationState === 'failed'
        ? '失败'
        : '等待中';
    elements.localStoreMigrationState.textContent = stateText;
  }

  if (elements.localStoreLastError) {
    const combinedError = [hubStatus?.lastError, status.lastError].filter(Boolean).join('|');
    if (combinedError) {
      const syncText = status.lastSyncAt ? ` | 上次同步：${status.lastSyncAt}` : '';
      elements.localStoreLastError.textContent = `最近错误：${combinedError}${syncText}`;
      elements.localStoreLastError.classList.remove('hidden');
    } else {
      const syncText = status.lastSyncAt ? `上次同步：${status.lastSyncAt}` : '';
      elements.localStoreLastError.textContent = syncText;
      elements.localStoreLastError.classList.toggle('hidden', !syncText);
    }
  }

  renderBrowserSyncStatus(browserSyncStatus, hubStatus);
}

function renderBrowserSyncStatus(
  browserSyncStatus: BrowserSyncStatus | null,
  hubStatus: MemoryHubStatus | null
): void {
  if (elements.browserSyncConnection) {
    let stateText = '未检测';
    let className = 'text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700';

    if (!(hubStatus?.connected ?? false)) {
      stateText = '中枢离线';
      className = 'text-xs px-2 py-0.5 rounded bg-red-100 text-red-700';
    } else if (browserSyncStatus) {
      const pendingCount =
        (browserSyncStatus.pending_conversations || 0) +
        (browserSyncStatus.pending_snippets || 0);
      const inProgressCount =
        (browserSyncStatus.in_progress_conversations || 0) +
        (browserSyncStatus.in_progress_snippets || 0);
      if (browserSyncStatus.last_error) {
        const remainingCount = pendingCount + inProgressCount;
        stateText = remainingCount > 0 ? `失败（剩余 ${remainingCount}）` : '失败';
        className = 'text-xs px-2 py-0.5 rounded bg-red-100 text-red-700';
      } else if (inProgressCount > 0 || pendingCount > 0) {
        const queueText =
          inProgressCount > 0 && pendingCount > 0
            ? `导入中 ${inProgressCount} · 排队 ${pendingCount}`
            : inProgressCount > 0
            ? `导入中 ${inProgressCount}`
            : `排队 ${pendingCount}`;
        stateText = queueText;
        className = 'text-xs px-2 py-0.5 rounded bg-yellow-100 text-yellow-700';
      } else if (browserSyncStatus.running) {
        stateText = '健康';
        className = 'text-xs px-2 py-0.5 rounded bg-green-100 text-green-700';
      } else {
        stateText = '未运行';
        className = 'text-xs px-2 py-0.5 rounded bg-orange-100 text-orange-700';
      }
    }

    elements.browserSyncConnection.textContent = stateText;
    elements.browserSyncConnection.className = className;
  }

  if (elements.browserSyncDetails) {
    if (!browserSyncStatus) {
      elements.browserSyncDetails.textContent = '等待状态返回';
    } else {
      elements.browserSyncDetails.textContent =
        `队列 ${browserSyncStatus.pending_conversations || 0} · ` +
        `导入中 ${browserSyncStatus.in_progress_conversations || 0} · ` +
        `已导入对话 ${browserSyncStatus.imported_conversations || 0} · ` +
        `已导入片段 ${browserSyncStatus.imported_snippets || 0}`;
    }
  }

  if (elements.browserSyncLastError) {
    const lastMessage = browserSyncStatus?.last_error
      ? `最近错误：${browserSyncStatus.last_error}`
      : browserSyncStatus?.last_success_at
      ? `上次成功：${browserSyncStatus.last_success_at}`
      : '';
    elements.browserSyncLastError.textContent = lastMessage;
    elements.browserSyncLastError.classList.toggle('hidden', !lastMessage);
  }
}

async function handleChangeLocalStorePath(): Promise<void> {
  const currentPath = localStoreSnapshot?.path || '';
  const title = safeGetMessage('changePathPrompt', '请输入本地存储路径');
  const nextPath = window.prompt(title, currentPath);

  if (!nextPath) {
    return;
  }

  const trimmedPath = nextPath.trim();
  if (!trimmedPath) {
    return;
  }

  try {
    await safeSendRuntimeMessage({
      type: 'setLocalStorePath',
      path: trimmedPath,
    });
    await refreshLocalStoreStatus();
  } catch (error) {
    logSettingsError('更新本地存储路径', error);
  }
}

async function handleRetryMigration(): Promise<void> {
  try {
    await safeSendRuntimeMessage({
      type: 'startLocalStoreMigration',
    });

    await refreshLocalStoreStatus();
  } catch (error) {
    logSettingsError('重试迁移', error);
  }
}

export default {
  initializeSettingsInteractions,
  loadSettings,
  updateUI,
  handleAutoSaveToggleChange,
  bindWebCaptureToggleEvents,
  handleExportButtonClick,
  handleClearButtonClick,
  updateStorageUsageDisplay,
  refreshLocalStoreStatus,
  elements,
};
