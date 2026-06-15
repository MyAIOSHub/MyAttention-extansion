import { PcmChunker, AST_PCM_CHUNK_BYTES, downsampleFloat32, floatTo16BitPcm } from './pcm-audio';
import { resolveAstLanguagePair } from './ast-language';
import { VolcengineAstSession, type AstWebSocketLike } from './volcengine-ast-session';
import { VOLCENGINE_AST_EVENTS } from '@/translation/volcengine-ast-protobuf';
import { normalizeSimulcastPlaybackDelayMs } from './simulcast-delay';

interface SimulcastOffscreenStartMessage {
  type: 'simulcast:offscreenStart';
  session: {
    tabId: number;
    streamId: string;
    sourceLanguage: string;
    targetLanguage: string;
    model: string;
    audioOutputMode: string;
    originalVolume: number;
    translatedVolume: number;
    translatedAudioDelayMs?: number;
    subtitleDisplayMode: string;
    voiceCloneEnabled: boolean;
    ast: {
      url: string;
      headers: Record<string, string>;
    };
  };
}

interface SimulcastOffscreenStopMessage {
  type: 'simulcast:offscreenStop';
  tabId?: number;
}

type SimulcastOffscreenMessage =
  | SimulcastOffscreenStartMessage
  | SimulcastOffscreenStopMessage;

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

let activeStream: MediaStream | null = null;
let activeAudioContext: AudioContext | null = null;
let activeSource: MediaStreamAudioSourceNode | null = null;
let activeOriginalGain: GainNode | null = null;
let activeProcessor: ScriptProcessorNode | null = null;
let activeAstSession: VolcengineAstSession | null = null;
let ttsChunks: Uint8Array[] = [];
let activeTranslatedAudio: HTMLAudioElement | null = null;
let activeTranslatedAudioTimers: number[] = [];

function clearTranslatedAudioTimers(): void {
  activeTranslatedAudioTimers.forEach((timerId) => window.clearTimeout(timerId));
  activeTranslatedAudioTimers = [];
}

function stopActiveCapture(): void {
  clearTranslatedAudioTimers();
  activeProcessor?.disconnect();
  activeProcessor = null;

  activeAstSession?.finish();
  activeAstSession?.close();
  activeAstSession = null;

  activeSource?.disconnect();
  activeSource = null;

  activeOriginalGain?.disconnect();
  activeOriginalGain = null;

  activeStream?.getTracks().forEach((track) => track.stop());
  activeStream = null;

  void activeAudioContext?.close().catch(() => undefined);
  activeAudioContext = null;

  activeTranslatedAudio?.pause();
  activeTranslatedAudio = null;
  ttsChunks = [];
}

function createTabAudioConstraints(streamId: string): MediaStreamConstraints {
  return {
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    } as unknown as MediaTrackConstraints,
    video: false,
  };
}

function clampVolume(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

function getOriginalPlaybackVolume(session: SimulcastOffscreenStartMessage['session']): number {
  if (session.audioOutputMode === 'translatedOnly') {
    return 0;
  }
  return clampVolume(session.originalVolume, 0.25);
}

function getTranslatedPlaybackVolume(session: SimulcastOffscreenStartMessage['session']): number {
  if (session.audioOutputMode === 'subtitlesOnly') {
    return 0;
  }
  return clampVolume(session.translatedVolume, 1);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.length;
  });
  return output;
}

function playTranslatedAudio(
  chunks: Uint8Array[],
  volume: number,
  delayMs: number,
  onPlaybackStatus?: (status: { kind: 'success' | 'error' | 'info'; message: string }) => void
): void {
  if (!chunks.length || volume <= 0) {
    return;
  }

  const normalizedDelayMs = normalizeSimulcastPlaybackDelayMs(delayMs);
  const startPlayback = (): void => {
    const audioBytes = concatChunks(chunks);
    const audioBuffer = new ArrayBuffer(audioBytes.byteLength);
    new Uint8Array(audioBuffer).set(audioBytes);
    const blob = new Blob([audioBuffer], { type: 'audio/ogg; codecs=opus' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = clampVolume(volume, 1);
    audio.onended = (): void => {
      URL.revokeObjectURL(url);
      if (activeTranslatedAudio === audio) {
        activeTranslatedAudio = null;
      }
    };
    activeTranslatedAudio = audio;
    void audio
      .play()
      .then(() => {
        onPlaybackStatus?.({
          kind: 'success',
          message: '同声传译运行中：正在播放译音。',
        });
      })
      .catch((error) => {
        URL.revokeObjectURL(url);
        onPlaybackStatus?.({
          kind: 'error',
          message: `译音已返回，但浏览器播放失败：${error instanceof Error ? error.message : String(error)}`,
        });
      });
  };

  if (normalizedDelayMs > 0) {
    onPlaybackStatus?.({
      kind: 'info',
      message: `译音已返回，将在 ${normalizedDelayMs}ms 后播放。`,
    });
    const timerId = window.setTimeout(() => {
      activeTranslatedAudioTimers = activeTranslatedAudioTimers.filter((id) => id !== timerId);
      startPlayback();
    }, normalizedDelayMs);
    activeTranslatedAudioTimers.push(timerId);
    return;
  }

  startPlayback();
}

function createAstSession(message: SimulcastOffscreenStartMessage): VolcengineAstSession {
  const sessionId = crypto.randomUUID();
  const languagePair = resolveAstLanguagePair(
    message.session.sourceLanguage,
    message.session.targetLanguage
  );
  return new VolcengineAstSession(
    {
      url: message.session.ast.url,
      sessionId,
      sourceLanguage: languagePair.sourceLanguage,
      targetLanguage: languagePair.targetLanguage,
      mode: message.session.audioOutputMode === 'subtitlesOnly' ? 's2t' : 's2s',
      voiceCloneEnabled: message.session.voiceCloneEnabled,
    },
    {
      createWebSocket: (url): AstWebSocketLike => new WebSocket(url) as unknown as AstWebSocketLike,
      onSubtitle: (update): void => {
        chrome.runtime.sendMessage({
          type: 'simulcast:update',
          target: 'background',
          tabId: message.session.tabId,
          subtitle: update,
        });
      },
      onAudioChunk: (chunk): void => {
        ttsChunks.push(chunk);
      },
      onError: (error): void => {
        // 单帧解析/处理错误：记录但不终止会话
        console.warn('[simulcast] AST 帧处理错误', error);
      },
      onEvent: (response): void => {
        if (response.event === VOLCENGINE_AST_EVENTS.TTSSentenceStart) {
          ttsChunks = [];
        }
        if (response.event === VOLCENGINE_AST_EVENTS.TTSSentenceEnd) {
          playTranslatedAudio(
            ttsChunks,
            getTranslatedPlaybackVolume(message.session),
            normalizeSimulcastPlaybackDelayMs(message.session.translatedAudioDelayMs),
            (status) => {
              chrome.runtime.sendMessage({
                type: 'simulcast:update',
                target: 'background',
                tabId: message.session.tabId,
                status,
              });
            }
          );
          ttsChunks = [];
        }
      },
    }
  );
}

function connectAudioToAst(
  audioContext: AudioContext,
  source: MediaStreamAudioSourceNode,
  astSession: VolcengineAstSession
): ScriptProcessorNode {
  const pcmChunker = new PcmChunker(AST_PCM_CHUNK_BYTES, (chunk) => {
    astSession.sendAudioChunk(chunk);
  });
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event): void => {
    const channel = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleFloat32(channel, audioContext.sampleRate, 16000);
    pcmChunker.push(floatTo16BitPcm(downsampled));
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
  return processor;
}

function connectOriginalPlayback(
  audioContext: AudioContext,
  source: MediaStreamAudioSourceNode,
  session: SimulcastOffscreenStartMessage['session']
): GainNode {
  const gain = audioContext.createGain();
  gain.gain.value = getOriginalPlaybackVolume(session);
  source.connect(gain);
  gain.connect(audioContext.destination);
  return gain;
}

function cleanupFailedCapture(resources: {
  stream?: MediaStream;
  audioContext?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  originalGain?: GainNode;
  processor?: ScriptProcessorNode;
  astSession?: VolcengineAstSession;
}): void {
  resources.processor?.disconnect();
  resources.originalGain?.disconnect();
  resources.source?.disconnect();
  resources.astSession?.finish();
  resources.astSession?.close();
  resources.stream?.getTracks().forEach((track) => track.stop());
  void resources.audioContext?.close().catch(() => undefined);
}

async function startCapture(message: SimulcastOffscreenStartMessage): Promise<{
  status: 'ok';
  captured: boolean;
}> {
  stopActiveCapture();

  let stream: MediaStream | undefined;
  let audioContext: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let originalGain: GainNode | undefined;
  let processor: ScriptProcessorNode | undefined;
  let astSession: VolcengineAstSession | undefined;

  try {
    stream = await navigator.mediaDevices.getUserMedia(
      createTabAudioConstraints(message.session.streamId)
    );
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();
    source = audioContext.createMediaStreamSource(stream);
    astSession = createAstSession(message);

    originalGain = connectOriginalPlayback(audioContext, source, message.session);
    await astSession.start();
    await astSession.waitUntilStarted();
    processor = connectAudioToAst(audioContext, source, astSession);
  } catch (error) {
    cleanupFailedCapture({
      stream,
      audioContext,
      source,
      originalGain,
      processor,
      astSession,
    });
    throw error;
  }

  if (!stream || !audioContext || !source || !originalGain || !processor || !astSession) {
    throw new Error('同声传译音频链路初始化失败');
  }

  activeStream = stream;
  activeAudioContext = audioContext;
  activeSource = source;
  activeOriginalGain = originalGain;
  activeProcessor = processor;
  activeAstSession = astSession;

  return {
    status: 'ok',
    captured: true,
  };
}

chrome.runtime.onMessage.addListener((message: SimulcastOffscreenMessage, sender, sendResponse) => {
  if (message.type === 'simulcast:offscreenStop') {
    stopActiveCapture();
    sendResponse({ status: 'ok', stopped: true });
    return true;
  }

  if (message.type !== 'simulcast:offscreenStart') {
    return undefined;
  }

  void startCapture(message)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

export {};
