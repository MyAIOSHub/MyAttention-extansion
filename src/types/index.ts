/**
 * 全局类型定义和常量
 */

import type { Message, MessageChanges, MessageSender } from './message';
import type { Conversation, PlatformName, ConversationStats } from './conversation';
import type { PlatformConfig, UrlMatchResult } from './platform';
import type { SnippetStatus } from './snippet';
import type {
  ImmersiveTranslationConfig,
  SimultaneousInterpretationConfig,
} from '@/translation/config';
import {
  createDefaultImmersiveTranslationConfig,
  createDefaultSimultaneousInterpretationConfig,
} from '@/translation/config';

// ============================================================================
// Chrome Extension 相关类型
// ============================================================================

/**
 * Chrome 消息类型
 */
export type KnownChromeMessageType =
  | 'connectDB'
  | 'findConversationByUrl'
  | 'createConversation'
  | 'updateConversation'
  | 'getConversationById'
  | 'getConversation'
  | 'getAllConversations'
  | 'getConversationsByIds'
  | 'deleteConversation'
  | 'getStorageUsage'
  | 'updateSettings'
  | 'getSettings'
  | 'exportConversationsByRange'
  | 'exportConversations'
  | 'clearStorage'
  | 'openSidePanel'
  | 'toggleSidebar'
  | 'manualSave'
  | 'incrementalUpdate'
  | 'smartIncrementalUpdate'
  | 'settingsUpdated'
  | 'content:healthPing'
  | 'content:healthPong'
  | 'translation:translateCurrentPage'
  | 'translation:translatePageText'
  | 'translation:explainText'
  | 'translation:translateTabFrames'
  | 'translation:clearPageTranslations'
  | 'translation:clearTabTranslations'
  | 'simulcast:start'
  | 'simulcast:stop'
  | 'simulcast:getStatus'
  | 'simulcast:update'
  | 'simulcast:popupUpdate'
  | 'simulcast:offscreenStart'
  | 'simulcast:offscreenStop'
  | 'reportContentRuntime'
  | 'getTabRuntimeStatus'
  | 'getLocalStoreStatus'
  | 'setLocalStorePath'
  | 'startLocalStoreMigration'
  | 'getLocalStoreMigrationState'
  | 'upsertSnippet'
  | 'saveMediaSnippet'
  | 'upsertSnippetSelection'
  | 'getAllSnippets'
  | 'getSnippetsByUrl'
  | 'getSnippetById'
  | 'getSnippetGroupById'
  | 'mergeSnippets'
  | 'deleteSnippet'
  | 'deleteSnippetItem'
  | 'clearSnippets'
  | 'captureSelectionFromContextMenu'
  | 'capturePageFromContextMenu'
  | 'captureMediaFromContextMenu'
  | 'getSnippetStatusForTab'
  | 'rebuildSnippetHighlights'
  | 'focusSnippetItem'
  // EverMemOS Export
  | 'exportConversationToEverMemOS'
  | 'exportConversationsToEverMemOS'
  | 'exportSnippetToEverMemOS'
  | 'exportSnippetsToEverMemOS'
  | 'getEverMemOSStatus'
  | 'getBrowserSyncStatus'
  | 'setEverMemOSBaseUrl'
  // History
  | 'getBrowsingHistory'
  | 'refreshBrowsingHistory'
  // Recommendation
  | 'createRecommendationSession'
  | 'getRecommendationSession'
  | 'markRecommendationInteracted'
  // Summary tasks
  | 'createSummaryTask'
  | 'getSummaryTasks'
  | 'getSummaryTaskResult';

export type ChromeMessageType = KnownChromeMessageType;

/**
 * Chrome 消息响应
 */
export interface ChromeMessageResponse<T = any> {
  status?: 'ok' | 'error';
  data?: T;
  error?: string;
  [key: string]: any;
}

/**
 * Chrome 消息请求 (带类型)
 */
export interface ChromeMessageRequest<T = any> extends Record<string, any> {
  type: ChromeMessageType;
  [key: string]: any;
}

// ============================================================================
// 数据库相关类型
// ============================================================================

/**
 * IndexedDB 数据库名称
 */
export const DB_NAME = 'SaySoDB';

/**
 * IndexedDB 版本
 */
export const DB_VERSION = 2;

/**
 * 存储名称
 */
export const STORES = {
  CONVERSATIONS: 'conversations',
  SNIPPET_GROUPS: 'snippet_groups',
  SNIPPET_ITEMS: 'snippet_items',
  SYNC_OUTBOX: 'sync_outbox',
  SETTINGS: 'settings',
} as const;

/**
 * 对话存储索引
 */
export const CONVERSATION_INDEXES = {
  LINK: 'link',
  PLATFORM: 'platform',
  UPDATED_AT: 'updatedAt',
  CREATED_AT: 'createdAt',
} as const;

/**
 * 存储使用情况
 */
export type StorageUsage = ConversationStats;

/**
 * 内容脚本运行态状态（用于 popup 诊断）
 */
export interface TabRuntimeStatus {
  tabId: number;
  url: string;
  platform: PlatformName | null;
  injectable: boolean;
  injected: boolean;
  lastSeenAt: string;
  lastExtractAt?: string;
  lastSaveAt?: string;
  lastError?: string;
  stale?: boolean;
}

// ============================================================================
// 设置相关类型
// ============================================================================

/**
 * 应用设置
 */
export interface AppSettings {
  /** 是否启用自动保存 */
  autoSave: boolean;
  /** 自定义主题色（#RRGGBB，空串表示使用默认主色） */
  brandColor?: string;
  /** Options / 外观体验设置 */
  experience?: {
    theme: 'system' | 'light' | 'dark';
    language: 'system' | 'zh-CN' | 'en';
    betaExperienceEnabled: boolean;
    commandPaletteEnabled: boolean;
    settingsSearchEnabled: boolean;
  };
  /** 悬浮标签设置 */
  floatTag?: {
    x?: number;
    y?: number;
    isEdgeDocked?: boolean;
    dockedSide?: 'left' | 'right';
  };
  /** 本地服务存储配置 */
  localStore?: {
    enabled: boolean;
    path?: string;
  };
  /** LLM API 配置 */
  llmApi?: {
    provider: 'bailian' | 'openai' | 'custom';
    apiKey: string;
    baseUrl?: string;
    model?: string;
  };
  /** 推荐功能配置 */
  recommend?: {
    enabled: boolean;
    exaApiKey: string;
    dataWindowDays: number;
    cacheTtlHours: number;
  };
  /** 网页内容采集设置 */
  webCapture?: {
    enabled: boolean;
    highlightEnabled: boolean;
    dwellEnabled: boolean;
    contextMenuEnabled: boolean;
    badgeEnabled: boolean;
    highlightOverlayEnabled: boolean;
    highlightReplayEnabled: boolean;
    semanticMergeEnabled: boolean;
    llmStructuringEnabled: boolean;
    mediaEnabled: boolean;
    mediaLocalCopyEnabled: boolean;
  };
  /** 沉浸式网页翻译设置 */
  immersiveTranslation?: ImmersiveTranslationConfig;
  /** 网页视频同声传译设置 */
  simultaneousInterpretation?: SimultaneousInterpretationConfig;
}

/**
 * 默认设置
 */
export const DEFAULT_SETTINGS: AppSettings = {
  autoSave: true,
  brandColor: '',
  experience: {
    theme: 'system',
    language: 'system',
    betaExperienceEnabled: false,
    commandPaletteEnabled: true,
    settingsSearchEnabled: true,
  },
  floatTag: {
    x: undefined,
    y: undefined,
    isEdgeDocked: false,
    dockedSide: 'right',
  },
  recommend: {
    enabled: false,
    exaApiKey: '',
    dataWindowDays: 14,
    cacheTtlHours: 24,
  },
  webCapture: {
    enabled: true,
    highlightEnabled: true,
    dwellEnabled: true,
    contextMenuEnabled: true,
    badgeEnabled: true,
    highlightOverlayEnabled: true,
    highlightReplayEnabled: true,
    semanticMergeEnabled: true,
    llmStructuringEnabled: true,
    mediaEnabled: true,
    mediaLocalCopyEnabled: true,
  },
  immersiveTranslation: createDefaultImmersiveTranslationConfig(),
  simultaneousInterpretation: createDefaultSimultaneousInterpretationConfig(),
};

export type LocalStoreMigrationState = 'pending' | 'running' | 'done' | 'failed';
export type LocalStoreFallbackMode = 'online' | 'offline' | 'syncing';

export type SyncOutboxOperation =
  | 'conversation_upsert'
  | 'conversation_delete'
  | 'conversation_clear'
  | 'snippet_upsert'
  | 'snippet_selection_upsert'
  | 'snippet_media_save'
  | 'snippet_delete'
  | 'snippet_item_delete'
  | 'snippet_clear'
  | 'snippet_merge';

export interface SyncOutboxEntry<T = unknown> {
  id?: number;
  operation: SyncOutboxOperation;
  entityId: string;
  payload: T;
  createdAt: string;
  updatedAt: string;
}

export interface LocalStoreStatus {
  enabled: boolean;
  connected: boolean;
  fallbackMode: LocalStoreFallbackMode;
  pendingOpsCount: number;
  version?: string;
  path?: string;
  migrationState: LocalStoreMigrationState;
  lastError?: string;
  lastMigratedAt?: string;
  lastSyncAt?: string;
}

export interface BrowserSyncStatus {
  running: boolean;
  last_poll_at?: string | null;
  last_success_at?: string | null;
  last_error?: string | null;
  conversation_cursor?: {
    updated_at?: string | null;
    cursor_id?: string | null;
  };
  snippet_cursor?: {
    updated_at?: string | null;
    cursor_id?: string | null;
  };
  pending_conversations: number;
  pending_snippets: number;
  in_progress_conversations: number;
  in_progress_snippets: number;
  imported_conversations: number;
  imported_snippets: number;
}

export interface SnippetTabStatus extends SnippetStatus {}

// ============================================================================
// 错误相关类型
// ============================================================================

/**
 * 错误代码
 */
export const ERROR_CODES = {
  // 数据库错误
  DB_OPEN_FAILED: 'DB_OPEN_FAILED',
  DB_TRANSACTION_FAILED: 'DB_TRANSACTION_FAILED',
  DB_NOT_FOUND: 'DB_NOT_FOUND',
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',

  // 验证错误
  INVALID_URL: 'INVALID_URL',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  INVALID_CONVERSATION: 'INVALID_CONVERSATION',

  // 提取错误
  EXTRACTION_FAILED: 'EXTRACTION_FAILED',
  MESSAGE_EXTRACTION_FAILED: 'MESSAGE_EXTRACTION_FAILED',

  // 存储错误
  STORAGE_QUOTA_EXCEEDED: 'STORAGE_QUOTA_EXCEEDED',
  STORAGE_WRITE_FAILED: 'STORAGE_WRITE_FAILED',

  // 网络错误
  NETWORK_ERROR: 'NETWORK_ERROR',
  API_ERROR: 'API_ERROR',

  // 平台错误
  PLATFORM_NOT_SUPPORTED: 'PLATFORM_NOT_SUPPORTED',
  ADAPTER_NOT_FOUND: 'ADAPTER_NOT_FOUND',
} as const;

/**
 * 自定义错误类
 */
export class SaySoError extends Error {
  public readonly code: string;
  public readonly context?: any;

  constructor(
    code: string,
    message: string,
    options?: {
      cause?: unknown;
      context?: any;
    }
  ) {
    super(message);
    if (options?.cause !== undefined) {
      (this as any).cause = options.cause;
    }
    this.name = 'SaySoError';
    this.code = code;
    this.context = options?.context;
  }
}

/**
 * 错误处理器类型
 */
export type ErrorHandler = (error: Error | SaySoError) => void;

// ============================================================================
// 事件相关类型
// ============================================================================

/**
 * 应用事件类型
 */
export type KnownAppEventType =
  | 'messages:extracted'
  | 'settings:updated'
  | 'sidebar:refresh'
  | 'message:saved'
  | 'message:failed';

export type AppEventType = KnownAppEventType;

/**
 * 应用事件
 */
export interface AppEvent<T = any> {
  type: AppEventType;
  payload: T;
  timestamp: number;
}

/**
 * 事件监听器类型
 */
export type EventListener<T = any> = (event: AppEvent<T>) => void;

// ============================================================================
// 工具类型
// ============================================================================

/**
 * Maybe 类型 (用于可能为 null/undefined 的值)
 */
export type Maybe<T> = T | null | undefined;

/**
 * Result 类型 (操作结果)
 */
export interface Result<T, E = Error> {
  ok: boolean;
  data?: T;
  error?: E;
}

/**
 * 成功结果快捷创建函数
 */
export const ok = <T>(data: T): Result<T> => ({
  ok: true,
  data,
});

/**
 * 失败结果快捷创建函数
 */
export const err = <E = Error>(error: E): Result<never, E> => ({
  ok: false,
  error,
});

/**
 * 异步 Result 类型
 */
export type AsyncResult<T, E = Error> = Promise<Result<T, E>>;

// ============================================================================
// 重新导出所有类型
// ============================================================================

export * from './message';
export * from './conversation';
export * from './platform';
export * from './snippet';
export * from './history';
export * from './recommendation';
