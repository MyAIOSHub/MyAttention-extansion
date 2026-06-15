import {
  VOLCENGINE_AST_EVENTS,
  buildAstFinishSessionFrame,
  buildAstStartSessionFrame,
  buildAstTaskRequestFrame,
  decodeAstResponseFrame,
  type AstResponseFrame,
} from '@/translation/volcengine-ast-protobuf';

export interface VolcengineAstSessionConfig {
  url: string;
  sessionId: string;
  sourceLanguage: string;
  targetLanguage: string;
  mode: 's2s' | 's2t';
  voiceCloneEnabled: boolean;
  speakerId?: string;
}

export interface AstSubtitleUpdate {
  event: number;
  text: string;
  startTime: number;
  endTime: number;
  spkChg: boolean;
  mutedDurationMs: number;
  speakerId: string;
}

export interface AstWebSocketLike {
  binaryType: BinaryType;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: ArrayBuffer | Blob }) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: (() => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

export interface VolcengineAstSessionDependencies {
  createWebSocket: (url: string) => AstWebSocketLike;
  onSubtitle?: (update: AstSubtitleUpdate) => void;
  onAudioChunk?: (chunk: Uint8Array) => void;
  onEvent?: (response: AstResponseFrame) => void;
}

const WEBSOCKET_OPEN_STATE = 1;

function isSubtitleEvent(event: number): boolean {
  return (
    event === VOLCENGINE_AST_EVENTS.SourceSubtitleStart ||
    event === VOLCENGINE_AST_EVENTS.SourceSubtitleResponse ||
    event === VOLCENGINE_AST_EVENTS.SourceSubtitleEnd ||
    event === VOLCENGINE_AST_EVENTS.TranslationSubtitleStart ||
    event === VOLCENGINE_AST_EVENTS.TranslationSubtitleResponse ||
    event === VOLCENGINE_AST_EVENTS.TranslationSubtitleEnd
  );
}

async function normalizeMessageData(data: ArrayBuffer | Blob): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(await data.arrayBuffer());
}

export class VolcengineAstSession {
  private socket: AstWebSocketLike | null = null;
  private sequence = 0;
  private started = false;
  private startReject: ((error: Error) => void) | null = null;
  private startResolve: (() => void) | null = null;
  private readonly startedPromise: Promise<void>;

  constructor(
    private readonly config: VolcengineAstSessionConfig,
    private readonly dependencies: VolcengineAstSessionDependencies
  ) {
    this.startedPromise = new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
  }

  async start(): Promise<void> {
    if (this.socket) {
      return;
    }

    const socket = this.dependencies.createWebSocket(this.config.url);
    socket.binaryType = 'arraybuffer';
    socket.onopen = (): void => {
      socket.send(
        buildAstStartSessionFrame({
          sessionId: this.config.sessionId,
          mode: this.config.mode,
          sourceLanguage: this.config.sourceLanguage,
          targetLanguage: this.config.targetLanguage,
          speakerId: this.config.voiceCloneEnabled ? undefined : this.config.speakerId,
          sourceAudio: {
            format: 'wav',
            rate: 16000,
            bits: 16,
            channel: 1,
          },
          targetAudio: {
            format: 'ogg_opus',
            rate: 48000,
          },
          user: {
            uid: 'my-attention-extension',
            did: 'browser-extension',
            platform: 'Chrome Extension',
          },
        })
      );
    };
    socket.onmessage = (event): void => {
      void this.handleMessage(event.data).catch((error) => {
        this.startReject?.(error instanceof Error ? error : new Error(String(error)));
      });
    };
    socket.onerror = (): void => {
      this.startReject?.(new Error('火山 AST WebSocket 连接失败'));
    };
    socket.onclose = (): void => {
      if (!this.started) {
        this.startReject?.(new Error('火山 AST WebSocket 在会话启动前关闭'));
      }
    };
    this.socket = socket;
  }

  waitUntilStarted(): Promise<void> {
    return this.startedPromise;
  }

  sendAudioChunk(chunk: Uint8Array): void {
    if (!this.started || !this.socket || this.socket.readyState !== WEBSOCKET_OPEN_STATE) {
      return;
    }

    this.sequence += 1;
    this.socket.send(buildAstTaskRequestFrame(this.config.sessionId, chunk, this.sequence));
  }

  finish(): void {
    if (!this.socket || this.socket.readyState !== WEBSOCKET_OPEN_STATE) {
      return;
    }

    this.socket.send(buildAstFinishSessionFrame(this.config.sessionId));
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.started = false;
  }

  private async handleMessage(data: ArrayBuffer | Blob): Promise<void> {
    const response = decodeAstResponseFrame(await normalizeMessageData(data));
    this.dependencies.onEvent?.(response);

    if (response.event === VOLCENGINE_AST_EVENTS.SessionStarted) {
      this.started = true;
      this.startResolve?.();
      return;
    }

    if (
      response.event === VOLCENGINE_AST_EVENTS.SessionFailed ||
      response.event === VOLCENGINE_AST_EVENTS.SessionCanceled
    ) {
      this.startReject?.(new Error(response.message || '火山 AST 会话失败'));
      return;
    }

    if (isSubtitleEvent(response.event) && response.text) {
      this.dependencies.onSubtitle?.({
        event: response.event,
        text: response.text,
        startTime: response.startTime,
        endTime: response.endTime,
        spkChg: response.spkChg,
        mutedDurationMs: response.mutedDurationMs,
        speakerId: response.speakerId,
      });
    }

    if (response.event === VOLCENGINE_AST_EVENTS.TTSResponse && response.data.length > 0) {
      this.dependencies.onAudioChunk?.(response.data);
    }
  }
}
