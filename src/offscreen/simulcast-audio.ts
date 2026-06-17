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
    audioSource?: 'tab' | 'mic' | 'file' | 'url';
    /** 文件转写：媒体字节 base64 */
    fileData?: string;
    /** 链接转写：直链音视频 URL */
    mediaUrl?: string;
    /** 文件/链接的 MIME */
    mediaMime?: string;
    recordAudio?: boolean;
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

interface SimulcastOffscreenUpdatePlaybackMessage {
  type: 'simulcast:offscreenUpdatePlayback';
  tabId?: number;
  originalVolume?: number;
  translatedVolume?: number;
  translatedAudioDelayMs?: number;
}

interface SimulcastTranslatedAudioPlaybackEvent {
  event: 'playback-started' | 'playback-ended';
  segmentId: number;
  wallTimeMs: number;
  delayMs: number;
}

type SimulcastOffscreenMessage =
  | SimulcastOffscreenStartMessage
  | SimulcastOffscreenStopMessage
  | SimulcastOffscreenUpdatePlaybackMessage;

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

let activeStream: MediaStream | null = null;
let activeAudioContext: AudioContext | null = null;
let activeSource: AudioNode | null = null;
let activeOriginalGain: GainNode | null = null;
let activeProcessor: ScriptProcessorNode | null = null;
let activeAstSession: VolcengineAstSession | null = null;
let activeSession: SimulcastOffscreenStartMessage['session'] | null = null;
let ttsChunks: Uint8Array[] = [];
let nextTtsSegmentId = 1;
let activeTtsSegmentId = 0;
let activeTranslatedAudio: HTMLAudioElement | null = null;
const activeTranslatedAudioUrls = new Map<HTMLAudioElement, string>();
let activeTranslatedAudioTimers: number[] = [];
// 转写录音（仅 recordAudio 会话）
let activeRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let recordTabId: number | null = null;
// 文件/链接转写的媒体元素
let activeMediaEl: HTMLAudioElement | null = null;
let activeMediaObjectUrl: string | null = null;

/** 从文件字节(base64)或直链 URL 构建可读样本的音频元素（同源 blob，不污染 Web Audio）。 */
async function buildMediaSourceElement(
  session: SimulcastOffscreenStartMessage['session']
): Promise<HTMLAudioElement> {
  let blob: Blob;
  if (session.audioSource === 'file' && session.fileData) {
    const bytes = Uint8Array.from(atob(session.fileData), (c) => c.charCodeAt(0));
    blob = new Blob([bytes], { type: session.mediaMime || 'audio/*' });
  } else if (session.audioSource === 'url' && session.mediaUrl) {
    const resp = await fetch(session.mediaUrl); // host_permissions 绕过 CORS
    if (!resp.ok) {
      throw new Error(`拉取链接失败 (${resp.status})`);
    }
    blob = await resp.blob();
  } else {
    throw new Error('缺少文件或链接');
  }
  activeMediaObjectUrl = URL.createObjectURL(blob);
  const el = new Audio();
  el.src = activeMediaObjectUrl;
  // 不可 muted：被 createMediaElementSource 接管后，muted/volume=0 会让节点只输出静音，
  // AST 收到静音 → 无字幕。靠图路由保证不外放（source 仅接 AST 的 ScriptProcessor，
  // 该节点不写 output → 到 destination 为静音），故无需静音元素。
  el.preload = 'auto';
  return el;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = (): void => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : '');
    };
    reader.onerror = (): void => reject(reader.error ?? new Error('读取录音失败'));
    reader.readAsDataURL(blob);
  });
}

/** 停止录音并把音频（base64）下发给 popup 用于回放。 */
function finalizeRecording(): void {
  const recorder = activeRecorder;
  const tabId = recordTabId;
  activeRecorder = null;
  recordTabId = null;
  if (!recorder || recorder.state === 'inactive') {
    recordedChunks = [];
    return;
  }
  const mime = recorder.mimeType || 'audio/webm';
  recorder.onstop = (): void => {
    const chunks = recordedChunks;
    recordedChunks = [];
    if (chunks.length === 0) return;
    void blobToBase64(new Blob(chunks, { type: mime }))
      .then((base64) => {
        if (!base64) return;
        chrome.runtime.sendMessage({
          type: 'simulcast:update',
          target: 'background',
          tabId,
          audio: { base64, mime },
        });
      })
      .catch(() => undefined);
  };
  try {
    recorder.stop();
  } catch {
    recordedChunks = [];
  }
}

function clearTranslatedAudioTimers(): void {
  activeTranslatedAudioTimers.forEach((timerId) => window.clearTimeout(timerId));
  activeTranslatedAudioTimers = [];
}

function cleanupTranslatedAudio(audio: HTMLAudioElement): void {
  const url = activeTranslatedAudioUrls.get(audio);
  if (url) {
    URL.revokeObjectURL(url);
  }
  activeTranslatedAudioUrls.delete(audio);
  if (activeTranslatedAudio === audio) {
    activeTranslatedAudio = null;
  }
}

function stopTranslatedAudios(): void {
  activeTranslatedAudioUrls.forEach((url, audio) => {
    audio.pause();
    audio.src = '';
    URL.revokeObjectURL(url);
  });
  activeTranslatedAudioUrls.clear();
  activeTranslatedAudio = null;
}

function stopActiveCapture(): void {
  clearTranslatedAudioTimers();
  // 先收尾录音（在停轨前 stop，让 MediaRecorder 把缓冲刷出）
  finalizeRecording();
  activeProcessor?.disconnect();
  activeProcessor = null;

  activeAstSession?.finish();
  activeAstSession?.close();
  activeAstSession = null;
  activeSession = null;

  activeSource?.disconnect();
  activeSource = null;

  activeOriginalGain?.disconnect();
  activeOriginalGain = null;

  activeStream?.getTracks().forEach((track) => track.stop());
  activeStream = null;

  // 文件/链接媒体元素收尾
  if (activeMediaEl) {
    activeMediaEl.pause();
    activeMediaEl.src = '';
    activeMediaEl = null;
  }
  if (activeMediaObjectUrl) {
    URL.revokeObjectURL(activeMediaObjectUrl);
    activeMediaObjectUrl = null;
  }

  void activeAudioContext?.close().catch(() => undefined);
  activeAudioContext = null;

  stopTranslatedAudios();
  ttsChunks = [];
  activeTtsSegmentId = 0;
  nextTtsSegmentId = 1;
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

function updateActivePlaybackSettings(
  message: SimulcastOffscreenUpdatePlaybackMessage
): { status: 'ok'; updated: boolean } {
  const session = activeSession;
  if (!session) {
    return { status: 'ok', updated: false };
  }
  if (typeof message.tabId === 'number' && message.tabId !== session.tabId) {
    return { status: 'ok', updated: false };
  }

  session.originalVolume = clampVolume(message.originalVolume, session.originalVolume);
  session.translatedVolume = clampVolume(message.translatedVolume, session.translatedVolume);
  session.translatedAudioDelayMs = normalizeSimulcastPlaybackDelayMs(
    message.translatedAudioDelayMs ?? session.translatedAudioDelayMs
  );

  if (activeOriginalGain) {
    activeOriginalGain.gain.value = getOriginalPlaybackVolume(session);
  }
  activeTranslatedAudioUrls.forEach((_, audio) => {
    audio.volume = getTranslatedPlaybackVolume(session);
  });

  return { status: 'ok', updated: true };
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
  segmentId: number,
  chunks: Uint8Array[],
  getVolume: () => number,
  delayMs: number,
  onPlaybackStatus?: (status: { kind: 'success' | 'error' | 'info'; message: string }) => void,
  onTranslatedAudio?: (event: SimulcastTranslatedAudioPlaybackEvent) => void
): void {
  if (!chunks.length || getVolume() <= 0) {
    return;
  }

  const normalizedDelayMs = normalizeSimulcastPlaybackDelayMs(delayMs);
  const startPlayback = (): void => {
    const volume = clampVolume(getVolume(), 1);
    if (volume <= 0) {
      return;
    }
    const audioBytes = concatChunks(chunks);
    const audioBuffer = new ArrayBuffer(audioBytes.byteLength);
    new Uint8Array(audioBuffer).set(audioBytes);
    const blob = new Blob([audioBuffer], { type: 'audio/ogg; codecs=opus' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = clampVolume(volume, 1);
    audio.onended = (): void => {
      onTranslatedAudio?.({
        event: 'playback-ended',
        segmentId,
        wallTimeMs: Date.now(),
        delayMs: normalizedDelayMs,
      });
      cleanupTranslatedAudio(audio);
    };
    activeTranslatedAudio = audio;
    activeTranslatedAudioUrls.set(audio, url);
    void audio
      .play()
      .then(() => {
        onTranslatedAudio?.({
          event: 'playback-started',
          segmentId,
          wallTimeMs: Date.now(),
          delayMs: normalizedDelayMs,
        });
        onPlaybackStatus?.({
          kind: 'success',
          message: '同声传译运行中：正在播放译音。',
        });
      })
      .catch((error) => {
        cleanupTranslatedAudio(audio);
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
          activeTtsSegmentId = nextTtsSegmentId++;
        }
        if (response.event === VOLCENGINE_AST_EVENTS.TTSSentenceEnd) {
          const segmentId = activeTtsSegmentId || nextTtsSegmentId++;
          playTranslatedAudio(
            segmentId,
            ttsChunks,
            () => getTranslatedPlaybackVolume(message.session),
            normalizeSimulcastPlaybackDelayMs(message.session.translatedAudioDelayMs),
            (status) => {
              chrome.runtime.sendMessage({
                type: 'simulcast:update',
                target: 'background',
                tabId: message.session.tabId,
                status,
              });
            },
            (translatedAudio) => {
              chrome.runtime.sendMessage({
                type: 'simulcast:update',
                target: 'background',
                tabId: message.session.tabId,
                translatedAudio,
              });
            }
          );
          ttsChunks = [];
          activeTtsSegmentId = 0;
        }
      },
    }
  );
}

function connectAudioToAst(
  audioContext: AudioContext,
  source: AudioNode,
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
  source: AudioNode,
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
  source?: AudioNode;
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

  const session = message.session;
  const isMedia = session.audioSource === 'file' || session.audioSource === 'url';

  let stream: MediaStream | undefined;
  let audioContext: AudioContext | undefined;
  let source: AudioNode | undefined;
  let originalGain: GainNode | undefined;
  let processor: ScriptProcessorNode | undefined;
  let astSession: VolcengineAstSession | undefined;
  let mediaEl: HTMLAudioElement | undefined;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();

    if (isMedia) {
      // 文件/链接：用音频元素当源，实时(1x)播入现有 PCM→AST 管线
      mediaEl = await buildMediaSourceElement(session);
      source = audioContext.createMediaElementSource(mediaEl);
    } else {
      stream = await navigator.mediaDevices.getUserMedia(
        session.audioSource === 'mic'
          ? { audio: true, video: false }
          : createTabAudioConstraints(session.streamId)
      );
      if (session.recordAudio && stream) {
        recordedChunks = [];
        try {
          const recorder = new MediaRecorder(stream);
          recorder.ondataavailable = (event): void => {
            if (event.data && event.data.size > 0) recordedChunks.push(event.data);
          };
          recorder.start(1000);
          activeRecorder = recorder;
          recordTabId = session.tabId;
        } catch {
          activeRecorder = null;
        }
      }
      source = audioContext.createMediaStreamSource(stream);
      originalGain = connectOriginalPlayback(audioContext, source, session);
    }

    astSession = createAstSession(message);
    await astSession.start();
    await astSession.waitUntilStarted();
    processor = connectAudioToAst(audioContext, source, astSession);

    if (isMedia && mediaEl) {
      const mediaTabId = session.tabId;
      mediaEl.addEventListener('ended', () => {
        activeAstSession?.finish();
        chrome.runtime.sendMessage({
          type: 'simulcast:update',
          target: 'background',
          tabId: mediaTabId,
          status: { kind: 'success', message: '文件/链接转写完成' },
        });
      });
      await audioContext.resume().catch(() => undefined);
      await mediaEl.play();
    }
  } catch (error) {
    cleanupFailedCapture({ stream, audioContext, source, originalGain, processor, astSession });
    if (mediaEl) {
      mediaEl.pause();
      mediaEl.src = '';
    }
    if (activeMediaObjectUrl) {
      URL.revokeObjectURL(activeMediaObjectUrl);
      activeMediaObjectUrl = null;
    }
    throw error;
  }

  if (!audioContext || !source || !processor || !astSession) {
    throw new Error('同声传译音频链路初始化失败');
  }

  activeStream = stream ?? null;
  activeAudioContext = audioContext;
  activeSource = source;
  activeOriginalGain = originalGain ?? null;
  activeProcessor = processor;
  activeAstSession = astSession;
  activeSession = session;
  activeMediaEl = mediaEl ?? null;

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

  if (message.type === 'simulcast:offscreenUpdatePlayback') {
    sendResponse(updateActivePlaybackSettings(message));
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
