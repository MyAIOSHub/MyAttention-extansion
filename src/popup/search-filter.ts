/**
 * 搜索和筛选模块
 * 负责对话搜索、日期筛选、平台筛选功能
 */

import type { Conversation, PlatformName } from '@/types';
import { Logger } from '@/core/errors';
import {
  searchConversationsByTerm,
  filterConversationsByDateAndPlatform,
} from './search-filter-core';

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 日期快捷选项（天数）
 */
export type DateQuickOption = 7 | 30;

/**
 * 当前筛选状态
 */
export interface CurrentFilter {
  /** 开始日期 */
  startDate: string | null;
  /** 结束日期 */
  endDate: string | null;
  /** 选中的平台 */
  platforms: Set<PlatformName>;
}

/**
 * 默认筛选状态
 */
export const DEFAULT_FILTER: CurrentFilter = {
  startDate: null,
  endDate: null,
  platforms: new Set<PlatformName>(),
};

// ============================================================================
// 全局变量
// ============================================================================

/**
 * 所有对话
 */
let allConversations: Conversation[] = [];

/**
 * 过滤后的对话
 */
let filteredConversations: Conversation[] = [];

/**
 * 当前搜索词
 */
let currentSearchTerm = '';

/**
 * 当前筛选状态
 */
let currentFilter: CurrentFilter = { ...DEFAULT_FILTER };

/**
 * 列表渲染回调（由 popup 入口注入）
 */
let renderFilteredConversations: () => void = () => {
  updateSearchResultInfo();
};

// ============================================================================
// DOM 元素引用
// ============================================================================

export const elements = {
  /** 搜索相关 */
  searchContainer: document.getElementById('search-container'),
  searchInput: document.getElementById('search-input') as HTMLInputElement | null,
  clearSearch: document.getElementById('clear-search'),

  /** 筛选相关 */
  filterToggle: document.getElementById('filter-toggle'),
  filterDropdown: document.getElementById('filter-dropdown'),
  filterIcon: document.getElementById('filter-icon'),

  /** 日期相关 */
  startDate: document.getElementById('start-date') as HTMLInputElement | null,
  endDate: document.getElementById('end-date') as HTMLInputElement | null,
  startDateClear: document.getElementById('start-date-clear'),
  endDateClear: document.getElementById('end-date-clear'),
  startDatePicker: document.getElementById('start-date-picker'),
  endDatePicker: document.getElementById('end-date-picker'),
  dateWeek: document.getElementById('date-week'),
  dateMonth: document.getElementById('date-month'),

  /** 平台相关 */
  platformTagsContainer: document.getElementById('platform-tags-container'),
  platformTags: document.getElementById('platform-tags'),
  platformPlaceholder: document.getElementById('platform-placeholder'),
  platformDropdownMenu: document.getElementById('platform-dropdown-menu'),

  /** 筛选操作 */
  applyFilter: document.getElementById('apply-filter'),
  clearFilter: document.getElementById('clear-filter'),

  /** 搜索结果信息 */
  searchResultInfo: document.getElementById('search-result-info'),
  resultCountText: document.getElementById('result-count-text'),
};

// ============================================================================
// 搜索功能
// ============================================================================

/**
 * 搜索对话函数
 */
export function searchConversations(
  conversations: Conversation[],
  searchTerm: string
): Conversation[] {
  return searchConversationsByTerm(conversations, searchTerm);
}

/**
 * 处理搜索输入事件
 */
export function handleSearchInput(term: string): void {
  currentSearchTerm = term.trim();

  // 执行搜索
  performSearch(currentSearchTerm);
}

/**
 * 清空搜索输入
 */
export function clearSearchInput(): void {
  if (elements.searchInput) {
    elements.searchInput.value = '';
  }
  currentSearchTerm = '';

  // 清空筛选
  clearFilter();

  // 重新执行搜索
  performSearch('');
}

/**
 * 执行搜索
 */
export function performSearch(searchTerm: string): void {
  // 先应用日期和平台筛选
  const dateFiltered = applyDateAndPlatformFilter(allConversations);

  // 再应用搜索过滤
  filteredConversations = searchConversations(dateFiltered, searchTerm);

  // 渲染过滤结果
  renderFilteredConversations();

  // 更新清除按钮状态
  updateClearSearchButtonState();
  updateSearchResultInfo();
}

/**
 * 更新清除搜索按钮状态
 */
export function updateClearSearchButtonState(): void {
  if (elements.clearSearch) {
    elements.clearSearch.style.display = currentSearchTerm ? 'block' : 'none';
  }
}

// ============================================================================
// 日期筛选
// ============================================================================

/**
 * 设置日期快捷选项
 */
export function setQuickDateRange(days: DateQuickOption): void {
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - days);

  currentFilter.startDate = startDate.toISOString().split('T')[0];
  currentFilter.endDate = endDate.toISOString().split('T')[0];

  // 更新 UI
  updateDatePickerUI();

  Logger.debug(
    `[SearchFilter] 设置日期范围: ${days}天 (${startDate.toISOString().split('T')[0]} - ${endDate.toISOString().split('T')[0]})`
  );
}

/**
 * 应用日期和平台筛选
 */
export function applyDateAndPlatformFilter(
  conversations: Conversation[]
): Conversation[] {
  return filterConversationsByDateAndPlatform(conversations, currentFilter);
}

// ============================================================================
// 平台筛选
// ============================================================================

/**
 * 切换平台选择状态
 */
export function togglePlatformSelection(platform: PlatformName): void {
  if (currentFilter.platforms.has(platform)) {
    currentFilter.platforms.delete(platform);
  } else {
    currentFilter.platforms.add(platform);
  }

  // 更新平台标签 UI
  updatePlatformTagsUI();

  Logger.debug(
    `[SearchFilter] 切换平台: ${platform}, 当前选中: ${Array.from(
      currentFilter.platforms
    ).join(', ')}`
  );
}

/**
 * 更新平台标签 UI
 */
export function updatePlatformTagsUI(): void {
  if (!elements.platformTags || !elements.platformPlaceholder) {
    return;
  }

  const platformTags = elements.platformTags;

  // 清空现有标签
  platformTags.innerHTML = '';

  if (currentFilter.platforms.size === 0) {
    // 显示占位符
    elements.platformPlaceholder.classList.remove('hidden');
  } else {
    // 隐藏占位符
    elements.platformPlaceholder.classList.add('hidden');

    // 添加选中的平台标签
    const platforms = [
      'chatgpt',
      'gemini',
      'qwen',
      'claude',
      'deepseek',
      'yuanbao',
      'doubao',
      'kimi',
    ] as PlatformName[];

    platforms.forEach((platform) => {
      if (currentFilter.platforms.has(platform)) {
        const tag = document.createElement('div');
        tag.className = `platform-tag platform-${platform}`;
        tag.textContent = getPlatformDisplayName(platform);
        platformTags.appendChild(tag);
      }
    });
  }
}

/**
 * 获取平台显示名称
 */
function getPlatformDisplayName(platform: PlatformName): string {
  const names: Record<PlatformName, string> = {
    chatgpt: 'ChatGPT',
    gemini: 'Gemini',
    qwen: 'Qwen',
    claude: 'Claude',
    deepseek: 'DeepSeek',
    yuanbao: '腾讯元宝',
    doubao: '豆包',
    kimi: 'Kimi',
  };

  return names[platform] || platform;
}

// ============================================================================
// 筛选操作
// ============================================================================

/**
 * 切换筛选下拉菜单
 */
export function toggleFilterDropdown(): void {
  if (!elements.filterDropdown) {
    return;
  }

  const isHidden = elements.filterDropdown.classList.contains('hidden');
  elements.filterDropdown.classList.toggle('hidden');

  if (!isHidden) {
    // 显示时，确保日期选择器隐藏
    hideDatePicker('start');
    hideDatePicker('end');
  }
}

/**
 * 应用当前筛选
 */
export function applyFilter(): void {
  performSearch(currentSearchTerm);
}

/**
 * 清空筛选
 */
export function clearFilter(): void {
  currentFilter = { ...DEFAULT_FILTER };

  // 更新 UI
  updateDatePickerUI();
  updatePlatformTagsUI();

  Logger.debug('[SearchFilter] 筛选已清空');
}

/**
 * 兼容旧入口：初始化筛选模块（当前模块为无状态初始化）
 */
export function initializeFilter(): void {
  updateDatePickerUI();
  updatePlatformTagsUI();
  updateSearchResultInfo();
  filteredConversations = [...allConversations];
}

/**
 * 注入列表渲染回调
 */
export function setFilteredConversationsRenderer(renderer: () => void): void {
  renderFilteredConversations = renderer;
}

/**
 * 设置待筛选的对话全集
 */
export function setAllConversationsForFilter(conversations: Conversation[]): void {
  allConversations = conversations;
  filteredConversations = [...conversations];
  updateSearchResultInfo();
}

/**
 * 获取当前筛选结果
 */
export function getFilteredConversations(): Conversation[] {
  return filteredConversations;
}

/**
 * 兼容旧入口：获取当前筛选条件
 */
export function getCurrentFilter(): CurrentFilter {
  return { ...currentFilter };
}

/**
 * 兼容旧入口：日期快捷处理
 */
export function handleDateQuickOptions(option: DateQuickOption): void {
  setQuickDateRange(option);
}

// ============================================================================
// UI 辅助函数
// ============================================================================

/**
 * 更新日期选择器 UI
 */
export function updateDatePickerUI(): void {
  if (!elements.startDate || !elements.endDate) {
    return;
  }

  const startDateClear = elements.startDateClear;
  const endDateClear = elements.endDateClear;

  // 设置开始日期
  if (currentFilter.startDate) {
    elements.startDate.value = currentFilter.startDate;
    if (startDateClear) {
      startDateClear.style.display = 'block';
    }
  } else {
    elements.startDate.value = '';
    if (startDateClear) {
      startDateClear.style.display = 'none';
    }
  }

  // 设置结束日期
  if (currentFilter.endDate) {
    elements.endDate.value = currentFilter.endDate;
    if (endDateClear) {
      endDateClear.style.display = 'block';
    }
  } else {
    elements.endDate.value = '';
    if (endDateClear) {
      endDateClear.style.display = 'none';
    }
  }
}

/**
 * 显示日期选择器
 */
export function showDatePicker(type: 'start' | 'end'): void {
  const picker = type === 'start' ? elements.startDatePicker : elements.endDatePicker;

  if (picker) {
    picker.classList.remove('hidden');
  }

  Logger.debug(`[SearchFilter] 显示日期选择器: ${type}`);
}

/**
 * 隐藏日期选择器
 */
export function hideDatePicker(type: 'start' | 'end'): void {
  const picker = type === 'start' ? elements.startDatePicker : elements.endDatePicker;

  if (picker) {
    picker.classList.add('hidden');
  }

  Logger.debug(`[SearchFilter] 隐藏日期选择器: ${type}`);
}

/**
 * 更新搜索结果信息
 */
export function updateSearchResultInfo(): void {
  if (!elements.resultCountText || !elements.searchResultInfo) {
    return;
  }

  elements.resultCountText.textContent = `${filteredConversations.length}`;

  if (currentSearchTerm) {
    elements.searchResultInfo.classList.remove('hidden');
  } else {
    elements.searchResultInfo.classList.add('hidden');
  }
}

// ============================================================================
// 导出
// ============================================================================

export default {
  // 数据管理
  setAllConversations: (conversations: Conversation[]) => {
    allConversations = conversations;
  },

  getFilteredConversations: () => filteredConversations,
  getCurrentFilter: () => ({ ...currentFilter }),

  // 搜索
  handleSearchInput,
  clearSearchInput,
  performSearch,

  // 日期筛选
  setQuickDateRange,
  updateDatePickerUI,
  showDatePicker,
  hideDatePicker,

  // 平台筛选
  togglePlatformSelection,
  updatePlatformTagsUI,

  // 筛选
  toggleFilterDropdown,
  applyFilter,
  clearFilter,

  // UI 更新
  updateSearchResultInfo,
};
