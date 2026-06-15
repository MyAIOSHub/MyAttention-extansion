import type {
  AudioOutputMode,
  SimultaneousInterpretationConfig,
  SubtitleDisplayMode,
} from '@/translation/config';
import {
  VOLCENGINE_AST_WS_URL,
  buildVolcengineAstHeaders,
} from '@/translation/volcengine-ast';

export const SIMULCAST_OFFSCREEN_DOCUMENT_PATH = 'html/simulcast_offscreen.html';

export interface StartSimulcastRequest {
  tabId: number;
  streamId?: string;
  sourceLanguage: string;
  targetLanguage: string;
  model: string;
  audioOutputMode: AudioOutputMode;
  originalVolume: number;
  translatedVolume: number;
  translatedAudioDelayMs: number;
  subtitleDisplayMode: SubtitleDisplayMode;
  voiceCloneEnabled: boolean;
  credentials: SimultaneousInterpretationConfig['credentials'];
}

export interface SimulcastRuntimeStatus {
  state: 'stopped' | 'capturing';
  tabId?: number;
  startedAt?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
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
    await this.dependencies.installAstAuthRule(headers);

    try {
      await this.ensureOffscreenDocument();
      const streamId = request.streamId || (await this.dependencies.getTabMediaStreamId(request.tabId));

      await this.sendOffscreenStartMessage({
        type: 'simulcast:offscreenStart',
        session: {
          tabId: request.tabId,
          streamId,
          sourceLanguage: request.sourceLanguage,
          targetLanguage: request.targetLanguage,
          model: request.model,
          audioOutputMode: request.audioOutputMode,
          originalVolume: request.originalVolume,
          translatedVolume: request.translatedVolume,
          translatedAudioDelayMs: request.translatedAudioDelayMs,
          subtitleDisplayMode: request.subtitleDisplayMode,
          voiceCloneEnabled: request.voiceCloneEnabled,
          ast: {
            url: VOLCENGINE_AST_WS_URL,
            headers,
          },
        },
      });
    } catch (error) {
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

    await this.dependencies.removeAstAuthRule();
    this.status = { state: 'stopped' };
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
