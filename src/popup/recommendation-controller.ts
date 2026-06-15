/**
 * 推荐 Tab 控制器（M1 垂直切片）
 * - 4 态渲染（empty / loading / ready / error）
 * - 2s 轮询任务状态
 * - 卡片交互：打开 / 保存到注意力
 */

import { Logger } from '@/core/errors';
import type { RecommendationSession, RecommendationCard } from '@/types';

interface Elements {
  empty: HTMLElement | null;
  loading: HTMLElement | null;
  loadingText: HTMLElement | null;
  error: HTMLElement | null;
  errorText: HTMLElement | null;
  retryBtn: HTMLElement | null;
  list: HTMLElement | null;
  cards: HTMLElement | null;
}

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_DURATION_MS = 90_000;

let pollTimer: number | null = null;
let pollStartedAt = 0;
let lastTriggerParams: { triggerSource: 'from_summary'; summaryTaskId: string } | null = null;

function getElements(): Elements {
  return {
    empty: document.getElementById('recommend-empty'),
    loading: document.getElementById('recommend-loading'),
    loadingText: document.getElementById('recommend-loading-text'),
    error: document.getElementById('recommend-error'),
    errorText: document.getElementById('recommend-error-text'),
    retryBtn: document.getElementById('recommend-retry-btn'),
    list: document.getElementById('recommend-list'),
    cards: document.getElementById('recommend-cards'),
  };
}

function showOnly(kind: 'empty' | 'loading' | 'error' | 'list'): void {
  const els = getElements();
  const map = { empty: els.empty, loading: els.loading, error: els.error, list: els.list };
  for (const [k, el] of Object.entries(map)) {
    if (!el) continue;
    if (k === kind) el.classList.remove('hidden');
    else el.classList.add('hidden');
  }
}

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(sessionId: string): void {
  stopPolling();
  pollStartedAt = Date.now();
  pollTimer = window.setInterval(() => {
    void pollOnce(sessionId);
  }, POLL_INTERVAL_MS);
  void pollOnce(sessionId);
}

async function pollOnce(sessionId: string): Promise<void> {
  if (Date.now() - pollStartedAt > MAX_POLL_DURATION_MS) {
    stopPolling();
    renderError('轮询超时，请稍后重试');
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'getRecommendationSession',
      sessionId,
    });
    const session: RecommendationSession | null = response?.session ?? null;
    if (!session) return;
    renderSession(session);
    if (session.status === 'done' || session.status === 'error') {
      stopPolling();
    }
  } catch (error) {
    Logger.warn('[Recommend] poll error', error);
  }
}

function renderSession(session: RecommendationSession): void {
  if (session.status === 'pending' || session.status === 'extracting' || session.status === 'searching') {
    showOnly('loading');
    const els = getElements();
    if (els.loadingText) {
      els.loadingText.textContent = session.progress ?? '处理中...';
    }
    return;
  }
  if (session.status === 'error') {
    renderError(session.error ?? '未知错误');
    return;
  }
  if (session.status === 'done') {
    renderCards(session);
  }
}

function renderError(message: string): void {
  showOnly('error');
  const els = getElements();
  if (els.errorText) els.errorText.textContent = message;
}

function renderCards(session: RecommendationSession): void {
  const els = getElements();
  if (!els.cards) return;
  if (session.cards.length === 0) {
    showOnly('empty');
    const emptyEl = els.empty;
    if (emptyEl) {
      emptyEl.innerHTML = `
        <div class="text-center">
          <i class="fas fa-info-circle text-4xl text-gray-300 mb-3"></i>
          <p class="text-gray-500">本次没有匹配到源头内容</p>
        </div>`;
    }
    return;
  }
  showOnly('list');
  els.cards.innerHTML = '';
  for (const card of session.cards) {
    if (card.dismissed) continue;
    els.cards.appendChild(buildCardElement(session.id, card));
  }
}

function buildCardElement(sessionId: string, card: RecommendationCard): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'bg-white border border-gray-200 rounded-lg p-3 hover:shadow-sm transition';
  const sourceLabel = {
    paper: '📄 论文',
    official_doc: '📘 官方文档',
    original_author: '✍️ 原作者',
    repo: '💻 仓库',
    other: '🔗 资源',
  }[card.sourceKind] ?? `🔗 ${card.sourceKind}`;

  wrapper.innerHTML = `
    <div class="text-xs text-gray-500 mb-1">${escapeHtml(sourceLabel)}</div>
    <div class="text-sm font-medium text-gray-800 mb-1 line-clamp-2">${escapeHtml(card.title)}</div>
    <div class="text-xs text-gray-600 mb-2 line-clamp-3">${escapeHtml(card.snippet)}</div>
    ${card.rationale ? `<div class="text-xs text-brand bg-brand-light rounded px-2 py-1 mb-2">💡 ${escapeHtml(card.rationale)}</div>` : ''}
    <div class="text-xs text-gray-400 mb-2">📍 ${escapeHtml(card.domain)}${card.publishedAt ? ` · ${escapeHtml(card.publishedAt)}` : ''}</div>
    <div class="flex gap-2">
      <button data-action="open" class="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50">打开</button>
      <button data-action="save" class="text-xs px-2 py-1 border border-brand text-brand rounded hover:bg-brand-light ${card.saved ? 'opacity-60 pointer-events-none' : ''}">
        ${card.saved ? '已保存' : '保存到注意力'}
      </button>
    </div>
  `;

  wrapper.querySelector('[data-action="open"]')?.addEventListener('click', () => {
    window.open(card.url, '_blank');
    void chrome.runtime.sendMessage({
      type: 'markRecommendationInteracted',
      sessionId,
      cardId: card.id,
      action: 'opened',
    });
  });

  wrapper.querySelector('[data-action="save"]')?.addEventListener('click', async () => {
    if (card.saved) return;
    const snippetResp = await chrome.runtime.sendMessage({
      type: 'upsertSnippet',
      snippet: {
        dedupeKey: `recommendation:${card.id}`,
        type: 'page_save',
        captureMethod: 'context_menu_page',
        selectionText: card.title,
        contextText: card.snippet,
        selectors: [],
        url: card.url,
        title: card.title,
        domain: card.domain,
        sourceKind: 'web_page',
        headingPath: [card.rationale || card.sourceKind],
        rawContextMarkdown: card.snippet,
        summaryText: card.rationale,
      },
    });

    const savedSnippetId = snippetResp?.data?.snippet?.id ?? snippetResp?.snippet?.id;

    await chrome.runtime.sendMessage({
      type: 'markRecommendationInteracted',
      sessionId,
      cardId: card.id,
      action: 'saved',
      savedSnippetId,
    });

    card.saved = true;
    // 异步期间用户可能切走并重渲染列表，wrapper 已脱离文档；避免改动孤立节点。
    const btn = wrapper.querySelector('[data-action="save"]');
    if (btn && document.contains(btn)) {
      btn.textContent = '已保存';
      btn.classList.add('opacity-60', 'pointer-events-none');
    }
  });

  return wrapper;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================================
// 外部 API
// ============================================================================

export async function onRecommendTabActivated(params?: {
  triggerSource?: 'from_summary';
  summaryTaskId?: string;
}): Promise<void> {
  const els = getElements();
  if (els.retryBtn && !els.retryBtn.dataset.bound) {
    els.retryBtn.addEventListener('click', () => {
      if (lastTriggerParams) {
        void triggerRecommendationFromSummary(lastTriggerParams.summaryTaskId);
      }
    });
    els.retryBtn.dataset.bound = '1';
  }

  if (params?.triggerSource === 'from_summary' && params.summaryTaskId) {
    await triggerRecommendationFromSummary(params.summaryTaskId);
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: 'getRecommendationSession' });
  const session: RecommendationSession | null = response?.session ?? null;
  if (!session) {
    showOnly('empty');
    return;
  }
  renderSession(session);
  if (session.status === 'pending' || session.status === 'extracting' || session.status === 'searching') {
    startPolling(session.id);
  }
}

export async function triggerRecommendationFromSummary(summaryTaskId: string): Promise<void> {
  lastTriggerParams = { triggerSource: 'from_summary', summaryTaskId };
  showOnly('loading');
  const els = getElements();
  if (els.loadingText) els.loadingText.textContent = '正在启动...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'createRecommendationSession',
      triggerSource: 'from_summary',
      summaryTaskId,
    });

    if (response?.status === 'error') {
      renderError(response.error ?? '创建任务失败');
      return;
    }

    const sessionId = response?.data?.sessionId ?? response?.sessionId;
    if (!sessionId) {
      renderError('未返回 sessionId');
      return;
    }
    startPolling(sessionId);
  } catch (error) {
    renderError(error instanceof Error ? error.message : String(error));
  }
}

export function onRecommendTabDeactivated(): void {
  stopPolling();
}
