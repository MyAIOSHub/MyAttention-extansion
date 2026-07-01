import {
  AST_PCM_CHUNK_BYTES,
  AST_TARGET_SAMPLE_RATE,
  TimedPcmChunker,
  downsampleFloat32,
  floatTo16BitPcm,
  type TimedPcmChunk,
} from './pcm-audio';
import { resolveAstLanguagePair } from './ast-language';
import { VolcengineAstSession, type AstWebSocketLike } from './volcengine-ast-session';
import { VOLCENGINE_AST_EVENTS } from '@/translation/volcengine-ast-protobuf';
import { normalizeSimulcastPlaybackDelayMs } from './simulcast-delay';
import {
  TranslatedAudioPlaybackQueue,
  type TranslatedAudioPlaybackEvent,
} from './translated-audio-queue';
import { StrictDelayedVideoRelay, type StrictVideoCrop } from './simulcast-video-relay';
import {
  normalizeSimulcastVideoSyncMode,
  normalizeStrictBufferSec,
  type SimulcastVideoSyncMode,
} from '@/simulcast/video-sync-mode';

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
    translatedMaxPlaybackRate?: number;
    videoSyncMode?: SimulcastVideoSyncMode;
    videoViewportRect?: StrictVideoCrop;
    strictPlayerSessionId?: string;
    strictPlayerTargetDelaySec?: number;
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
  translatedMaxPlaybackRate?: number;
}

interface SimulcastOffscreenStrictPlayerDelayMessage {
  type: 'simulcast:offscreenStrictPlayerDelay';
  tabId?: number;
  targetDelaySec?: number;
}

type SimulcastOffscreenMessage =
  | SimulcastOffscreenStartMessage
  | SimulcastOffscreenStopMessage
  | SimulcastOffscreenUpdatePlaybackMessage
  | SimulcastOffscreenStrictPlayerDelayMessage;

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
let activeTtsSourceStartPts: number | undefined;
let activeTtsSourceEndPts: number | undefined;
// 上一段译音的源结束 PTS，供 provider 缺 startTime 时续接，保持单调。
let lastTtsSourceEndPts: number | undefined;
// 捕获起点墙钟（performance.now 域）：源 PTS=0 对应时刻，主时钟锚点。
let captureStartWallMs: number | null = null;
const translatedAudioQueue = new TranslatedAudioPlaybackQueue();
// 转写录音（仅 recordAudio 会话）
let activeRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let recordTabId: number | null = null;
// 文件/链接转写的媒体元素
let activeMediaEl: HTMLAudioElement | null = null;
let activeMediaObjectUrl: string | null = null;
let activeVideoRelay: StrictDelayedVideoRelay | null = null;
let activeAudioHealthTimer: number | null = null;
let lastAudioSendFailureReported = false;
let lastAudioChunkSentAtMs: number | null = null;
let lastAstResponseAtMs: number | null = null;

const AUDIO_INPUT_STALL_WARNING_MS = 5000;
const AUDIO_HEALTH_CHECK_INTERVAL_MS = 2000;
const AST_RESPONSE_STALL_WARNING_MS = 15000;

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

function stopTranslatedAudios(): void {
  translatedAudioQueue.stop();
}

function clearAudioHealthMonitor(): void {
  if (activeAudioHealthTimer !== null) {
    window.clearInterval(activeAudioHealthTimer);
    activeAudioHealthTimer = null;
  }
  lastAudioSendFailureReported = false;
  lastAudioChunkSentAtMs = null;
  lastAstResponseAtMs = null;
}

function stopActiveCapture(): void {
  clearAudioHealthMonitor();
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
  activeVideoRelay?.stop();
  activeVideoRelay = null;

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
  translatedAudioQueue.setSourceTimeline(null);
  translatedAudioQueue.setAudioContext(null);
  ttsChunks = [];
  activeTtsSegmentId = 0;
  activeTtsSourceStartPts = undefined;
  activeTtsSourceEndPts = undefined;
  lastTtsSourceEndPts = undefined;
  captureStartWallMs = null;
  nextTtsSegmentId = 1;
}

function createTabCaptureConstraints(
  streamId: string,
  includeVideo: boolean
): MediaStreamConstraints {
  return {
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    } as unknown as MediaTrackConstraints,
    video: includeVideo
      ? ({
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        } as unknown as MediaTrackConstraints)
      : false,
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
  return clampVolume(session.originalVolume, 0);
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
  session.translatedMaxPlaybackRate =
    message.translatedMaxPlaybackRate ?? session.translatedMaxPlaybackRate;

  if (activeOriginalGain) {
    activeOriginalGain.gain.value = getOriginalPlaybackVolume(session);
  }
  translatedAudioQueue.updateActiveVolume(getTranslatedPlaybackVolume(session));
  translatedAudioQueue.setBasePlaybackRate(session.translatedMaxPlaybackRate);

  return { status: 'ok', updated: true };
}

function updateStrictPlayerDelay(
  message: SimulcastOffscreenStrictPlayerDelayMessage
): { status: 'ok'; updated: boolean } {
  const session = activeSession;
  if (!session || !activeVideoRelay) {
    return { status: 'ok', updated: false };
  }
  if (typeof message.tabId === 'number' && message.tabId !== session.tabId) {
    return { status: 'ok', updated: false };
  }
  if (typeof message.targetDelaySec !== 'number') {
    return { status: 'ok', updated: false };
  }

  session.strictPlayerTargetDelaySec = message.targetDelaySec;
  activeVideoRelay.updateDelaySec(message.targetDelaySec);
  // 译音主时钟缓冲随之更新，保持音画用同一固定缓冲。
  translatedAudioQueue.setBufferSec(message.targetDelaySec);
  return { status: 'ok', updated: true };
}

function playTranslatedAudio(
  segmentId: number,
  chunks: Uint8Array[],
  getVolume: () => number,
  delayMs: number,
  onPlaybackStatus?: (status: { kind: 'success' | 'error' | 'info'; message: string }) => void,
  onTranslatedAudio?: (event: TranslatedAudioPlaybackEvent) => void
): void {
  translatedAudioQueue.enqueue({
    segmentId,
    chunks,
    getVolume,
    delayMs,
    sourceStartPts: activeTtsSourceStartPts,
    sourceEndPts: activeTtsSourceEndPts,
    receivedAtMs: performance.now(),
    codec: 'audio/ogg; codecs=opus',
    onPlaybackStatus,
    onTranslatedAudio,
  });
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
        sendSimulcastStatus(
          message.session.tabId,
          `火山 AST 会话异常：${error.message}`,
          'error'
        );
      },
      onClose: (): void => {
        sendSimulcastStatus(
          message.session.tabId,
          '火山 AST 连接已关闭，译音不会继续返回。请停止后重新开始同传。',
          'error'
        );
      },
      onEvent: (response): void => {
        lastAstResponseAtMs = performance.now();
        if (response.event === VOLCENGINE_AST_EVENTS.TTSSentenceStart) {
          ttsChunks = [];
          activeTtsSegmentId = nextTtsSegmentId++;
          // provider 偶尔不给 startTime → 用上段结束 PTS 续接，保持源时间线单调（主时钟锚定可靠）。
          activeTtsSourceStartPts =
            normalizeProviderTimeToSeconds(response.startTime) ?? lastTtsSourceEndPts;
          activeTtsSourceEndPts = normalizeProviderTimeToSeconds(response.endTime);
        }
        if (response.event === VOLCENGINE_AST_EVENTS.TTSSentenceEnd) {
          const segmentId = activeTtsSegmentId || nextTtsSegmentId++;
          activeTtsSourceEndPts =
            normalizeProviderTimeToSeconds(response.endTime) ?? activeTtsSourceEndPts;
          if (typeof activeTtsSourceEndPts === 'number') {
            lastTtsSourceEndPts = activeTtsSourceEndPts;
          }
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
          activeTtsSourceStartPts = undefined;
          activeTtsSourceEndPts = undefined;
        }
      },
    }
  );
}

function normalizeProviderTimeToSeconds(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value > 1000 ? value / 1000 : value;
}

function sendTimedAudioChunk(astSession: VolcengineAstSession, chunk: TimedPcmChunk): void {
  const sent = astSession.sendAudioChunk(chunk.bytes, {
    sequence: chunk.sequence,
    sourceStartPts: chunk.sourceStartPts,
    sourceEndPts: chunk.sourceEndPts,
    capturedAtMs: chunk.capturedAtMs,
    sendAtMs: performance.now(),
  });
  if (sent) {
    lastAudioChunkSentAtMs = performance.now();
    return;
  }
  if (!lastAudioSendFailureReported && activeSession) {
    lastAudioSendFailureReported = true;
    sendSimulcastStatus(
      activeSession.tabId,
      '音频仍在采集，但火山 AST 连接不可用，后续译音已停止。',
      'error'
    );
  }
}

function sendSimulcastStatus(
  tabId: number,
  message: string,
  kind: 'success' | 'error' | 'info' = 'success'
): void {
  chrome.runtime.sendMessage({
    type: 'simulcast:update',
    target: 'background',
    tabId,
    status: { kind, message },
  });
}

function connectAudioToAst(
  audioContext: AudioContext,
  source: AudioNode,
  astSession: VolcengineAstSession,
  onFirstChunk?: () => void
): ScriptProcessorNode {
  let firstChunkSent = false;
  const pcmChunker = new TimedPcmChunker({
    chunkSize: AST_PCM_CHUNK_BYTES,
    sampleRate: AST_TARGET_SAMPLE_RATE,
    onChunk: (chunk) => {
      // 记录源 PTS=0 的墙钟时刻（首块的 capturedAtMs，performance.now 域，与视频中继同源）。
      if (captureStartWallMs === null) {
        captureStartWallMs = chunk.capturedAtMs - chunk.sourceStartPts * 1000;
      }
      if (!firstChunkSent) {
        firstChunkSent = true;
        onFirstChunk?.();
      }
      sendTimedAudioChunk(astSession, chunk);
    },
  });
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event): void => {
    const channel = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleFloat32(channel, audioContext.sampleRate, AST_TARGET_SAMPLE_RATE);
    pcmChunker.push(floatTo16BitPcm(downsampled), performance.now());
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
  return processor;
}

function startAudioHealthMonitor(
  session: SimulcastOffscreenStartMessage['session'],
  astSession: VolcengineAstSession
): void {
  clearAudioHealthMonitor();
  const startedAtMs = performance.now();
  let noInputReported = false;
  let noAstResponseReported = false;
  activeAudioHealthTimer = window.setInterval(() => {
    if (activeSession !== session || activeAstSession !== astSession) {
      clearAudioHealthMonitor();
      return;
    }
    if (!astSession.isOpen()) {
      return;
    }
    const now = performance.now();
    if (
      lastAudioChunkSentAtMs === null &&
      !noInputReported &&
      now - startedAtMs >= AUDIO_INPUT_STALL_WARNING_MS
    ) {
      noInputReported = true;
      sendSimulcastStatus(
        session.tabId,
        '还没有检测到标签页音频输入，请确认视频正在播放且标签页没有静音。',
        'info'
      );
    }
    if (
      lastAudioChunkSentAtMs !== null &&
      !noAstResponseReported &&
      now - (lastAstResponseAtMs ?? startedAtMs) >= AST_RESPONSE_STALL_WARNING_MS
    ) {
      noAstResponseReported = true;
      sendSimulcastStatus(
        session.tabId,
        '音频仍在发送，但火山 AST 暂时没有继续返回字幕或译音。',
        'info'
      );
    }
  }, AUDIO_HEALTH_CHECK_INTERVAL_MS);
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
  strictVideo?: 'active' | 'unavailable';
}> {
  stopActiveCapture();

  const session = message.session;
  const isMedia = session.audioSource === 'file' || session.audioSource === 'url';
  const videoSyncMode = normalizeSimulcastVideoSyncMode(session.videoSyncMode);
  const strictVideoEnabled =
    !isMedia &&
    videoSyncMode === 'strict-delayed-player' &&
    typeof session.strictPlayerSessionId === 'string' &&
    session.strictPlayerSessionId.length > 0;

  let stream: MediaStream | undefined;
  let audioContext: AudioContext | undefined;
  let source: AudioNode | undefined;
  let originalGain: GainNode | undefined;
  let processor: ScriptProcessorNode | undefined;
  let astSession: VolcengineAstSession | undefined;
  let mediaEl: HTMLAudioElement | undefined;
  let videoRelay: StrictDelayedVideoRelay | undefined;
  let strictVideo: 'active' | 'unavailable' | undefined;

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
          : createTabCaptureConstraints(session.streamId, strictVideoEnabled)
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
      if (strictVideoEnabled && stream) {
        videoRelay = new StrictDelayedVideoRelay({
          sessionId: session.strictPlayerSessionId!,
          targetDelaySec: normalizeStrictBufferSec(session.strictPlayerTargetDelaySec),
          videoViewportRect: session.videoViewportRect,
        });
        const videoTrackCount = stream.getVideoTracks().length;
        const relayStarted = await videoRelay.start(stream);
        if (!relayStarted) {
          videoRelay = undefined;
        }
        strictVideo = relayStarted ? 'active' : 'unavailable';
        console.debug('[simulcast] 精准同步视频中继', {
          strictVideo,
          videoTrackCount,
          streamId: session.streamId,
        });
        // 上报严格中继成败：失败 → popup 本次会话回退页面视频对齐。
        chrome.runtime.sendMessage({
          type: 'simulcast:update',
          target: 'background',
          tabId: session.tabId,
          strictVideo,
          strictVideoTrackCount: videoTrackCount,
        });
      }
    }

    astSession = createAstSession(message);
    await astSession.start();
    await astSession.waitUntilStarted();
    sendSimulcastStatus(session.tabId, '已连接火山 AST，正在等待音频输入。');
    processor = connectAudioToAst(audioContext, source, astSession, () => {
      sendSimulcastStatus(session.tabId, '同声传译运行中：正在发送音频到火山 AST。');
    });
    await audioContext.resume().catch(() => undefined);

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
      await mediaEl.play();
    }
  } catch (error) {
    videoRelay?.stop();
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
  startAudioHealthMonitor(session, astSession);
  activeMediaEl = mediaEl ?? null;
  activeVideoRelay = videoRelay ?? null;
  translatedAudioQueue.setAudioContext(audioContext);
  translatedAudioQueue.setBasePlaybackRate(session.translatedMaxPlaybackRate);
  // 精准同步：把译音锚到与视频帧同一条「源墙钟 + 固定缓冲」主时钟；缺料增长/排空收缩时同步推后/拉回视频帧。
  if (activeVideoRelay) {
    const bufferSec = normalizeStrictBufferSec(session.strictPlayerTargetDelaySec);
    const relay = activeVideoRelay;
    const tabId = session.tabId;
    // 把有效缓冲（真实音画延迟）回传 popup 作唯一真相源，避免页面估算器展示不一致的猜测值。
    const reportBufferSec = (effectiveSec: number): void => {
      chrome.runtime.sendMessage({
        type: 'simulcast:update',
        target: 'background',
        tabId,
        strictBufferSec: effectiveSec,
      });
    };
    translatedAudioQueue.setSourceTimeline({
      originWallMs: captureStartWallMs ?? performance.now(),
      bufferMs: bufferSec * 1000,
      onBufferChange: (effectiveSec) => {
        relay.updateDelaySec(effectiveSec);
        reportBufferSec(effectiveSec);
      },
    });
    reportBufferSec(bufferSec);
  }

  return {
    status: 'ok',
    captured: true,
    strictVideo,
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

  if (message.type === 'simulcast:offscreenStrictPlayerDelay') {
    sendResponse(updateStrictPlayerDelay(message));
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
