import {
  getSimulcastStrictPlayerChannel,
} from '@/simulcast/video-sync-mode';
import { VOLCENGINE_AST_EVENTS } from '@/translation/volcengine-ast-protobuf';
import type { StrictDelayedVideoRelayMessage } from '@/offscreen/simulcast-video-relay';

const params = new URLSearchParams(window.location.search);
const sessionId = params.get('sessionId') || '';
const initialDelaySec = Number(params.get('delay') || '1');

const stage = document.getElementById('simulcast-player-stage') as HTMLElement | null;
const canvas = document.getElementById('simulcast-player-canvas') as HTMLCanvasElement | null;
const statusEl = document.getElementById('simulcast-player-status');
const delayEl = document.getElementById('simulcast-player-delay');
const stopButton = document.getElementById('simulcast-player-stop') as HTMLButtonElement | null;
const subtitleEl = document.getElementById('simulcast-player-subtitle');
const subtitleSourceEl = document.getElementById('simulcast-player-subtitle-source');
const subtitleTranslationEl = document.getElementById('simulcast-player-subtitle-translation');
const context = canvas?.getContext('2d') ?? null;

let channel: BroadcastChannel | null = null;
let lastFrameCount = 0;
let lastFrameSize: { width: number; height: number } | null = null;
let currentTargetDelaySec = Number.isFinite(initialDelaySec) ? initialDelaySec : 1;
let subtitleTimers: number[] = [];
let subtitleClearTimer: number | null = null;
const subtitleState = {
  source: '',
  translation: '',
  sourceEnded: false,
  translationEnded: false,
};
// AST 字幕到达时已经包含识别/翻译处理耗时；显示时比视频缓冲略提前，避免落后译音。
const SUBTITLE_AUDIO_LEAD_MS = 450;
const SUBTITLE_HOLD_AFTER_END_MS = 1800;
const SOURCE_SUBTITLE_HOLD_AFTER_END_MS = 4000;

setDelay(initialDelaySec);

if (!sessionId || !canvas || !context) {
  setStatus('播放器初始化失败。');
} else {
  channel = new BroadcastChannel(getSimulcastStrictPlayerChannel(sessionId));
  channel.onmessage = (event: MessageEvent<StrictDelayedVideoRelayMessage>): void => {
    handleRelayMessage(event.data);
  };
  setStatus('等待 offscreen 视频帧…');
}

window.addEventListener('beforeunload', () => {
  channel?.close();
  channel = null;
});
window.addEventListener('resize', () => {
  if (lastFrameSize) {
    resizeCanvas(lastFrameSize.width, lastFrameSize.height);
  }
});

stopButton?.addEventListener('click', () => {
  void stopSimulcast();
});

function handleRelayMessage(message: StrictDelayedVideoRelayMessage): void {
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.type === 'status') {
    setStatus(message.message || describeRelayState(message.state));
    if (typeof message.targetDelaySec === 'number') {
      setDelay(message.targetDelaySec);
    }
    return;
  }
  if (message.type === 'frame') {
    drawFrame(message);
    return;
  }
  if (message.type === 'subtitle') {
    setSubtitle(message);
  }
}

function drawFrame(message: Extract<StrictDelayedVideoRelayMessage, { type: 'frame' }>): void {
  if (!canvas || !context) {
    message.bitmap.close();
    return;
  }
  if (canvas.width !== message.width || canvas.height !== message.height) {
    canvas.width = message.width;
    canvas.height = message.height;
  }
  lastFrameSize = { width: message.width, height: message.height };
  resizeCanvas(message.width, message.height);
  context.drawImage(message.bitmap, 0, 0, canvas.width, canvas.height);
  message.bitmap.close();
  lastFrameCount = message.frameCount;
  setDelay(message.targetDelaySec);
  setStatus(`播放中 · 第 ${lastFrameCount} 帧`);
}

function resizeCanvas(frameWidth: number, frameHeight: number): void {
  if (!canvas || !stage || frameWidth <= 0 || frameHeight <= 0) {
    return;
  }
  const bounds = stage.getBoundingClientRect();
  const availableWidth = Math.max(1, bounds.width);
  const availableHeight = Math.max(1, bounds.height);
  const scale = Math.min(availableWidth / frameWidth, availableHeight / frameHeight);
  const cssWidth = Math.max(1, Math.floor(frameWidth * scale));
  const cssHeight = Math.max(1, Math.floor(frameHeight * scale));
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
}

function setSubtitle(message: Extract<StrictDelayedVideoRelayMessage, { type: 'subtitle' }>): void {
  if (!subtitleEl || !subtitleSourceEl || !subtitleTranslationEl) {
    return;
  }
  if (message.clear) {
    clearSubtitle(true);
    return;
  }
  const delayMs = getSubtitleDisplayDelayMs();
  const timerId = window.setTimeout(() => {
    subtitleTimers = subtitleTimers.filter((id) => id !== timerId);
    renderSubtitle(message);
  }, delayMs);
  subtitleTimers.push(timerId);
}

function renderSubtitle(
  message: Extract<StrictDelayedVideoRelayMessage, { type: 'subtitle' }>
): void {
  if (!subtitleEl || !subtitleSourceEl || !subtitleTranslationEl) {
    return;
  }
  const mode = message.mode || 'bilingual';
  if (mode === 'off') {
    clearSubtitle(false);
    return;
  }

  if (message.channel && typeof message.text === 'string') {
    const next = message.text.trim();
    cancelSubtitleClearTimer();
    if (message.channel === 'source') {
      const startsNewLine = message.reset || subtitleState.sourceEnded;
      subtitleState.source = mergeStreamingText(subtitleState.source, next, startsNewLine);
      subtitleState.sourceEnded = message.event === VOLCENGINE_AST_EVENTS.SourceSubtitleEnd;
      if (startsNewLine) {
        subtitleState.translation = '';
        subtitleState.translationEnded = false;
      }
    } else {
      const startsNewLine = message.reset || subtitleState.translationEnded;
      subtitleState.translation = mergeStreamingText(
        subtitleState.translation,
        next,
        startsNewLine
      );
      subtitleState.translationEnded =
        message.event === VOLCENGINE_AST_EVENTS.TranslationSubtitleEnd;
    }
  } else {
    cancelSubtitleClearTimer();
    subtitleState.source = (message.source || '').trim();
    subtitleState.translation = (message.translation || '').trim();
    subtitleState.sourceEnded = false;
    subtitleState.translationEnded = false;
  }

  const source = subtitleState.source;
  const translation = subtitleState.translation;
  const showSource = mode === 'bilingual' && !!source;
  const showTranslation = mode !== 'originalOnly' && !!translation;
  subtitleSourceEl.textContent = showSource ? source : '';
  subtitleSourceEl.style.display = showSource ? 'block' : 'none';
  subtitleTranslationEl.textContent = showTranslation ? translation : '';
  subtitleTranslationEl.style.display = showTranslation ? 'block' : 'none';
  subtitleEl.classList.toggle('visible', showSource || showTranslation);
  if (lastFrameSize) {
    resizeCanvas(lastFrameSize.width, lastFrameSize.height);
  }
  scheduleSubtitleClearAfterEnd(message.event);
}

function clearSubtitle(cancelPending: boolean): void {
  if (cancelPending) {
    subtitleTimers.forEach((timerId) => window.clearTimeout(timerId));
    subtitleTimers = [];
  }
  cancelSubtitleClearTimer();
  subtitleState.source = '';
  subtitleState.translation = '';
  subtitleState.sourceEnded = false;
  subtitleState.translationEnded = false;
  if (!subtitleEl || !subtitleSourceEl || !subtitleTranslationEl) {
    return;
  }
  subtitleSourceEl.textContent = '';
  subtitleTranslationEl.textContent = '';
  subtitleEl.classList.remove('visible');
  if (lastFrameSize) {
    resizeCanvas(lastFrameSize.width, lastFrameSize.height);
  }
}

function mergeStreamingText(current: string, next: string, reset = false): string {
  if (reset) {
    return next;
  }
  if (!next) {
    return current;
  }
  if (!current || next.startsWith(current)) {
    return next;
  }
  if (current.includes(next)) {
    return current;
  }
  for (let length = Math.min(current.length, next.length); length > 0; length -= 1) {
    if (current.endsWith(next.slice(0, length))) {
      return current + next.slice(length);
    }
  }
  if (/[。！？!?。]$/.test(current) || current.length + next.length > 140) {
    return next;
  }
  const separator = /[A-Za-z0-9]$/.test(current) && /^[A-Za-z0-9]/.test(next) ? ' ' : '';
  return `${current}${separator}${next}`;
}

function scheduleSubtitleClearAfterEnd(event: number | undefined): void {
  if (
    event !== VOLCENGINE_AST_EVENTS.SourceSubtitleEnd &&
    event !== VOLCENGINE_AST_EVENTS.TranslationSubtitleEnd
  ) {
    return;
  }
  cancelSubtitleClearTimer();
  const holdMs =
    event === VOLCENGINE_AST_EVENTS.SourceSubtitleEnd
      ? SOURCE_SUBTITLE_HOLD_AFTER_END_MS
      : SUBTITLE_HOLD_AFTER_END_MS;
  subtitleClearTimer = window.setTimeout(() => {
    subtitleClearTimer = null;
    clearSubtitle(false);
  }, holdMs);
}

function cancelSubtitleClearTimer(): void {
  if (subtitleClearTimer !== null) {
    window.clearTimeout(subtitleClearTimer);
    subtitleClearTimer = null;
  }
}

function setStatus(text: string): void {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function setDelay(delaySec: number): void {
  if (!delayEl || !Number.isFinite(delaySec)) {
    return;
  }
  currentTargetDelaySec = Math.max(0, delaySec);
  delayEl.textContent = `延迟 ${delaySec.toFixed(1)}s`;
}

function getSubtitleDisplayDelayMs(): number {
  return Math.max(0, currentTargetDelaySec * 1000 - SUBTITLE_AUDIO_LEAD_MS);
}

async function stopSimulcast(): Promise<void> {
  stopButton?.setAttribute('disabled', 'true');
  setStatus('正在停止同传…');
  try {
    await chrome.runtime.sendMessage({ type: 'simulcast:stop' });
    setStatus('已停止');
  } catch (error) {
    stopButton?.removeAttribute('disabled');
    setStatus(error instanceof Error ? error.message : '停止同传失败。');
  }
}

function describeRelayState(
  state: Extract<StrictDelayedVideoRelayMessage, { type: 'status' }>['state']
): string {
  switch (state) {
    case 'starting':
      return '正在启动视频 relay…';
    case 'playing':
      return '播放中';
    case 'stopped':
      return '已停止';
    case 'unsupported':
      return '当前页面不支持精准音画同步。';
    case 'error':
      return '视频 relay 出错。';
    default:
      return '等待视频帧…';
  }
}
