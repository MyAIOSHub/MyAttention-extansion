import type {
  AppSettings,
  PlatformAdapter,
  PlatformName,
  SaveMediaSnippetInput,
  SnippetMediaInput,
  SnippetGroup,
  SaveMediaSnippetUpload,
} from '@/types';
import {
  chromeMessageAdapter,
  isExtensionContextInvalidatedError,
  isRuntimeContextAvailable,
} from '@/core/chrome-message';
import { Logger } from '@/core/errors';
import { resolveSemanticElementContext } from '@/content/snippets/semantic-block-resolver';
import { extractMediaMetadata } from './media-metadata-extractor';
import { MediaSaveOverlay } from './media-save-overlay';
import {
  getMediaElementFromNode,
  isSaveableMediaElement,
  type SaveableMediaElement,
} from './media-target-resolver';

const HOVER_SHOW_DELAY_MS = 120;
const HOVER_HIDE_DELAY_MS = 320;
const OVERLAY_OFFSET = 10;
const TOAST_ID = 'sayso-media-snippet-toast';
const MEDIA_BROWSER_UPLOAD_MAX_BYTES = 6 * 1024 * 1024;

interface MediaHoverControllerOptions {
  getSettings: () => { autoSave: boolean; webCapture: NonNullable<AppSettings['webCapture']> };
  getActiveAdapter: () => PlatformAdapter | null;
  getCurrentPlatform: () => PlatformName | null;
  onMediaSaved?: (snippet: SnippetGroup) => void;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(16);
}

function buildDedupeKey(parts: Array<string | number | undefined | null>): string {
  return parts
    .map((part) => String(part || '').trim())
    .filter((part) => part.length > 0)
    .join(':');
}

function cleanUrl(url: string): string {
  return url.split('#')[0].split('?')[0];
}

function normalizeComparableUrl(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  if (/^(blob:|data:)/i.test(normalized)) {
    return normalized;
  }

  try {
    return new URL(normalized, window.location.href).toString();
  } catch {
    return normalized;
  }
}

function getMediaKindFromContextMenu(mediaType: string | undefined): 'image' | 'video' | 'audio' {
  if (mediaType === 'video') {
    return 'video';
  }
  if (mediaType === 'audio') {
    return 'audio';
  }
  return 'image';
}

function createFallbackSummary(sourceUrl: string, mediaKind: 'image' | 'video' | 'audio'): string {
  try {
    const url = new URL(sourceUrl, window.location.href);
    const fileName = url.pathname.split('/').pop() || '';
    if (fileName) {
      return normalizeText(fileName).slice(0, 160);
    }
  } catch {
    // Fall through to the generic media label when the URL cannot be parsed.
  }

  return `${mediaKind} resource`;
}

function showToast(message: string): void {
  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = TOAST_ID;
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

function getAiMessageCandidates(adapter: PlatformAdapter): Element[] {
  const all = Array.from(document.body.querySelectorAll('*')).filter((element) =>
    adapter.isMessageElement(element)
  );
  return all.filter((element) => !all.some((other) => other !== element && other.contains(element)));
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function getUploadFileName(sourceUrl: string, mimeType?: string): string | undefined {
  try {
    if (/^data:/i.test(sourceUrl)) {
      const extFromMime = mimeType?.split('/')[1]?.split(';')[0];
      return extFromMime ? `media.${extFromMime}` : 'media.bin';
    }
    const url = new URL(sourceUrl);
    const pathname = url.pathname.split('/').pop();
    return pathname || undefined;
  } catch {
    return undefined;
  }
}

export class MediaHoverController {
  private readonly overlay: MediaSaveOverlay;

  private currentTarget: SaveableMediaElement | null = null;

  private pendingTarget: SaveableMediaElement | null = null;

  private showTimer: number | null = null;

  private hideTimer: number | null = null;

  private lastPointerX = 0;

  private lastPointerY = 0;

  private started = false;

  private readonly runtimeMessageListener = (
    message: { type?: string; srcUrl?: string; mediaType?: string },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ): boolean | void => {
    if (message.type !== 'captureMediaFromContextMenu') {
      return undefined;
    }

    void this.captureMediaFromContextMenu(message.srcUrl || '', message.mediaType).finally(() => {
      sendResponse({ status: 'ok' });
    });
    return true;
  };

  constructor(private readonly options: MediaHoverControllerOptions) {
    this.overlay = new MediaSaveOverlay(() => {
      void this.handleSaveCurrentTarget();
    });
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    document.addEventListener('mousemove', this.handleMouseMove, true);
    document.addEventListener('scroll', this.handleViewportChange, true);
    window.addEventListener('blur', this.handleViewportChange);
    window.addEventListener('resize', this.handleViewportChange);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    if (isRuntimeContextAvailable()) {
      chrome.runtime.onMessage.addListener(this.runtimeMessageListener);
    } else {
      Logger.debug('[MediaCapture] 扩展上下文已失效，跳过上下文菜单消息监听');
    }
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    document.removeEventListener('mousemove', this.handleMouseMove, true);
    document.removeEventListener('scroll', this.handleViewportChange, true);
    window.removeEventListener('blur', this.handleViewportChange);
    window.removeEventListener('resize', this.handleViewportChange);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    if (isRuntimeContextAvailable()) {
      chrome.runtime.onMessage.removeListener(this.runtimeMessageListener);
    }
    this.clearTimers();
    this.currentTarget = null;
    this.pendingTarget = null;
    this.overlay.hide();
    this.overlay.destroy();
  }

  refreshForUrlChange(): void {
    this.clearTimers();
    this.currentTarget = null;
    this.pendingTarget = null;
    this.overlay.hide();
  }

  private clearTimers(): void {
    if (this.showTimer) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private readonly handleMouseMove = (event: MouseEvent): void => {
    const settings = this.options.getSettings();
    if (!settings.webCapture.enabled || !settings.webCapture.mediaEnabled) {
      this.refreshForUrlChange();
      return;
    }

    this.lastPointerX = event.clientX + OVERLAY_OFFSET;
    this.lastPointerY = event.clientY + OVERLAY_OFFSET;

    if (this.overlay.isOverlayTarget(event.target)) {
      if (this.hideTimer) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
      return;
    }

    const target = getMediaElementFromNode(event.target);
    if (!target || !isSaveableMediaElement(target)) {
      this.scheduleHide();
      return;
    }

    if (this.currentTarget === target && this.overlay.isVisible()) {
      // Keep overlay stable for the current media target.
      // Following every mousemove makes it difficult to click the button.
      return;
    }

    this.pendingTarget = target;
    if (this.showTimer) {
      clearTimeout(this.showTimer);
    }
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.showTimer = window.setTimeout(() => {
      if (!this.pendingTarget || !isSaveableMediaElement(this.pendingTarget)) {
        return;
      }
      this.currentTarget = this.pendingTarget;
      this.overlay.showAt(this.lastPointerX, this.lastPointerY);
    }, HOVER_SHOW_DELAY_MS);
  };

  private scheduleHide(): void {
    if (this.showTimer) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
    }
    this.hideTimer = window.setTimeout(() => {
      this.currentTarget = null;
      this.pendingTarget = null;
      this.overlay.hide();
    }, HOVER_HIDE_DELAY_MS);
  }

  private readonly handleViewportChange = (): void => {
    this.refreshForUrlChange();
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.refreshForUrlChange();
    }
  };

  private findMediaTargetBySourceUrl(
    sourceUrl: string,
    mediaType?: string
  ): SaveableMediaElement | null {
    const normalizedSource = normalizeComparableUrl(sourceUrl);
    if (!normalizedSource) {
      return null;
    }

    const mediaKind = getMediaKindFromContextMenu(mediaType);
    const selectors = mediaKind === 'video' ? 'video' : mediaKind === 'audio' ? 'audio' : 'img';

    const scopedCandidates = Array.from(
      document.querySelectorAll<SaveableMediaElement>(selectors)
    ).filter((candidate) => isSaveableMediaElement(candidate));

    for (const candidate of scopedCandidates) {
      const metadata = extractMediaMetadata(candidate);
      if (!metadata?.media?.sourceUrl) {
        continue;
      }
      if (normalizeComparableUrl(metadata.media.sourceUrl) === normalizedSource) {
        return candidate;
      }
    }

    const allCandidates = Array.from(
      document.querySelectorAll<SaveableMediaElement>('img, video, audio')
    ).filter((candidate) => isSaveableMediaElement(candidate));

    for (const candidate of allCandidates) {
      const metadata = extractMediaMetadata(candidate);
      if (!metadata?.media?.sourceUrl) {
        continue;
      }
      if (normalizeComparableUrl(metadata.media.sourceUrl) === normalizedSource) {
        return candidate;
      }
    }

    return null;
  }

  private async saveFallbackMediaFromContextMenu(
    sourceUrl: string,
    mediaType?: string
  ): Promise<void> {
    const settings = this.options.getSettings();
    const mediaKind = getMediaKindFromContextMenu(mediaType);
    const normalizedSource = normalizeComparableUrl(sourceUrl);
    if (!normalizedSource) {
      return;
    }

    let media: SnippetMediaInput = {
      kind: mediaKind,
      sourceUrl: normalizedSource,
      previewUrl: normalizedSource,
      downloadStatus: 'pending' as const,
      savedFrom: 'url_pull' as const,
    };
    let upload: SaveMediaSnippetUpload | undefined;

    if (!settings.webCapture.mediaLocalCopyEnabled) {
      media = {
        ...media,
        downloadStatus: 'url_only',
        savedFrom: 'url_only',
      };
    } else if (/^(blob:|data:)/i.test(normalizedSource)) {
      try {
        upload = (await this.buildUploadPayload(normalizedSource)) || undefined;
        if (upload) {
          media = {
            ...media,
            downloadStatus: 'pending',
            savedFrom: 'browser_upload',
          };
        } else {
          media = {
            ...media,
            downloadStatus: 'url_only',
            savedFrom: 'url_only',
          };
        }
      } catch {
        media = {
          ...media,
          downloadStatus: 'url_only',
          savedFrom: 'url_only',
        };
      }
    }

    const contextText = normalizedSource.slice(0, 1000);
    const summaryText = createFallbackSummary(normalizedSource, mediaKind);
    const dedupeKey = buildDedupeKey([
      'media_save',
      cleanUrl(window.location.href),
      normalizedSource,
      'web_page',
    ]);

    const response = await chromeMessageAdapter.sendMessage({
      type: 'saveMediaSnippet',
      snippet: {
        dedupeKey,
        type: 'media_save',
        captureMethod: 'hover_media_save',
        selectionText: summaryText,
        contextText,
        selectors: [],
        url: cleanUrl(window.location.href),
        title: document.title || cleanUrl(window.location.href),
        sourceKind: 'web_page',
        media,
        semanticBlockKey: hashText(`${normalizedSource}:${cleanUrl(window.location.href)}`),
        headingPath: [],
        blockKind: 'media',
        rawContextText: contextText,
        rawContextMarkdown: contextText,
        summaryText,
      },
      upload,
    });

    const detail = (response?.group ? response : response?.data) as
      | { group?: SnippetGroup | null }
      | undefined;
    if (detail?.group) {
      this.options.onMediaSaved?.(detail.group);
    }
    showToast('My Attention 已记录');
  }

  private async captureMediaFromContextMenu(
    sourceUrl: string,
    mediaType?: string
  ): Promise<void> {
    const settings = this.options.getSettings();
    if (!settings.webCapture.enabled || !settings.webCapture.mediaEnabled) {
      return;
    }

    const normalizedSource = String(sourceUrl || '').trim();
    if (!normalizedSource) {
      return;
    }

    const target = this.findMediaTargetBySourceUrl(normalizedSource, mediaType);
    if (target) {
      const previous = this.currentTarget;
      this.currentTarget = target;
      await this.handleSaveCurrentTarget();
      this.currentTarget = previous || target;
      return;
    }

    await this.saveFallbackMediaFromContextMenu(normalizedSource, mediaType);
  }

  private resolveMediaContext(element: SaveableMediaElement): {
    sourceKind: 'web_page' | 'ai_conversation';
    platform?: PlatformName;
    conversationId?: string;
    messageIndex?: number;
    preferredRoot?: Element;
  } {
    const platform = this.options.getCurrentPlatform();
    const adapter = this.options.getActiveAdapter();
    if (platform && adapter) {
      let current: Node | null = element;
      while (current && current !== document.body) {
        if (current.nodeType === Node.ELEMENT_NODE && adapter.isMessageElement(current)) {
          const root = current as Element;
          const candidates = getAiMessageCandidates(adapter);
          return {
            sourceKind: 'ai_conversation',
            platform,
            conversationId: extractConversationId(adapter),
            messageIndex: candidates.findIndex((candidate) => candidate === root),
            preferredRoot: root,
          };
        }
        current = current.parentNode;
      }
    }

    const preferredRoot =
      element.closest('figure') ||
      element.closest('section') ||
      element.closest('article') ||
      element.closest('main') ||
      element.closest('[role="main"]') ||
      undefined;

    return {
      sourceKind: 'web_page',
      preferredRoot,
    };
  }

  private async buildUploadPayload(
    sourceUrl: string,
    mimeType?: string
  ): Promise<SaveMediaSnippetUpload | null> {
    if (!/^(blob:|data:)/i.test(sourceUrl)) {
      return null;
    }

    const response = await fetch(sourceUrl);
    const blob = await response.blob();
    if (blob.size > MEDIA_BROWSER_UPLOAD_MAX_BYTES) {
      return null;
    }

    const buffer = await blob.arrayBuffer();
    return {
      dataBase64: bufferToBase64(buffer),
      byteLength: blob.size,
      mimeType: blob.type || mimeType,
      fileName: getUploadFileName(sourceUrl, blob.type || mimeType),
    };
  }

  private async handleSaveCurrentTarget(): Promise<void> {
    const target = this.currentTarget;
    const settings = this.options.getSettings();
    if (!target || !settings.webCapture.enabled || !settings.webCapture.mediaEnabled) {
      return;
    }

    const metadata = extractMediaMetadata(target);
    if (!metadata) {
      showToast('My Attention 记录失败');
      return;
    }

    this.overlay.setBusy(true);

    try {
      const context = this.resolveMediaContext(target);
      let upload: SaveMediaSnippetUpload | undefined;
      let media = {
        ...metadata.media,
      };

      if (!settings.webCapture.mediaLocalCopyEnabled) {
        media = {
          ...media,
          downloadStatus: 'url_only',
          savedFrom: 'url_only',
        };
      } else if (/^(blob:|data:)/i.test(media.sourceUrl)) {
        try {
          upload = (await this.buildUploadPayload(media.sourceUrl, media.mimeType)) || undefined;
          if (upload) {
            media = {
              ...media,
              downloadStatus: 'pending',
              savedFrom: 'browser_upload',
              fileSizeBytes: upload.byteLength,
              mimeType: upload.mimeType || media.mimeType,
            };
          } else {
            media = {
              ...media,
              downloadStatus: 'url_only',
              savedFrom: 'url_only',
              downloadError: 'MEDIA_UPLOAD_TOO_LARGE',
            };
          }
        } catch (error) {
          media = {
            ...media,
            downloadStatus: 'url_only',
            savedFrom: 'url_only',
            downloadError: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const semanticContext = resolveSemanticElementContext({
        element: target,
        sourceKind: context.sourceKind,
        platform: context.platform,
        conversationId: context.conversationId,
        preferredRoot: context.preferredRoot,
        preferredBlockKind: 'media',
      });

      const summaryText = normalizeText(
        metadata.summaryText || media.altText || `${media.kind} resource`
      ).slice(0, 160);
      const contextText = normalizeText(
        metadata.contextText ||
          semanticContext?.rawContextText ||
          metadata.summaryText ||
          media.sourceUrl
      ).slice(0, 1000);
      const dedupeKey = buildDedupeKey([
        'media_save',
        cleanUrl(window.location.href),
        media.sourceUrl,
        context.sourceKind,
        context.platform,
        context.conversationId,
        context.messageIndex,
      ]);

      const input: SaveMediaSnippetInput = {
        snippet: {
          dedupeKey,
          type: 'media_save',
          captureMethod: 'hover_media_save',
          selectionText: summaryText,
          contextText,
          selectors: [],
          url: cleanUrl(window.location.href),
          title: document.title || cleanUrl(window.location.href),
          sourceKind: context.sourceKind,
          platform: context.platform,
          conversationId: context.conversationId,
          messageIndex: context.messageIndex,
          media,
          semanticBlockKey:
            semanticContext?.semanticBlockKey || hashText(`${media.sourceUrl}:${contextText}`),
          headingPath: semanticContext?.headingPath || [],
          blockKind: 'media',
          rawContextText: semanticContext?.rawContextText || contextText,
          rawContextMarkdown: semanticContext?.rawContextMarkdown || contextText,
          summaryText,
        },
        upload,
      };

      const response = await chromeMessageAdapter.sendMessage({
        type: 'saveMediaSnippet',
        snippet: input.snippet,
        upload: input.upload,
      });
      const detail = (response?.group ? response : response?.data) as
        | { group?: SnippetGroup | null }
        | undefined;
      if (detail?.group) {
        this.options.onMediaSaved?.(detail.group);
      }
      showToast('My Attention 已记录');
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        Logger.debug('[MediaHover] 保存媒体跳过：扩展上下文已失效');
        return;
      }
      Logger.error('[MediaHover] 保存媒体失败:', error);
      showToast('My Attention 记录失败');
    } finally {
      this.overlay.setBusy(false);
    }
  }
}

export function createMediaHoverController(
  options: MediaHoverControllerOptions
): MediaHoverController {
  return new MediaHoverController(options);
}
