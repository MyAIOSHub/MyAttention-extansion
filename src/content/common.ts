/**
 * 通用内容处理模块
 * 负责平台检测、设置管理和初始化
 */

import type { AppSettings, PlatformName } from '@/types';
import {
  chromeMessageAdapter,
  isExtensionContextInvalidatedError,
} from '@/core/chrome-message';
import { eventBus } from '@/core/event-bus';
import { Logger } from '@/core/errors';
import {
  isSupportedPlatformUrl,
  getPlatformFromUrl as resolvePlatformFromUrl,
  getSupportedPlatforms as listSupportedPlatforms,
} from '@/core/platforms';

// ============================================================================
// 常量定义
// ============================================================================

/**
 * LocalStorage 键名
 */
import { FLOAT_TAG_POSITION_KEY, SETTINGS_KEY } from '@/core/constants';

const STORAGE_KEYS = {
  FLOAT_TAG_POSITION: FLOAT_TAG_POSITION_KEY,
  SETTINGS: SETTINGS_KEY,
} as const;

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 悬浮标签位置数据（基于边缘距离）
 */
export interface FloatTagPosition {
  /** 水平锚点 (left | right) */
  anchor: 'left' | 'right';
  /** 水平边缘距离 */
  distance: number;
  /** 垂直锚点 (top | bottom) */
  verticalAnchor: 'top' | 'bottom';
  /** 垂直边缘距离 */
  verticalDistance: number;
  /** 是否贴边 */
  isEdgeDocked?: boolean;
  /** 贴边侧 */
  dockedSide?: 'left' | 'right';
}

/**
 * 旧版位置数据（兼容性）
 */
interface LegacyPositionData {
  x?: number;
  y?: number;
  percentX?: number;
  percentY?: number;
}

/**
 * 全局设置接口
 */
export interface GlobalSettings {
  autoSave: boolean;
  webCapture: NonNullable<AppSettings['webCapture']>;
}

const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  autoSave: true,
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
};

// ============================================================================
// 全局变量
// ============================================================================

let isInitialized = false;

// 声明全局设置对象（扩展 window）
declare global {
  interface Window {
    saySoSettings?: Record<string, any>;
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

// 初始化全局设置
window.saySoSettings = {
  ...DEFAULT_GLOBAL_SETTINGS,
  ...(window.saySoSettings || {}),
};

// ============================================================================
// 平台检测
// ============================================================================

/**
 * 检测当前 URL 是否为支持的 AI 平台
 */
export function isSupportedPlatform(url: string): boolean {
  return isSupportedPlatformUrl(url);
}

/**
 * 从 URL 获取平台名称
 */
export function getPlatformFromUrl(url: string): PlatformName | null {
  return resolvePlatformFromUrl(url);
}

/**
 * 获取所有支持的平台
 */
export function getSupportedPlatforms(): PlatformName[] {
  return listSupportedPlatforms();
}

// ============================================================================
// 设置管理
// ============================================================================

/**
 * 从 Chrome Storage 加载设置
 */
export async function loadSettingsFromStorage(): Promise<void> {
  try {
    const result = await chromeMessageAdapter.sendMessage({
      type: 'getSettings',
    });

    const settingsPayload = (result.settings || result.data) as Partial<AppSettings> | undefined;

    if (settingsPayload) {
      // 更新全局设置对象
      window.saySoSettings = {
        ...window.saySoSettings,
        ...settingsPayload,
      };

      Logger.info('[Common] 设置已加载:', window.saySoSettings);
    }
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      Logger.warn('[Common] 加载设置失败：扩展上下文已失效，使用默认设置');
      return;
    }
    Logger.error('[Common] 加载设置失败:', error);
  }
}

/**
 * 更新全局设置
 */
export function updateGlobalSettings(settings: Partial<AppSettings>): void {
  window.saySoSettings = {
    ...window.saySoSettings,
    ...settings,
  };

  Logger.info('[Common] 全局设置已更新:', settings);

  // 触发设置更新事件
  eventBus.publish('settings:updated', settings);
}

/**
 * 获取当前设置
 */
export function getCurrentSettings(): GlobalSettings {
  return {
    ...DEFAULT_GLOBAL_SETTINGS,
    ...(window.saySoSettings || {}),
    webCapture: {
      ...DEFAULT_GLOBAL_SETTINGS.webCapture,
      ...((window.saySoSettings || {}).webCapture || {}),
    },
  } as GlobalSettings;
}

// ============================================================================
// 位置存储
// ============================================================================

/**
 * 保存悬浮标签位置到本地存储（基于边缘距离）
 */
export function saveFloatTagPosition(
  x: number,
  y: number,
  isEdgeDocked = false,
  dockedSide: 'left' | 'right' | null = null
): void {
  try {
    // 计算与各边缘的距离
    const distanceFromLeft = x;
    const distanceFromTop = y;
    const distanceFromRight = window.innerWidth - x;
    const distanceFromBottom = window.innerHeight - y;

    // 判断标签更靠近哪个边缘，选择最小距离的边作为参考
    let anchor: 'left' | 'right';
    let distance: number;

    if (distanceFromLeft <= distanceFromRight) {
      anchor = 'left';
      distance = distanceFromLeft;
    } else {
      anchor = 'right';
      distance = distanceFromRight;
    }

    // 垂直方向也采用相同逻辑
    let verticalAnchor: 'top' | 'bottom';
    let verticalDistance: number;

    if (distanceFromTop <= distanceFromBottom) {
      verticalAnchor = 'top';
      verticalDistance = distanceFromTop;
    } else {
      verticalAnchor = 'bottom';
      verticalDistance = distanceFromBottom;
    }

    const positionData: FloatTagPosition = {
      anchor,
      distance: Math.max(0, distance),
      verticalAnchor,
      verticalDistance: Math.max(0, verticalDistance),
      isEdgeDocked,
      dockedSide: dockedSide ?? undefined,
    };

    localStorage.setItem(
      STORAGE_KEYS.FLOAT_TAG_POSITION,
      JSON.stringify(positionData)
    );

    Logger.debug('[Common] 悬浮标签位置已保存:', positionData);
  } catch (error) {
    Logger.error('[Common] 保存悬浮标签位置失败:', error);
  }
}

/**
 * 从本地存储恢复悬浮标签位置（基于边缘距离）
 */
export function restoreFloatTagPosition(): FloatTagPosition | null {
  try {
    const savedPosition = localStorage.getItem(STORAGE_KEYS.FLOAT_TAG_POSITION);
    if (savedPosition) {
      const position = JSON.parse(savedPosition) as FloatTagPosition &
        LegacyPositionData;

      // 兼容旧版本的绝对像素位置数据
      if (position.x !== undefined && position.y !== undefined) {
        // 旧版本数据，转换为边缘距离格式并保存
        const distanceFromLeft = position.x;
        const distanceFromRight = window.innerWidth - position.x;
        const distanceFromTop = position.y;
        const distanceFromBottom = window.innerHeight - position.y;

        const newPosition: FloatTagPosition = {
          anchor: distanceFromLeft <= distanceFromRight ? 'left' : 'right',
          distance: Math.min(distanceFromLeft, distanceFromRight),
          verticalAnchor: distanceFromTop <= distanceFromBottom ? 'top' : 'bottom',
          verticalDistance: Math.min(distanceFromTop, distanceFromBottom),
        };

        // 更新存储为新格式
        localStorage.setItem(
          STORAGE_KEYS.FLOAT_TAG_POSITION,
          JSON.stringify(newPosition)
        );

        return newPosition;
      }

      // 兼容百分比版本数据
      if (position.percentX !== undefined && position.percentY !== undefined) {
        // 百分比数据，转换为边缘距离格式
        const x = (position.percentX / 100) * window.innerWidth;
        const y = (position.percentY / 100) * window.innerHeight;

        const distanceFromLeft = x;
        const distanceFromRight = window.innerWidth - x;
        const distanceFromTop = y;
        const distanceFromBottom = window.innerHeight - y;

        const newPosition: FloatTagPosition = {
          anchor: distanceFromLeft <= distanceFromRight ? 'left' : 'right',
          distance: Math.min(distanceFromLeft, distanceFromRight),
          verticalAnchor: distanceFromTop <= distanceFromBottom ? 'top' : 'bottom',
          verticalDistance: Math.min(distanceFromTop, distanceFromBottom),
        };

        // 更新存储为新格式
        localStorage.setItem(
          STORAGE_KEYS.FLOAT_TAG_POSITION,
          JSON.stringify(newPosition)
        );

        return newPosition;
      }

      // 新版本边缘距离数据
      if (
        position.anchor !== undefined &&
        position.distance !== undefined
      ) {
        return position as FloatTagPosition;
      }
    }
  } catch (error) {
    Logger.error('[Common] 恢复悬浮标签位置失败:', error);
  }

  return null;
}

/**
 * 根据位置数据计算实际像素坐标
 */
export function calculatePixelPosition(
  position: FloatTagPosition
): { x: number; y: number } {
  // 水平位置计算
  let x: number;
  if (position.anchor === 'left') {
    x = position.distance;
  } else {
    // right
    x = window.innerWidth - position.distance;
  }

  // 垂直位置计算
  let y: number;
  if (position.verticalAnchor === 'top') {
    y = position.verticalDistance;
  } else {
    // bottom
    y = window.innerHeight - position.verticalDistance;
  }

  return { x, y };
}

/**
 * 限制坐标在视窗范围内
 */
export function constrainPosition(
  x: number,
  y: number,
  elementWidth: number,
  elementHeight: number
): { x: number; y: number } {
  const maxX = window.innerWidth - elementWidth;
  const maxY = window.innerHeight - elementHeight;

  return {
    x: Math.max(0, Math.min(x, maxX)),
    y: Math.max(0, Math.min(y, maxY)),
  };
}

// ============================================================================
// 初始化管理
// ============================================================================

/**
 * 检查是否已初始化
 */
export function isReady(): boolean {
  return isInitialized;
}

/**
 * 标记为已初始化
 */
export function markAsInitialized(): void {
  isInitialized = true;
  Logger.info('[Common] 已标记为已初始化');
}

/**
 * 延迟初始化，确保 DOM 和脚本完全加载
 */
export function delayInit(callback: () => void, delay = 100): void {
  setTimeout(callback, delay);
}

/**
 * 安全初始化函数
 * 根据DOM状态选择合适的初始化时机
 */
export function safeInit(callback: () => void): void {
  // 如果已经初始化，直接返回
  if (isInitialized) {
    Logger.debug('[Common] 已初始化，跳过重复初始化');
    return;
  }

  // 根据DOM状态选择初始化时机
  if (document.readyState === 'loading') {
    // DOM 还在加载中，等待 DOMContentLoaded 事件
    document.addEventListener('DOMContentLoaded', () => {
      Logger.info('[Common] DOMContentLoaded 触发，开始初始化');
      callback();
    });
  } else {
    // DOM 已经加载完成，直接初始化
    Logger.info('[Common] DOM 已就绪，开始初始化');
    callback();
  }
}

// ============================================================================
// 资源管理
// ============================================================================

/**
 * 加载 Font Awesome
 */
export function loadFontAwesome(): void {
  try {
    const fontAwesomeUrl = getSafeRuntimeUrl('lib/fontawesome/all.min.css');
    if (!fontAwesomeUrl) {
      return;
    }
    const fontAwesome = document.createElement('link');
    fontAwesome.rel = 'stylesheet';
    fontAwesome.href = fontAwesomeUrl;
    document.head.appendChild(fontAwesome);

    Logger.debug('[Common] Font Awesome 已加载');
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      Logger.warn('[Common] 跳过 Font Awesome 加载：扩展上下文已失效');
      return;
    }
    Logger.error('[Common] Font Awesome 加载失败:', error);
  }
}

/**
 * 创建 Logo HTML
 */
export function createLogoHTML(size = '20px'): string {
  try {
    const iconUrl = getSafeRuntimeUrl('icons/logo_128.png');
    if (!iconUrl) {
      return `<span class="sayso-badge"></span>`;
    }
    return `<img src="${iconUrl}" alt="SaySo Logo" style="width: ${size}; height: ${size}; display: block; object-fit: contain; object-position: center;"><span class="sayso-badge"></span>`;
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      return `<span class="sayso-badge"></span>`;
    }
    Logger.error('[Common] 生成 Logo HTML 失败:', error);
    return `<span class="sayso-badge"></span>`;
  }
}

/**
 * 安全获取 i18n 文案，避免扩展上下文失效时抛出未捕获异常
 */
export function getSafeI18nMessage(
  key: string,
  fallback: string,
  substitutions?: string | string[]
): string {
  try {
    return chrome.i18n.getMessage(key, substitutions as string | string[] | undefined) || fallback;
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      Logger.warn(`[Common] 获取 i18n 失败（上下文失效）: ${key}`);
      return fallback;
    }
    Logger.error(`[Common] 获取 i18n 失败: ${key}`, error);
    return fallback;
  }
}

/**
 * 安全获取扩展资源 URL，避免扩展上下文失效时抛出未捕获异常
 */
export function getSafeRuntimeUrl(path: string, fallback = ''): string {
  try {
    return chrome.runtime.getURL(path);
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      Logger.warn(`[Common] 获取扩展资源失败（上下文失效）: ${path}`);
      return fallback;
    }
    Logger.error(`[Common] 获取扩展资源失败: ${path}`, error);
    return fallback;
  }
}

// ============================================================================
// 导出
// ============================================================================

export default {
  isSupportedPlatform,
  getPlatformFromUrl,
  getSupportedPlatforms,
  updateGlobalSettings,
  getCurrentSettings,
  loadSettingsFromStorage,
  saveFloatTagPosition,
  restoreFloatTagPosition,
  calculatePixelPosition,
  constrainPosition,
  isReady,
  markAsInitialized,
  delayInit,
  safeInit,
  loadFontAwesome,
  createLogoHTML,
  getSafeI18nMessage,
  getSafeRuntimeUrl,
};
