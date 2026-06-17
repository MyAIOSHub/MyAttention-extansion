/**
 * 侧边栏模块
 * 负责创建和管理注入式侧边栏
 */

import { Logger } from '@/core/errors';
import {
  getSafeI18nMessage,
  getSafeRuntimeUrl,
} from '@/content/common';
import { isExtensionContextInvalidatedError } from '@/core/chrome-message';
import { SIDEBAR_ID } from '@/core/constants';

/**
 * CSS 类名
 */
const CLASS_NAMES = {
  SIDEBAR: 'sidebar-header',
  HEADER_LEFT: 'sidebar-header-left',
  LOGO: 'sidebar-logo',
  TITLE: 'sidebar-title',
  MINI_BTN: 'sidebar-mini-btn',
  CLOSE_BTN: 'sidebar-close-btn',
  CONTENT: 'sidebar-content',
} as const;

/**
 * 侧边栏宽度
 */
const SIDEBAR_WIDTH = 520;

/**
 * 标题栏高度
 */
const HEADER_HEIGHT = 44;

// ============================================================================
// 全局变量
// ============================================================================

/**
 * 侧边栏元素
 */
let sidebarElement: HTMLDivElement | null = null;

/**
 * 关闭按钮元素
 */
let closeBtnElement: HTMLButtonElement | null = null;

/**
 * 小窗口（迷你浮窗）切换按钮
 */
let miniBtnElement: HTMLButtonElement | null = null;

/**
 * 是否处于小窗口模式（会话内保持）
 */
let miniMode = false;

/**
 * 样式元素
 */
let styleElement: HTMLStyleElement | null = null;

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 创建 SVG 关闭图标
 */
function createCloseIcon(): string {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>`;
}

/**
 * 小窗口图标（画中画样式）
 */
function createMiniIcon(): string {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2"></rect>
        <rect x="12.5" y="11.5" width="6.5" height="5" rx="1" fill="currentColor" stroke="none"></rect>
      </svg>`;
}

/**
 * 获取扩展名称
 */
function getExtensionName(): string {
  return getSafeI18nMessage('extensionName', 'My Attention');
}

/**
 * 获取 Logo URL
 */
function getLogoUrl(): string {
  return getSafeRuntimeUrl('icons/logo_48.png');
}

/**
 * 获取 popup URL
 */
function getPopupUrl(): string {
  return getSafeRuntimeUrl('html/popup.html');
}

// ============================================================================
// DOM 创建
// ============================================================================

/**
 * 创建侧边栏容器
 */
function createSidebarElement(): HTMLDivElement {
  const sidebar = document.createElement('div');
  sidebar.id = SIDEBAR_ID;

  Logger.debug('[Sidebar] 侧边栏容器已创建');

  return sidebar;
}

/**
 * 创建标题栏
 */
function createHeader(): HTMLDivElement {
  const header = document.createElement('div');
  header.className = CLASS_NAMES.SIDEBAR;

  const headerLeft = document.createElement('div');
  headerLeft.className = CLASS_NAMES.HEADER_LEFT;

  const logo = document.createElement('img');
  logo.src = getLogoUrl();
  logo.alt = 'Logo';
  logo.className = CLASS_NAMES.LOGO;

  const title = document.createElement('span');
  title.className = CLASS_NAMES.TITLE;
  title.textContent = getExtensionName();

  headerLeft.appendChild(logo);
  headerLeft.appendChild(title);

  const miniBtn = document.createElement('button');
  miniBtn.className = CLASS_NAMES.MINI_BTN;
  miniBtn.title = miniMode ? '还原侧栏' : '小窗口';
  miniBtn.innerHTML = createMiniIcon();

  const closeBtn = document.createElement('button');
  closeBtn.className = CLASS_NAMES.CLOSE_BTN;
  closeBtn.title = '关闭';
  closeBtn.innerHTML = createCloseIcon();

  header.appendChild(headerLeft);
  header.appendChild(miniBtn);
  header.appendChild(closeBtn);

  // 保存按钮引用
  miniBtnElement = miniBtn;
  closeBtnElement = closeBtn;

  Logger.debug('[Sidebar] 标题栏已创建');

  return header;
}

/**
 * 创建内容区域
 */
function createContent(): HTMLDivElement {
  const content = document.createElement('div');
  content.className = CLASS_NAMES.CONTENT;

  const iframe = document.createElement('iframe');
  iframe.src = getPopupUrl();
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  iframe.style.borderRadius = '0';

  content.appendChild(iframe);

  Logger.debug('[Sidebar] 内容区域已创建');

  return content;
}

// ============================================================================
// 样式注入
// ============================================================================

/**
 * 创建并注入样式
 */
function injectStyles(): void {
  const style = document.createElement('style');
  styleElement = style;

  style.textContent = `
    #${SIDEBAR_ID} {
      position: fixed;
      top: 0;
      right: 0;
      width: min(${SIDEBAR_WIDTH}px, 100vw);
      height: 100vh;
      z-index: 99999;
      display: none;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-sizing: border-box;
    }

    #${SIDEBAR_ID}.open {
      display: flex;
      flex-direction: column;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.05),
                  -4px 0 24px rgba(0, 0, 0, 0.08),
                  -2px 0 8px rgba(0, 0, 0, 0.04);
      border-left: 1px solid rgba(0, 0, 0, 0.08);
    }

    /* 小窗口（迷你浮窗）模式：右上角圆角卡片，非全高 */
    #${SIDEBAR_ID}.mini {
      top: 12px;
      right: 12px;
      width: min(400px, 92vw);
      height: min(640px, calc(100vh - 24px));
      border-radius: 14px;
      overflow: hidden;
      border-left: none;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.20),
                  0 4px 12px rgba(0, 0, 0, 0.10);
    }

    .${CLASS_NAMES.SIDEBAR} {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: linear-gradient(to bottom, #ffffff 0%, #fafafa 100%);
      border-bottom: 1px solid rgba(0, 0, 0, 0.08);
      flex-shrink: 0;
      height: ${HEADER_HEIGHT}px;
      box-sizing: border-box;
    }

    .${CLASS_NAMES.HEADER_LEFT} {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      min-width: 0;
    }

    .${CLASS_NAMES.LOGO} {
      width: 20px;
      height: 20px;
      display: block;
      flex-shrink: 0;
      object-fit: contain;
    }

    .${CLASS_NAMES.TITLE} {
      font-size: 14px;
      font-weight: 600;
      color: #1f2937;
      letter-spacing: 0.2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
    }

    .${CLASS_NAMES.MINI_BTN},
    .${CLASS_NAMES.CLOSE_BTN} {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 6px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #6b7280;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      margin-left: 4px;
      flex-shrink: 0;
    }

    .${CLASS_NAMES.MINI_BTN}:hover,
    .${CLASS_NAMES.CLOSE_BTN}:hover {
      background: rgba(0, 0, 0, 0.05);
      color: #374151;
      transform: scale(1.05);
    }

    .${CLASS_NAMES.MINI_BTN}:active,
    .${CLASS_NAMES.CLOSE_BTN}:active {
      background: rgba(0, 0, 0, 0.1);
      transform: scale(0.95);
    }

    /* 小窗口模式下，按钮高亮表示已激活 */
    #${SIDEBAR_ID}.mini .${CLASS_NAMES.MINI_BTN} {
      background: var(--primary-light, rgba(94, 106, 210, 0.12));
      color: var(--primary-color, #5e6ad2);
    }

    .${CLASS_NAMES.CONTENT} {
      flex: 1;
      width: 100%;
      background: #f9fafb;
      overflow: hidden;
      box-sizing: border-box;
    }

    .${CLASS_NAMES.CONTENT} iframe {
      width: 100%;
      height: 100%;
      border: none;
      border-radius: 0;
    }
  `;

  document.head.appendChild(style);

  Logger.debug('[Sidebar] 样式已注入');
}

// ============================================================================
// 事件处理
// ============================================================================

/**
 * 处理关闭按钮点击
 */
function handleCloseClick(): void {
  toggleSidebar(false);
}

/**
 * 处理小窗口按钮点击：在「全高侧栏」与「右上角浮窗」之间切换
 */
function handleMiniClick(): void {
  miniMode = !miniMode;
  const sidebar = document.getElementById(SIDEBAR_ID);
  sidebar?.classList.toggle('mini', miniMode);
  if (miniBtnElement) {
    miniBtnElement.title = miniMode ? '还原侧栏' : '小窗口';
  }
  Logger.debug(`[Sidebar] 小窗口模式：${miniMode ? '开' : '关'}`);
}

/**
 * 添加标题栏按钮事件监听（关闭 + 小窗口）
 */
function addCloseListener(): void {
  closeBtnElement?.addEventListener('click', handleCloseClick);
  miniBtnElement?.addEventListener('click', handleMiniClick);

  Logger.debug('[Sidebar] 标题栏按钮事件监听已添加');
}

/**
 * 移除标题栏按钮事件监听
 */
function removeCloseListener(): void {
  closeBtnElement?.removeEventListener('click', handleCloseClick);
  miniBtnElement?.removeEventListener('click', handleMiniClick);

  Logger.debug('[Sidebar] 标题栏按钮事件监听已移除');
}

// ============================================================================
// 操作函数
// ============================================================================

/**
 * 创建侧边栏（如果不存在）
 */
export function createSidebar(): HTMLDivElement {
  // 如果侧边栏已存在，直接返回
  let sidebar = document.getElementById(SIDEBAR_ID) as HTMLDivElement | null;

  if (sidebar) {
    Logger.debug('[Sidebar] 侧边栏已存在');
    return sidebar;
  }

  // 创建侧边栏
  sidebarElement = createSidebarElement();
  sidebar = sidebarElement;

  // 创建标题栏
  const header = createHeader();
  sidebarElement.appendChild(header);

  // 创建内容区域
  const content = createContent();
  sidebarElement.appendChild(content);

  // // 添加样式
  injectStyles();

  // 添加关闭按钮事件监听
  addCloseListener();

  // 添加到页面
  document.body.appendChild(sidebarElement);

  // 恢复会话内的小窗口模式
  if (miniMode) {
    sidebarElement.classList.add('mini');
  }

  Logger.info('[Sidebar] 注入式侧边栏已创建');

  return sidebarElement;
}

/**
 * 切换侧边栏显示状态
 */
export function toggleSidebar(force?: boolean): void {
  let sidebar = document.getElementById(SIDEBAR_ID);
  const isOpen = sidebar && sidebar.classList.contains('open');
  const shouldOpen = force !== undefined ? force : !isOpen;

  if (shouldOpen) {
    // 打开时，如果侧边栏不存在则创建
    if (!sidebar) {
      sidebar = createSidebar();
    }

    sidebar?.classList.add('open');

    Logger.info('[Sidebar] 侧边栏已打开');
  } else {
    // 关闭时，直接从DOM移除，而不是隐藏
    if (sidebar) {
      sidebar.remove();

      // 清理引用
      if (sidebarElement === sidebar) {
        sidebarElement = null;
      }

      Logger.info('[Sidebar] 侧边栏已从DOM移除');
    }
  }
}

/**
 * 检查侧边栏是否打开
 */
export function isSidebarOpen(): boolean {
  const sidebar = document.getElementById(SIDEBAR_ID);
  return sidebar ? sidebar.classList.contains('open') : false;
}

/**
 * 清理侧边栏
 */
export function cleanupSidebar(): void {
  // 移除侧边栏
  const sidebar = document.getElementById(SIDEBAR_ID);

  if (sidebar) {
    // 移除关闭按钮事件监听
    removeCloseListener();

    // 移除侧边栏
    sidebar.remove();

    Logger.debug('[Sidebar] 侧边栏已移除');
  }

  // 移除样式
  if (styleElement) {
    styleElement.remove();
    styleElement = null;

    Logger.debug('[Sidebar] 侧边栏样式已移除');
  }

  // 重置引用
  sidebarElement = null;
  closeBtnElement = null;
  miniBtnElement = null;
}

/**
 * 初始化侧边栏消息监听
 */
export function initSidebarMessageListener(): void {
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'toggleSidebar') {
        toggleSidebar();
        sendResponse({ status: 'ok' });
        return true;
      }

      // 如果不匹配我们的消息，返回 undefined 让其他监听器处理
      return undefined;
    });

    Logger.info('[Sidebar] 消息监听已初始化');
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      Logger.warn('[Sidebar] 消息监听初始化失败：扩展上下文已失效');
      return;
    }
    Logger.error('[Sidebar] 消息监听初始化失败:', error);
  }
}

// ============================================================================
// 导出
// ============================================================================

export default {
  createSidebar,
  toggleSidebar,
  isSidebarOpen,
  cleanupSidebar,
  initSidebarMessageListener,
};
