import {
  getSimulcastStrictPlayerChannel,
} from '@/simulcast/video-sync-mode';
import type { StrictDelayedVideoRelayMessage } from '@/offscreen/simulcast-video-relay';

const params = new URLSearchParams(window.location.search);
const sessionId = params.get('sessionId') || '';
const initialDelaySec = Number(params.get('delay') || '1');

const canvas = document.getElementById('simulcast-player-canvas') as HTMLCanvasElement | null;
const statusEl = document.getElementById('simulcast-player-status');
const delayEl = document.getElementById('simulcast-player-delay');
const context = canvas?.getContext('2d') ?? null;

let channel: BroadcastChannel | null = null;
let lastFrameCount = 0;

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
  context.drawImage(message.bitmap, 0, 0, canvas.width, canvas.height);
  message.bitmap.close();
  lastFrameCount = message.frameCount;
  setDelay(message.targetDelaySec);
  setStatus(`播放中 · 第 ${lastFrameCount} 帧`);
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
  delayEl.textContent = `延迟 ${delaySec.toFixed(1)}s`;
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
