import type { ChromeMessageRequest, ChromeMessageResponse } from '@/types';

export interface TranslationFrameInfo {
  frameId: number;
  url?: string;
  parentFrameId?: number;
  documentId?: string;
}

export interface PageTranslationFrameRequest {
  sourceLanguage: string;
  targetLanguage: string;
  mode: string;
  range: string;
}

export interface TranslationIframeRuntimeDependencies {
  getAllFrames(tabId: number): Promise<TranslationFrameInfo[]>;
  sendMessageToFrame(
    tabId: number,
    frameId: number,
    message: ChromeMessageRequest
  ): Promise<ChromeMessageResponse<{ translatedCount?: number }>>;
  ensureFrameContentScript(tabId: number, frameId: number): Promise<void>;
  now(): number;
}

export interface TranslationBroadcastResult {
  frameCount: number;
  failedFrameCount: number;
  translatedCount: number;
  errorMessage?: string;
}

interface ActiveTranslationState {
  request: PageTranslationFrameRequest;
  translatedFrameIds: Set<number>;
  updatedAt: number;
}

function buildFrameTranslationMessage(
  request: PageTranslationFrameRequest
): ChromeMessageRequest {
  return {
    type: 'translation:translateCurrentPage',
    ...request,
  };
}

function extractTranslatedCount(
  response: ChromeMessageResponse<{ translatedCount?: number }>
): number {
  const count = response.translatedCount ?? response.data?.translatedCount;
  return typeof count === 'number' ? count : 0;
}

export class TranslationIframeRuntime {
  private readonly activeTranslations = new Map<number, ActiveTranslationState>();

  constructor(private readonly deps: TranslationIframeRuntimeDependencies) {}

  hasActiveTranslation(tabId: number): boolean {
    return this.activeTranslations.has(tabId);
  }

  clearTabState(tabId: number): void {
    this.activeTranslations.delete(tabId);
  }

  clearFrameState(tabId: number, frameId: number): void {
    this.activeTranslations.get(tabId)?.translatedFrameIds.delete(frameId);
  }

  async translateTabFrames(
    tabId: number,
    request: PageTranslationFrameRequest
  ): Promise<TranslationBroadcastResult> {
    const state: ActiveTranslationState = {
      request,
      translatedFrameIds: new Set<number>(),
      updatedAt: this.deps.now(),
    };
    this.activeTranslations.set(tabId, state);

    const frames = await this.deps.getAllFrames(tabId);
    return await this.sendTranslationToFrames(tabId, frames, state);
  }

  async clearTabTranslations(
    tabId: number
  ): Promise<{ clearedFrameCount: number; failedFrameCount: number }> {
    const frames = await this.deps.getAllFrames(tabId);
    let clearedFrameCount = 0;
    let failedFrameCount = 0;

    await Promise.all(
      frames.map(async (frame) => {
        try {
          await this.deps.sendMessageToFrame(tabId, frame.frameId, {
            type: 'translation:clearPageTranslations',
          });
          clearedFrameCount += 1;
        } catch {
          failedFrameCount += 1;
        }
      })
    );

    this.clearTabState(tabId);
    return { clearedFrameCount, failedFrameCount };
  }

  async handleFrameCompleted(details: {
    tabId: number;
    frameId: number;
  }): Promise<{ injected: boolean; translatedCount: number } | null> {
    if (details.frameId === 0) {
      return null;
    }

    const state = this.activeTranslations.get(details.tabId);
    if (!state) {
      return null;
    }

    await this.deps.ensureFrameContentScript(details.tabId, details.frameId);
    const response = await this.deps.sendMessageToFrame(
      details.tabId,
      details.frameId,
      buildFrameTranslationMessage(state.request)
    );
    state.translatedFrameIds.add(details.frameId);

    return {
      injected: true,
      translatedCount: extractTranslatedCount(response),
    };
  }

  private async sendTranslationToFrames(
    tabId: number,
    frames: TranslationFrameInfo[],
    state: ActiveTranslationState
  ): Promise<TranslationBroadcastResult> {
    let translatedCount = 0;
    let failedFrameCount = 0;
    let errorMessage: string | undefined;

    await Promise.all(
      frames.map(async (frame) => {
        try {
          await this.deps.ensureFrameContentScript(tabId, frame.frameId);
          const response = await this.deps.sendMessageToFrame(
            tabId,
            frame.frameId,
            buildFrameTranslationMessage(state.request)
          );
          if (response.status === 'error') {
            if (!errorMessage) {
              errorMessage = response.error || '翻译失败';
            }
            return;
          }
          state.translatedFrameIds.add(frame.frameId);
          translatedCount += extractTranslatedCount(response);
        } catch {
          failedFrameCount += 1;
        }
      })
    );

    state.updatedAt = this.deps.now();

    return {
      frameCount: frames.length,
      failedFrameCount,
      translatedCount,
      ...(errorMessage ? { errorMessage } : {}),
    };
  }
}
