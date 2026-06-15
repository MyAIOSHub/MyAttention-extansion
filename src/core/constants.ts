/**
 * 常量定义
 * 全局常量配置
 */

// ============================================================================
// 时间相关常量
// ============================================================================

/**
 * 检查间隔 (毫秒)
 */
export const CHECK_INTERVAL = 2000;

/**
 * 防抖延迟 (毫秒)
 */
export const DEBOUNCE_DELAY = 1000;

/**
 * 边缘检测阈值 (像素)
 */
export const EDGE_THRESHOLD = 50;

// ============================================================================
// 存储相关常量
// ============================================================================

/**
 * 缓存最大容量
 */
export const CACHE_MAX_SIZE = 100;

/**
 * 缓存过期时间 (5分钟，毫秒)
 */
export const CACHE_EXPIRY = 5 * 60 * 1000;

/**
 * 缓存清理间隔 (5分钟，毫秒)
 */
export const CACHE_CLEANUP_INTERVAL = 5 * 60 * 1000;

/**
 * 批量操作延迟 (毫秒)
 */
export const BATCH_DELAY = 100;

/**
 * 悬浮标签最大宽度
 */
export const FLOAT_TAG_MAX_WIDTH = 200;

/**
 * 悬浮标签最大高度
 */
export const FLOAT_TAG_MAX_HEIGHT = 50;

/**
 * 侧边栏宽度
 */
export const SIDEBAR_WIDTH = 520;

// ============================================================================
// DOM 选择器常量
// ============================================================================

/**
 * 悬浮标签根容器类名
 */
export const FLOAT_TAG_CLASS = 'sayso-float';

/**
 * 悬浮标签图标类名
 */
export const FLOAT_TAG_ICON_CLASS = 'sayso-icon';

/**
 * 悬浮标签状态类名
 */
export const FLOAT_TAG_STATUS_CLASS = 'sayso-status';

/**
 * 悬浮标签保存按钮类名
 */
export const FLOAT_TAG_SAVE_CLASS = 'sayso-save';

/**
 * 侧边栏容器 ID
 */
export const SIDEBAR_ID = 'sayso-sidebar';

/**
 * 侧边栏打开类名
 */
export const SIDEBAR_OPEN_CLASS = 'open';

/**
 * 边缘引导类名
 */
export const EDGE_GUIDE_CLASS = 'edge-guide';

/**
 * 边缘引导激活类名
 */
export const EDGE_GUIDE_ACTIVE_CLASS = 'active';

// ============================================================================
// 消息相关常量
// ============================================================================

/**
 * 消息 ID 前缀
 */
export const MESSAGE_ID_PREFIX = 'msg_';

/**
 * 消息 ID 分隔符
 */
export const MESSAGE_ID_SEPARATOR = '_position_';

/**
 * 对话 ID 前缀
 */
export const CONVERSATION_ID_PREFIX = 'conv_';

/**
 * 新对话 ID 前缀
 */
export const NEW_CONVERSATION_PREFIX = 'new_conversation_';

// ============================================================================
// 右键菜单 ID
// ============================================================================

export const CONTEXT_MENU_IDS = {
  SELECTION: 'sayso-selection',
  PAGE: 'sayso-page',
  LINK: 'sayso-link',
  MEDIA: 'sayso-media',
  TRANSLATE_PAGE: 'sayso-translate-page',
} as const;

// ============================================================================
// 导出相关常量
// ============================================================================

/**
 * 导出文件名前缀
 */
export const EXPORT_FILENAME_PREFIX = 'sayso_';

/**
 * 默认对话标题
 */
export const DEFAULT_CONVERSATION_TITLE = '新对话';

/**
 * 文件名最大长度
 */
export const FILENAME_MAX_LENGTH = 30;

// ============================================================================
// 事件相关常量
// ============================================================================

/**
 * 手动保存事件名称
 */
export const MANUAL_SAVE_EVENT = 'sayso-manual-save';

/**
 * URL 事件名称
 */
export const URL_CHANGED_EVENT = 'sayso-url-changed';

/**
 * 设置更新事件名称
 */
export const SETTINGS_UPDATED_EVENT = 'sayso-settings-updated';

// ============================================================================
// LocalStorage 键名
// ============================================================================

/**
 * 悬浮标签位置键
 */
export const FLOAT_TAG_POSITION_KEY = 'sayso-float-position';

/**
 * 设置键
 */
export const SETTINGS_KEY = 'sayso-settings';

// ============================================================================
// 本地化相关
// ============================================================================

/**
 * 国际化消息键
 */
export const I18N_KEYS = {
  // 扩展名称
  extensionName: 'extensionName',
  extensionDescription: 'extensionDescription',

  // 通用
  autoSaving: 'autoSaving',
  manualSave: 'manualSave',
  saveSuccess: 'saveSuccess',
  clickToOpenManager: 'clickToOpenManager',

  // 错误
  invalidUrl: 'invalidUrl',
  extractionFailed: 'extractionFailed',
  storageError: 'storageError',

  // 初始化
  initSettingsComplete: 'initSettingsComplete',
} as const;

/**
 * 默认语言
 */
export const DEFAULT_LOCALE = 'en';

/**
 * 默认设置
 */
export const DEFAULT_SETTINGS: {
  autoSave: boolean;
  manualSave: boolean;
} = {
  autoSave: true,
  manualSave: false,
};
