/**
 * 侧边栏模块
 * 负责创建和管理注入式侧边栏
 */

import { Logger } from '@/core/errors';
import {
  getSafeI18nMessage,
  getSafeRuntimeUrl,
} from '@/content/common';
import {
  isExtensionContextInvalidatedError,
  isRuntimeContextAvailable,
} from '@/core/chrome-message';
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
  RESIZE_HANDLE: 'sidebar-resize-handle',
  MINI_CORNER: 'sidebar-mini-corner',
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
 * 左缘缩放手柄 + 停靠宽度（拖拽调整，持久化）
 */
let resizeHandleElement: HTMLDivElement | null = null;
let dockedWidth = SIDEBAR_WIDTH;
let isResizing = false;

/**
 * 标题栏元素（小窗口态作为拖动把手）
 */
let headerElement: HTMLDivElement | null = null;

/**
 * 小窗口态：右下角缩放角 + 浮窗位置/尺寸（持久化）+ 拖动状态
 */
let miniCornerElement: HTMLDivElement | null = null;
interface MiniRect { left: number; top: number; width: number; height: number; }
let miniRect: MiniRect | null = null;
let miniDrag: { mode: 'move' | 'resize'; sx: number; sy: number; rect: MiniRect } | null = null;

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

  // 保存引用
  headerElement = header;
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

    /* 左缘缩放手柄 */
    .${CLASS_NAMES.RESIZE_HANDLE} {
      position: absolute;
      top: 0;
      left: -3px;
      width: 8px;
      height: 100%;
      cursor: ew-resize;
      z-index: 2;
    }

    .${CLASS_NAMES.RESIZE_HANDLE}::after {
      content: '';
      position: absolute;
      top: 0;
      left: 3px;
      width: 2px;
      height: 100%;
      background: transparent;
      transition: background 0.15s ease;
    }

    .${CLASS_NAMES.RESIZE_HANDLE}:hover::after {
      background: var(--primary-color, rgba(94, 106, 210, 0.6));
    }

    /* 小窗口态不缩放宽度，隐藏左缘手柄 */
    #${SIDEBAR_ID}.mini .${CLASS_NAMES.RESIZE_HANDLE} {
      display: none;
    }

    /* 小窗口态：标题栏拖动移位 */
    #${SIDEBAR_ID}.mini .${CLASS_NAMES.SIDEBAR} {
      cursor: move;
    }

    /* 右下角缩放角（仅小窗口态显示） */
    .${CLASS_NAMES.MINI_CORNER} {
      display: none;
    }

    #${SIDEBAR_ID}.mini .${CLASS_NAMES.MINI_CORNER} {
      display: block;
      position: absolute;
      right: 0;
      bottom: 0;
      width: 18px;
      height: 18px;
      cursor: nwse-resize;
      z-index: 3;
    }

    .${CLASS_NAMES.MINI_CORNER}::after {
      content: '';
      position: absolute;
      right: 3px;
      bottom: 3px;
      width: 8px;
      height: 8px;
      border-right: 2px solid rgba(0, 0, 0, 0.28);
      border-bottom: 2px solid rgba(0, 0, 0, 0.28);
      border-bottom-right-radius: 3px;
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
  if (miniMode) {
    ensureMiniRect();
    applyMiniRect(); // 浮窗位置/尺寸
  } else {
    clearMiniInline(); // 回到停靠：清浮窗内联定位
    applyDockedWidth();
  }
  Logger.debug(`[Sidebar] 小窗口模式：${miniMode ? '开' : '关'}`);
}

/**
 * 添加标题栏按钮事件监听（关闭 + 小窗口）
 */
function addCloseListener(): void {
  closeBtnElement?.addEventListener('click', handleCloseClick);
  miniBtnElement?.addEventListener('click', handleMiniClick);
  headerElement?.addEventListener('mousedown', onMiniHeaderDown);

  Logger.debug('[Sidebar] 标题栏按钮事件监听已添加');
}

/**
 * 移除标题栏按钮事件监听
 */
function removeCloseListener(): void {
  closeBtnElement?.removeEventListener('click', handleCloseClick);
  miniBtnElement?.removeEventListener('click', handleMiniClick);
  headerElement?.removeEventListener('mousedown', onMiniHeaderDown);

  Logger.debug('[Sidebar] 标题栏按钮事件监听已移除');
}

// ============================================================================
// 宽度缩放（左缘拖拽）
// ============================================================================

/**
 * 应用停靠宽度：停靠态用拖拽宽度；小窗口态交给 CSS（不设内联宽度）。
 */
function applyDockedWidth(): void {
  if (!sidebarElement) return;
  sidebarElement.style.width = miniMode ? '' : `${dockedWidth}px`;
}

/** 把宽度夹到 [320, min(900, 96vw)]。 */
function clampWidth(w: number): number {
  const max = Math.min(900, window.innerWidth * 0.96);
  return Math.max(320, Math.min(max, w));
}

function onResizeMove(e: MouseEvent): void {
  if (!isResizing) return;
  // 侧栏靠右：宽度 = 视口右边 − 鼠标 X
  dockedWidth = clampWidth(window.innerWidth - e.clientX);
  applyDockedWidth();
}

function onResizeUp(): void {
  if (!isResizing) return;
  isResizing = false;
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeUp);
  // 还原 iframe 交互
  const iframe = sidebarElement?.querySelector('iframe') as HTMLElement | null;
  if (iframe) iframe.style.pointerEvents = '';
  document.body.style.userSelect = '';
  try {
    chrome.storage.local.set({ sidebarWidth: dockedWidth });
  } catch {
    // 忽略存储失败
  }
}

function onResizeDown(e: MouseEvent): void {
  if (miniMode) return; // 小窗口态不缩放宽度
  e.preventDefault();
  isResizing = true;
  // 拖拽时禁用 iframe 命中，否则鼠标移到 iframe 上事件丢失
  const iframe = sidebarElement?.querySelector('iframe') as HTMLElement | null;
  if (iframe) iframe.style.pointerEvents = 'none';
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeUp);
}

/**
 * 创建左缘缩放手柄
 */
function createResizeHandle(): HTMLDivElement {
  const handle = document.createElement('div');
  handle.className = CLASS_NAMES.RESIZE_HANDLE;
  handle.title = '拖拽调整宽度';
  handle.addEventListener('mousedown', onResizeDown);
  resizeHandleElement = handle;
  return handle;
}

// ============================================================================
// 小窗口：拖动移位 + 右下角缩放
// ============================================================================

const MINI_MIN_W = 300;
const MINI_MIN_H = 240;

function setIframeInteractive(on: boolean): void {
  const iframe = sidebarElement?.querySelector('iframe') as HTMLElement | null;
  if (iframe) iframe.style.pointerEvents = on ? '' : 'none';
}

/** 首次进入小窗口：从右上角默认位置初始化矩形。 */
function ensureMiniRect(): void {
  if (miniRect) return;
  const width = Math.min(400, window.innerWidth * 0.92);
  const height = Math.min(640, window.innerHeight - 24);
  miniRect = { left: Math.max(12, window.innerWidth - width - 12), top: 12, width, height };
}

/** 把 miniRect 应用为内联定位（覆盖 .mini 的 CSS 默认右上角）。 */
function applyMiniRect(): void {
  if (!sidebarElement || !miniMode || !miniRect) return;
  const s = sidebarElement.style;
  s.left = `${miniRect.left}px`;
  s.top = `${miniRect.top}px`;
  s.right = 'auto';
  s.width = `${miniRect.width}px`;
  s.height = `${miniRect.height}px`;
}

/** 退出小窗口：清掉浮窗内联定位，回到停靠 CSS + 拖拽宽度。 */
function clearMiniInline(): void {
  if (!sidebarElement) return;
  const s = sidebarElement.style;
  s.left = '';
  s.top = '';
  s.right = '';
  s.height = '';
}

function onMiniDragMove(e: MouseEvent): void {
  if (!miniDrag || !miniRect) return;
  const dx = e.clientX - miniDrag.sx;
  const dy = e.clientY - miniDrag.sy;
  if (miniDrag.mode === 'move') {
    const maxL = window.innerWidth - miniRect.width;
    const maxT = window.innerHeight - 44; // 至少露出标题栏
    miniRect.left = Math.max(0, Math.min(maxL, miniDrag.rect.left + dx));
    miniRect.top = Math.max(0, Math.min(maxT, miniDrag.rect.top + dy));
  } else {
    const maxW = window.innerWidth - miniRect.left;
    const maxH = window.innerHeight - miniRect.top;
    miniRect.width = Math.max(MINI_MIN_W, Math.min(maxW, miniDrag.rect.width + dx));
    miniRect.height = Math.max(MINI_MIN_H, Math.min(maxH, miniDrag.rect.height + dy));
  }
  applyMiniRect();
}

function onMiniDragUp(): void {
  if (!miniDrag) return;
  miniDrag = null;
  document.removeEventListener('mousemove', onMiniDragMove);
  document.removeEventListener('mouseup', onMiniDragUp);
  setIframeInteractive(true);
  document.body.style.userSelect = '';
  if (miniRect) {
    try {
      chrome.storage.local.set({ miniRect });
    } catch {
      // 忽略
    }
  }
}

function beginMiniDrag(mode: 'move' | 'resize', e: MouseEvent): void {
  if (!miniMode) return;
  ensureMiniRect();
  if (!miniRect) return;
  e.preventDefault();
  miniDrag = { mode, sx: e.clientX, sy: e.clientY, rect: { ...miniRect } };
  setIframeInteractive(false);
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onMiniDragMove);
  document.addEventListener('mouseup', onMiniDragUp);
}

/** 标题栏按下 → 移动浮窗（避开标题栏上的按钮）。 */
function onMiniHeaderDown(e: MouseEvent): void {
  if (!miniMode) return;
  if ((e.target as HTMLElement).closest('button')) return;
  beginMiniDrag('move', e);
}

/** 右下角按下 → 缩放浮窗。 */
function onMiniCornerDown(e: MouseEvent): void {
  beginMiniDrag('resize', e);
}

function createMiniCorner(): HTMLDivElement {
  const corner = document.createElement('div');
  corner.className = CLASS_NAMES.MINI_CORNER;
  corner.title = '拖拽缩放';
  corner.addEventListener('mousedown', onMiniCornerDown);
  miniCornerElement = corner;
  return corner;
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

  // 左缘缩放手柄 + 小窗口右下角缩放角
  sidebarElement.appendChild(createResizeHandle());
  sidebarElement.appendChild(createMiniCorner());

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

  // 恢复持久化的停靠宽度 + 小窗口位置/尺寸
  try {
    chrome.storage.local.get(['sidebarWidth', 'miniRect'], (r) => {
      const w = r?.sidebarWidth;
      if (typeof w === 'number' && w >= 320) {
        dockedWidth = w;
      }
      const mr = r?.miniRect;
      if (mr && typeof mr.left === 'number' && typeof mr.width === 'number') {
        miniRect = mr as MiniRect;
      }
      applyDockedWidth();
      if (miniMode) {
        ensureMiniRect();
        applyMiniRect();
      }
    });
  } catch {
    applyDockedWidth();
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

  // 清理可能残留的拖拽监听
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeUp);
  document.removeEventListener('mousemove', onMiniDragMove);
  document.removeEventListener('mouseup', onMiniDragUp);
  isResizing = false;
  miniDrag = null;

  // 重置引用
  sidebarElement = null;
  closeBtnElement = null;
  miniBtnElement = null;
  resizeHandleElement = null;
  headerElement = null;
  miniCornerElement = null;
}

/**
 * 初始化侧边栏消息监听
 */
export function initSidebarMessageListener(): void {
  if (!isRuntimeContextAvailable()) {
    Logger.debug('[Sidebar] 消息监听初始化失败：扩展上下文已失效');
    return;
  }

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
      Logger.debug('[Sidebar] 消息监听初始化失败：扩展上下文已失效');
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
