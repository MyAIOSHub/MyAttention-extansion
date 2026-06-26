import type {
  AudioOutputMode,
  SimultaneousInterpretationConfig,
  SubtitleDisplayMode,
} from '@/translation/config';
import {
  VOLCENGINE_AST_WS_URL,
  buildVolcengineAstHeaders,
} from '@/translation/volcengine-ast';
import {
  normalizeSimulcastVideoSyncMode,
  type SimulcastVideoSyncMode,
} from '@/simulcast/video-sync-mode';

export const SIMULCAST_OFFSCREEN_DOCUMENT_PATH = 'html/simulcast_offscreen.html';
export const SIMULCAST_STRICT_PLAYER_PATH = 'html/simulcast_player.html';

export interface StartSimulcastRequest {
  tabId: number;
  streamId?: string;
  /** 音频来源：tab=标签页音频（默认） / mic=麦克风 / file=文件 / url=直链 */
  audioSource?: 'tab' | 'mic' | 'file' | 'url';
  /** 文件转写：媒体字节 base64 */
  fileData?: string;
  /** 链接转写：直链音视频 URL */
  mediaUrl?: string;
  /** 文件/链接 MIME */
  mediaMime?: string;
  /** 是否录制捕获音频用于转写回放（默认 false；同传不用） */
  recordAudio?: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  model: string;
  audioOutputMode: AudioOutputMode;
  originalVolume: number;
  translatedVolume: number;
  translatedAudioDelayMs: number;
  translatedMaxPlaybackRate?: number;
  videoSyncMode?: SimulcastVideoSyncMode;
  subtitleDisplayMode: SubtitleDisplayMode;
  voiceCloneEnabled: boolean;
  credentials: SimultaneousInterpretationConfig['credentials'];
}

export interface UpdateSimulcastPlaybackRequest {
  tabId: number;
  originalVolume: number;
  translatedVolume: number;
  translatedAudioDelayMs: number;
  translatedMaxPlaybackRate?: number;
}

export interface UpdateStrictPlayerDelayRequest {
  tabId: number;
  targetDelaySec: number;
}

export interface SimulcastRuntimeStatus {
  state: 'stopped' | 'capturing';
  tabId?: number;
  startedAt?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  videoSyncMode?: SimulcastVideoSyncMode;
  strictPlayerSessionId?: string;
  strictPlayerWindowId?: number;
}

export interface SimulcastRuntimeDependencies {
  hasOffscreenDocument: () => Promise<boolean>;
  createOffscreenDocument: (parameters: {
    url: string;
    reasons: string[];
    justification: string;
  }) => Promise<void>;
  closeOffscreenDocument: () => Promise<void>;
  getTabMediaStreamId: (tabId: number) => Promise<string>;
  sendRuntimeMessage: (message: Record<string, unknown>) => Promise<unknown>;
  installAstAuthRule: (headers: Record<string, string>) => Promise<void>;
  removeAstAuthRule: () => Promise<void>;
  openStrictPlayerWindow?: (parameters: {
    sessionId: string;
    targetDelaySec: number;
  }) => Promise<number | undefined>;
  closeStrictPlayerWindow?: (windowId: number) => Promise<void>;
  now: () => string;
  wait: (delayMs: number) => Promise<void>;
}

export class SimulcastRuntime {
  private status: SimulcastRuntimeStatus = { state: 'stopped' };

  constructor(private readonly dependencies: SimulcastRuntimeDependencies) {}

  getStatus(): SimulcastRuntimeStatus {
    return { ...this.status };
  }

  async start(request: StartSimulcastRequest): Promise<SimulcastRuntimeStatus> {
    const headers = buildVolcengineAstHeaders(request.credentials);
    const videoSyncMode = normalizeSimulcastVideoSyncMode(request.videoSyncMode);
    const strictPlayerSessionId =
      videoSyncMode === 'strict-delayed-player' ? createRuntimeId() : undefined;
    let strictPlayerWindowId: number | undefined;
    await this.dependencies.installAstAuthRule(headers);

    try {
      if (strictPlayerSessionId && this.dependencies.openStrictPlayerWindow) {
        strictPlayerWindowId = await this.dependencies.openStrictPlayerWindow({
          sessionId: strictPlayerSessionId,
          targetDelaySec: 1,
        });
      }

      await this.ensureOffscreenDocument();
      // 麦克风/文件/链接来源无需 tab 媒体流 ID
      const needsTabStream = (request.audioSource ?? 'tab') === 'tab';
      const streamId = needsTabStream
        ? request.streamId || (await this.dependencies.getTabMediaStreamId(request.tabId))
        : '';

      await this.sendOffscreenStartMessage({
        type: 'simulcast:offscreenStart',
        session: {
          tabId: request.tabId,
          streamId,
          audioSource: request.audioSource ?? 'tab',
          fileData: request.fileData,
          mediaUrl: request.mediaUrl,
          mediaMime: request.mediaMime,
          recordAudio: request.recordAudio ?? false,
          sourceLanguage: request.sourceLanguage,
          targetLanguage: request.targetLanguage,
          model: request.model,
          audioOutputMode: request.audioOutputMode,
          originalVolume: request.originalVolume,
          translatedVolume: request.translatedVolume,
          translatedAudioDelayMs: request.translatedAudioDelayMs,
          translatedMaxPlaybackRate: request.translatedMaxPlaybackRate,
          videoSyncMode,
          strictPlayerSessionId,
          strictPlayerTargetDelaySec: strictPlayerSessionId ? 1 : undefined,
          subtitleDisplayMode: request.subtitleDisplayMode,
          voiceCloneEnabled: request.voiceCloneEnabled,
          ast: {
            url: VOLCENGINE_AST_WS_URL,
            headers,
          },
        },
      });
    } catch (error) {
      if (
        typeof strictPlayerWindowId === 'number' &&
        this.dependencies.closeStrictPlayerWindow
      ) {
        await this.dependencies.closeStrictPlayerWindow(strictPlayerWindowId).catch(
          () => undefined
        );
      }
      await this.dependencies.removeAstAuthRule();
      this.status = { state: 'stopped' };
      throw error;
    }

    this.status = {
      state: 'capturing',
      tabId: request.tabId,
      startedAt: this.dependencies.now(),
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      videoSyncMode,
      strictPlayerSessionId,
      strictPlayerWindowId,
    };

    return this.getStatus();
  }

  async stop(): Promise<SimulcastRuntimeStatus> {
    if (this.status.state === 'capturing' && typeof this.status.tabId === 'number') {
      await this.dependencies.sendRuntimeMessage({
        type: 'simulcast:offscreenStop',
        tabId: this.status.tabId,
      });
      await this.dependencies.closeOffscreenDocument();
    }

    if (
      typeof this.status.strictPlayerWindowId === 'number' &&
      this.dependencies.closeStrictPlayerWindow
    ) {
      await this.dependencies.closeStrictPlayerWindow(this.status.strictPlayerWindowId).catch(
        () => undefined
      );
    }

    await this.dependencies.removeAstAuthRule();
    this.status = { state: 'stopped' };
    return this.getStatus();
  }

  async updateStrictPlayerDelay(
    request: UpdateStrictPlayerDelayRequest
  ): Promise<SimulcastRuntimeStatus> {
    if (
      this.status.state !== 'capturing' ||
      typeof this.status.tabId !== 'number' ||
      this.status.tabId !== request.tabId ||
      this.status.videoSyncMode !== 'strict-delayed-player'
    ) {
      return this.getStatus();
    }

    await this.dependencies.sendRuntimeMessage({
      type: 'simulcast:offscreenStrictPlayerDelay',
      tabId: request.tabId,
      targetDelaySec: request.targetDelaySec,
    });
    return this.getStatus();
  }

  async updatePlaybackSettings(
    request: UpdateSimulcastPlaybackRequest
  ): Promise<SimulcastRuntimeStatus> {
    if (
      this.status.state !== 'capturing' ||
      typeof this.status.tabId !== 'number' ||
      this.status.tabId !== request.tabId
    ) {
      return this.getStatus();
    }

    await this.dependencies.sendRuntimeMessage({
      type: 'simulcast:offscreenUpdatePlayback',
      tabId: request.tabId,
      originalVolume: request.originalVolume,
      translatedVolume: request.translatedVolume,
      translatedAudioDelayMs: request.translatedAudioDelayMs,
      translatedMaxPlaybackRate: request.translatedMaxPlaybackRate,
    });
    return this.getStatus();
  }

  private async ensureOffscreenDocument(): Promise<void> {
    const hasDocument = await this.dependencies.hasOffscreenDocument();
    if (hasDocument) {
      return;
    }

    await this.dependencies.createOffscreenDocument({
      url: SIMULCAST_OFFSCREEN_DOCUMENT_PATH,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capture tab audio for simultaneous interpretation and translated audio playback.',
    });
  }

  private async sendOffscreenStartMessage(message: Record<string, unknown>): Promise<void> {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.dependencies.sendRuntimeMessage(message);
        return;
      } catch (error) {
        if (attempt === maxAttempts || !isOffscreenReceiverNotReady(error)) {
          throw error;
        }
        await this.dependencies.wait(100);
      }
    }
  }
}

function createRuntimeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isOffscreenReceiverNotReady(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const normalized = message.toLowerCase();
  return (
    normalized.includes('could not establish connection') ||
    normalized.includes('receiving end does not exist')
  );
}
