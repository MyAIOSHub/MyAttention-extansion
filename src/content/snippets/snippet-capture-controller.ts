import type {
  AppSettings,
  PlatformAdapter,
  PlatformName,
  SnippetGroup,
  SnippetGroupDetail,
  SnippetInput,
  SnippetSelectionInput,
  SnippetSelectionUpsertResult,
} from '@/types';
import {
  chromeMessageAdapter,
  isExtensionContextInvalidatedError,
  isRuntimeContextAvailable,
} from '@/core/chrome-message';
import { Logger } from '@/core/errors';
import { isAIConversationPage } from '@/core/page-scope';
import { SelectionObserver } from './selection-observer';
import { describeRange } from './selector-describer';
import { DwellTracker } from './dwell-tracker';
import {
  findGenericContextRoot,
  getElementText,
  getGenericDwellCandidates,
  getPrimaryPageContent,
  isExcludedElement,
} from './generic-candidate-resolver';
import { selectedRange } from './range-utils';
import { resolveSemanticSelectionContext } from './semantic-block-resolver';
import { HighlightManager } from './highlight-manager';
import { replaySnippetHighlights } from './highlight-replayer';
import { anchorRangeFromSelectors } from './selector-anchor';

interface CaptureControllerOptions {
  getSettings: () => { autoSave: boolean; webCapture: NonNullable<AppSettings['webCapture']> };
  getActiveAdapter: () => PlatformAdapter | null;
  getCurrentPlatform: () => PlatformName | null;
  onSnippetSaved?: (snippet: SnippetGroup | SnippetInput) => void;
}

interface SelectionContext {
  root: Element;
  selectionText: string;
  messageIndex?: number;
  sourceKind: 'web_page' | 'ai_conversation';
  platform?: PlatformName;
  conversationId?: string;
}

const VALID_TEXT_PATTERN = /[A-Za-z0-9\u4e00-\u9fff]/;
const SNIPPET_TOAST_ID = 'sayso-snippet-toast';
const HIGHLIGHT_REPLAY_DELAY_MS = 220;

function cleanUrl(url: string): string {
  return url.split('#')[0].split('?')[0];
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(16);
}

function extractConversationId(adapter: PlatformAdapter | null): string | undefined {
  if (!adapter) {
    return undefined;
  }

  const info = adapter.extractConversationInfo(window.location.href) as {
    conversationId?: string | null;
    conversationInfo?: { conversationId?: string | null };
  };
  return info?.conversationInfo?.conversationId || info?.conversationId || undefined;
}

function selectionTextAllowed(text: string): boolean {
  const normalized = normalizeText(text);
  return normalized.length >= 8 && VALID_TEXT_PATTERN.test(normalized);
}

function nodeToElement(node: Node | null): Element | null {
  if (!node) {
    return null;
  }

  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function showSnippetToast(message: string): void {
  let toast = document.getElementById(SNIPPET_TOAST_ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = SNIPPET_TOAST_ID;
    toast.setAttribute(
      'style',
      [
        'position:fixed',
        'right:20px',
        'bottom:20px',
        'z-index:2147483647',
        'background:#111827',
        'color:#fff',
        'padding:8px 12px',
        'border-radius:999px',
        'font-size:12px',
        'line-height:1',
        'box-shadow:0 8px 24px rgba(0,0,0,0.16)',
        'opacity:0',
        'transition:opacity .18s ease',
        'pointer-events:none',
      ].join(';')
    );
    document.documentElement.appendChild(toast);
  }

  toast.textContent = message;
  toast.style.opacity = '1';
  window.setTimeout(() => {
    if (toast) {
      toast.style.opacity = '0';
    }
  }, 1600);
}

function buildDedupeKey(parts: Array<string | number | undefined | null>): string {
  return parts
    .map((part) => String(part || '').trim())
    .filter((part) => part.length > 0)
    .join(':');
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRuntimeStale(error: unknown): boolean {
  return isExtensionContextInvalidatedError(error);
}

function getAiMessageCandidates(adapter: PlatformAdapter): Element[] {
  const all = Array.from(document.body.querySelectorAll('*')).filter((element) =>
    adapter.isMessageElement(element)
  );

  return all.filter((element) => !all.some((other) => other !== element && other.contains(element)));
}

function findAiContext(range: Range, adapter: PlatformAdapter, platform: PlatformName): SelectionContext | null {
  let current: Node | null = range.commonAncestorContainer;
  while (current && current !== document.body) {
    if (current.nodeType === Node.ELEMENT_NODE && adapter.isMessageElement(current)) {
      const root = current as Element;
      const candidates = getAiMessageCandidates(adapter);
      return {
        root,
        selectionText: normalizeText(range.toString()),
        messageIndex: candidates.findIndex((element) => element === root),
        sourceKind: 'ai_conversation',
        platform,
        conversationId: extractConversationId(adapter),
      };
    }
    current = current.parentNode;
  }

  return null;
}

function extractSnippetSelectionResult(response: unknown): SnippetSelectionUpsertResult | null {
  const result = response as {
    group?: SnippetGroup;
    item?: SnippetSelectionUpsertResult['item'];
    data?: { group?: SnippetGroup; item?: SnippetSelectionUpsertResult['item'] };
  } | null;

  const group = result?.group || result?.data?.group;
  const item = result?.item || result?.data?.item;
  if (!group || !item) {
    return null;
  }

  return { group, item };
}

function extractSnippetGroups(response: unknown): SnippetGroupDetail[] {
  const result = response as {
    snippets?: SnippetGroupDetail[];
    data?: { snippets?: SnippetGroupDetail[] };
  } | null;
  return result?.snippets || result?.data?.snippets || [];
}

export class SnippetCaptureController {
  private selectionObserver: SelectionObserver | null = null;

  private dwellTracker: DwellTracker | null = null;

  private dwellRefreshTimer: number | null = null;

  private mutationObserver: MutationObserver | null = null;

  private highlightReplayTimer: number | null = null;

  private readonly highlightManager = new HighlightManager();

  private isStarted = false;

  private readonly runtimeMessageListener = (
    message: { type?: string; selectionText?: string; itemId?: string },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => {
    if (message.type === 'captureSelectionFromContextMenu') {
      void this.captureSelectionFromContextMenu(message.selectionText || '').finally(() => {
        sendResponse({ status: 'ok' });
      });
      return true;
    }

    if (message.type === 'capturePageFromContextMenu') {
      void this.capturePageFromContextMenu().finally(() => {
        sendResponse({ status: 'ok' });
      });
      return true;
    }

    if (message.type === 'rebuildSnippetHighlights') {
      void this.rebuildHighlights().finally(() => {
        sendResponse({ status: 'ok' });
      });
      return true;
    }

    if (message.type === 'focusSnippetItem') {
      if (message.itemId) {
        this.highlightManager.focusItem(message.itemId);
      }
      sendResponse({ status: 'ok' });
      return true;
    }

    return undefined;
  };

  constructor(private readonly options: CaptureControllerOptions) {}

  start(): void {
    if (this.isStarted) {
      return;
    }

    this.isStarted = true;
    this.selectionObserver = new SelectionObserver((range) => {
      void this.handleObservedSelection(range);
    });

    this.dwellTracker = new DwellTracker((record) => {
      void this.handleDwell(record.element, record.dwellMs);
    });

    this.refreshDwellCandidates();
    this.scheduleHighlightReplay();

    this.mutationObserver = new MutationObserver(() => {
      if (this.dwellRefreshTimer) {
        clearTimeout(this.dwellRefreshTimer);
      }
      this.dwellRefreshTimer = window.setTimeout(() => {
        this.refreshDwellCandidates();
      }, 400);
    });
    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    if (isRuntimeContextAvailable()) {
      chrome.runtime.onMessage.addListener(this.runtimeMessageListener);
    } else {
      Logger.debug('[SnippetCapture] 扩展上下文已失效，跳过上下文菜单消息监听');
    }
  }

  stop(): void {
    this.selectionObserver?.disconnect();
    this.selectionObserver = null;
    this.dwellTracker?.disconnect();
    this.dwellTracker = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    if (this.dwellRefreshTimer) {
      clearTimeout(this.dwellRefreshTimer);
      this.dwellRefreshTimer = null;
    }
    if (this.highlightReplayTimer) {
      clearTimeout(this.highlightReplayTimer);
      this.highlightReplayTimer = null;
    }
    this.highlightManager.clearAll();
    if (isRuntimeContextAvailable()) {
      chrome.runtime.onMessage.removeListener(this.runtimeMessageListener);
    }
    this.isStarted = false;
  }

  refreshForUrlChange(): void {
    this.refreshDwellCandidates();
    this.scheduleHighlightReplay();
  }

  private async handleObservedSelection(range: Range | null): Promise<void> {
    const settings = this.options.getSettings();
    if (!settings.webCapture.enabled || !settings.webCapture.highlightEnabled || !range) {
      return;
    }

    try {
      await this.captureRange(range, 'auto_selection');
    } catch (error) {
      if (isRuntimeStale(error)) {
        Logger.debug('[SnippetCapture] 自动划词保存跳过：扩展上下文已失效，等待页面刷新');
        return;
      }
      Logger.error('[SnippetCapture] 自动划词保存失败:', error);
    }
  }

  private async captureSelectionFromContextMenu(fallbackSelectionText: string): Promise<void> {
    const range = selectedRange(document.getSelection());
    if (range) {
      await this.captureRange(range, 'context_menu_selection', fallbackSelectionText);
      return;
    }

    const text = normalizeText(fallbackSelectionText);
    if (!selectionTextAllowed(text)) {
      return;
    }

    const settings = this.options.getSettings();
    const primary = getPrimaryPageContent();
    const rawContextText = getElementText(primary);

    const selection: SnippetSelectionInput = {
      groupKey: settings.webCapture.semanticMergeEnabled === false
        ? buildDedupeKey(['highlight', cleanUrl(window.location.href), text, hashText(text)])
        : buildDedupeKey(['highlight', cleanUrl(window.location.href), hashText(rawContextText.slice(0, 500))]),
      captureMethod: 'context_menu_selection',
      selectionText: text,
      selectors: [],
      url: cleanUrl(window.location.href),
      title: document.title || cleanUrl(window.location.href),
      sourceKind: 'web_page',
      semanticBlockKey: hashText(`${cleanUrl(window.location.href)}:${rawContextText.slice(0, 500)}`),
      headingPath: [],
      blockKind: 'section',
      rawContextText,
      rawContextMarkdown: rawContextText,
      summaryText: text,
      quoteHash: hashText(`${text}:${cleanUrl(window.location.href)}`),
      semanticMergeEnabled: settings.webCapture.semanticMergeEnabled !== false,
      llmStructuringEnabled: settings.webCapture.llmStructuringEnabled !== false,
    };

    await this.saveSelectionSnippet(selection);
  }

  private async capturePageFromContextMenu(): Promise<void> {
    const root = getPrimaryPageContent();
    if (!root) {
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(root);
    const contextText = getElementText(root);

    await this.saveSnippet({
      dedupeKey: buildDedupeKey(['page_save', cleanUrl(window.location.href), contextText.slice(0, 120)]),
      type: 'page_save',
      captureMethod: 'context_menu_page',
      selectionText: '',
      contextText,
      selectors: describeRange(root, range),
      url: cleanUrl(window.location.href),
      title: document.title || cleanUrl(window.location.href),
      sourceKind: 'web_page',
    });
  }

  private async handleDwell(element: Element, dwellMs: number): Promise<void> {
    const settings = this.options.getSettings();
    if (!settings.webCapture.enabled || !settings.webCapture.dwellEnabled) {
      return;
    }

    const text = getElementText(element);
    if (text.length < 80) {
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(element);
    const platform = this.options.getCurrentPlatform();
    const adapter = this.options.getActiveAdapter();
    const isAi = !!(platform && adapter && isAIConversationPage(window.location.href));

    await this.saveSnippet({
      dedupeKey: buildDedupeKey([
        'dwell',
        cleanUrl(window.location.href),
        text.slice(0, 160),
        platform,
        extractConversationId(adapter),
      ]),
      type: 'dwell',
      captureMethod: 'auto_dwell',
      selectionText: '',
      contextText: text,
      selectors: describeRange(element, range),
      dwellMs,
      url: cleanUrl(window.location.href),
      title: document.title || cleanUrl(window.location.href),
      sourceKind: isAi ? 'ai_conversation' : 'web_page',
      platform: isAi ? platform || undefined : undefined,
      conversationId: isAi ? extractConversationId(adapter) : undefined,
    });
  }

  private async captureRange(
    range: Range,
    captureMethod: 'auto_selection' | 'context_menu_selection',
    fallbackSelectionText = ''
  ): Promise<void> {
    const settings = this.options.getSettings();
    const context = this.resolveSelectionContext(range);
    if (!context) {
      return;
    }

    const selectionText = normalizeText(context.selectionText || fallbackSelectionText);
    if (!selectionTextAllowed(selectionText) || isExcludedElement(context.root)) {
      return;
    }

    const semanticContext = resolveSemanticSelectionContext({
      range,
      sourceKind: context.sourceKind,
      platform: context.platform,
      conversationId: context.conversationId,
      preferredRoot: context.root,
    });
    if (!semanticContext || !semanticContext.rawContextText) {
      return;
    }

    const selectors = describeRange(semanticContext.root, range);
    const quoteHash = hashText(`${selectionText}:${JSON.stringify(selectors)}`);
    const groupKey = settings.webCapture.semanticMergeEnabled === false
      ? buildDedupeKey([
          'highlight',
          cleanUrl(window.location.href),
          context.sourceKind,
          context.platform,
          context.conversationId,
          context.messageIndex,
          semanticContext.semanticBlockKey,
          quoteHash,
        ])
      : buildDedupeKey([
          'highlight',
          cleanUrl(window.location.href),
          context.sourceKind,
          context.platform,
          context.conversationId,
          context.messageIndex,
          semanticContext.semanticBlockKey,
        ]);

    await this.saveSelectionSnippet({
      groupKey,
      captureMethod,
      selectionText,
      selectors,
      url: cleanUrl(window.location.href),
      title: document.title || cleanUrl(window.location.href),
      sourceKind: context.sourceKind,
      platform: context.platform,
      conversationId: context.conversationId,
      messageIndex: context.messageIndex,
      semanticBlockKey: semanticContext.semanticBlockKey,
      headingPath: semanticContext.headingPath,
      blockKind: semanticContext.blockKind,
      rawContextText: semanticContext.rawContextText,
      rawContextMarkdown: semanticContext.rawContextMarkdown,
      summaryText: selectionText,
      quoteHash,
      semanticMergeEnabled: settings.webCapture.semanticMergeEnabled !== false,
      llmStructuringEnabled: settings.webCapture.llmStructuringEnabled !== false,
    }, range.cloneRange());
  }

  private resolveSelectionContext(range: Range): SelectionContext | null {
    const platform = this.options.getCurrentPlatform();
    const adapter = this.options.getActiveAdapter();

    if (platform && adapter && isAIConversationPage(window.location.href)) {
      const adapterContext = adapter.getSelectionContext?.(range);
      if (adapterContext) {
        return {
          root:
            adapterContext.root ||
            findGenericContextRoot(range) ||
            nodeToElement(range.commonAncestorContainer) ||
            document.body,
          selectionText: adapterContext.selectionText || normalizeText(range.toString()),
          messageIndex: adapterContext.messageIndex,
          sourceKind: 'ai_conversation',
          platform,
          conversationId: extractConversationId(adapter),
        };
      }

      const genericAiContext = findAiContext(range, adapter, platform);
      if (genericAiContext) {
        return genericAiContext;
      }
    }

    const root = findGenericContextRoot(range);
    if (!root) {
      return null;
    }

    return {
      root,
      selectionText: normalizeText(range.toString()),
      sourceKind: 'web_page',
    };
  }

  private refreshDwellCandidates(): void {
    const settings = this.options.getSettings();
    if (!settings.webCapture.enabled || !settings.webCapture.dwellEnabled || !this.dwellTracker) {
      this.dwellTracker?.disconnect();
      return;
    }

    const adapter = this.options.getActiveAdapter();
    const platform = this.options.getCurrentPlatform();
    const candidates =
      adapter && platform && isAIConversationPage(window.location.href)
        ? adapter.getDwellCandidates?.() || getAiMessageCandidates(adapter)
        : getGenericDwellCandidates();

    this.dwellTracker.observe(candidates);
  }

  private async saveSnippet(snippet: SnippetInput): Promise<void> {
    try {
      await chromeMessageAdapter.sendMessage({
        type: 'upsertSnippet',
        snippet,
      });
      this.options.onSnippetSaved?.(snippet);
      showSnippetToast('My Attention 已记录');
      Logger.info('[SnippetCapture] 已保存片段:', snippet.type, snippet.url);
    } catch (error) {
      if (isRuntimeStale(error)) {
        Logger.debug('[SnippetCapture] 保存片段跳过：扩展上下文已失效');
        return;
      }
      const message = toErrorMessage(error);
      Logger.error('[SnippetCapture] 保存片段失败:', error);
      showSnippetToast(message.includes('Restart local-store')
        ? 'My Attention 记录失败，请重启 local-store'
        : 'My Attention 记录失败');
      throw error;
    }
  }

  private async saveSelectionSnippet(selection: SnippetSelectionInput, range?: Range): Promise<void> {
    try {
      const response = await chromeMessageAdapter.sendMessage({
        type: 'upsertSnippetSelection',
        selection,
      });
      const result = extractSnippetSelectionResult(response);
      if (!result) {
        throw new Error('SNIPPET_SELECTION_SAVE_FAILED');
      }

      const settings = this.options.getSettings();
      if (settings.webCapture.highlightOverlayEnabled !== false) {
        const resolvedRange =
          (range ? range.cloneRange() : null) || anchorRangeFromSelectors(result.item.selectors);
        if (resolvedRange) {
          this.highlightManager.registerRange(result.group.id, result.item.id, resolvedRange);
        }
      }

      this.options.onSnippetSaved?.(result.group);
      showSnippetToast('My Attention 已记录');
      Logger.info('[SnippetCapture] 已保存划词片段:', result.group.id, result.item.id);
    } catch (error) {
      if (isRuntimeStale(error)) {
        Logger.debug('[SnippetCapture] 保存划词片段跳过：扩展上下文已失效');
        return;
      }
      const message = toErrorMessage(error);
      Logger.error('[SnippetCapture] 保存划词片段失败:', error);
      showSnippetToast(message.includes('Restart local-store')
        ? 'My Attention 记录失败，请重启 local-store'
        : 'My Attention 记录失败');
      throw error;
    }
  }

  private scheduleHighlightReplay(): void {
    if (this.highlightReplayTimer) {
      clearTimeout(this.highlightReplayTimer);
    }

    this.highlightReplayTimer = window.setTimeout(() => {
      void this.rebuildHighlights();
    }, HIGHLIGHT_REPLAY_DELAY_MS);
  }

  private async rebuildHighlights(): Promise<void> {
    const settings = this.options.getSettings();
    if (!settings.webCapture.enabled || settings.webCapture.highlightReplayEnabled === false) {
      this.highlightManager.clearAll();
      return;
    }

    try {
      const response = await chromeMessageAdapter.sendMessage({
        type: 'getSnippetsByUrl',
        url: cleanUrl(window.location.href),
      });
      const snippets = extractSnippetGroups(response).filter((detail) => detail.group.type === 'highlight');
      replaySnippetHighlights(this.highlightManager, snippets);
    } catch (error) {
      if (isRuntimeStale(error)) {
        Logger.debug('[SnippetCapture] 恢复高光跳过：扩展上下文已失效');
        return;
      }
      Logger.error('[SnippetCapture] 恢复高光失败:', error);
    }
  }
}

export function createSnippetCaptureController(options: CaptureControllerOptions): SnippetCaptureController {
  return new SnippetCaptureController(options);
}
