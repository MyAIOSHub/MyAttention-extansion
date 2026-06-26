import { getSimulcastStrictPlayerChannel } from '@/simulcast/video-sync-mode';

export type StrictDelayedVideoRelayMessage =
  | {
      type: 'status';
      state: 'starting' | 'playing' | 'stopped' | 'unsupported' | 'error';
      message?: string;
      targetDelaySec?: number;
      frameCount?: number;
    }
  | {
      type: 'frame';
      bitmap: ImageBitmap;
      width: number;
      height: number;
      capturedAtMs: number;
      displayAtMs: number;
      targetDelaySec: number;
      frameCount: number;
    };

type VideoFrameCallbackMetadata = {
  mediaTime?: number;
  presentedFrames?: number;
  width?: number;
  height?: number;
};

type VideoElementWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameCallbackMetadata) => void
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

interface PendingVideoFrame {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  capturedAtMs: number;
  displayAtMs: number;
  frameCount: number;
}

interface StrictDelayedVideoRelayOptions {
  sessionId: string;
  targetDelaySec: number;
  now?: () => number;
}

const DEFAULT_FRAME_INTERVAL_MS = 1000 / 24;
const MAX_PENDING_FRAMES = 240;

export class StrictDelayedVideoRelay {
  private readonly channel: BroadcastChannel;
  private readonly now: () => number;
  private video: VideoElementWithFrameCallback | null = null;
  private pendingFrames: PendingVideoFrame[] = [];
  private frameTimerId: number | null = null;
  private flushTimerId: number | null = null;
  private frameCallbackId: number | null = null;
  private stopped = true;
  private lastCapturedAtMs = 0;
  private frameCount = 0;
  private targetDelaySec: number;

  constructor(options: StrictDelayedVideoRelayOptions) {
    this.channel = new BroadcastChannel(
      getSimulcastStrictPlayerChannel(options.sessionId)
    );
    this.targetDelaySec = normalizeRelayDelaySec(options.targetDelaySec);
    this.now = options.now ?? (() => performance.now());
  }

  async start(stream: MediaStream): Promise<boolean> {
    if (stream.getVideoTracks().length === 0) {
      this.postStatus('unsupported', '当前 tabCapture 没有可用视频轨道。');
      return false;
    }

    this.stopped = false;
    this.postStatus('starting', '正在等待标签页视频帧。');
    const video = document.createElement('video') as VideoElementWithFrameCallback;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.style.cssText =
      'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none;';
    video.srcObject = stream;
    document.body.appendChild(video);
    this.video = video;

    try {
      await video.play();
    } catch (error) {
      this.postStatus(
        'error',
        error instanceof Error ? error.message : '无法播放捕获到的视频流。'
      );
      this.stop();
      return false;
    }

    this.scheduleNextFrame();
    return true;
  }

  updateDelaySec(delaySec: number): void {
    this.targetDelaySec = normalizeRelayDelaySec(delaySec);
    this.trimPendingFrames();
    this.scheduleFlush();
    this.postStatus('playing', '已更新精准同步延迟。');
  }

  stop(): void {
    this.stopped = true;
    if (this.frameTimerId !== null) {
      clearTimeout(this.frameTimerId);
      this.frameTimerId = null;
    }
    if (this.flushTimerId !== null) {
      clearTimeout(this.flushTimerId);
      this.flushTimerId = null;
    }
    const video = this.video;
    if (video && this.frameCallbackId !== null && video.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(this.frameCallbackId);
    }
    this.frameCallbackId = null;
    if (video) {
      video.pause();
      video.srcObject = null;
      video.remove();
      this.video = null;
    }
    for (const frame of this.pendingFrames) {
      frame.bitmap.close();
    }
    this.pendingFrames = [];
    this.postStatus('stopped', '精准同步播放器已停止。');
    this.channel.close();
  }

  private scheduleNextFrame(): void {
    if (this.stopped || !this.video) {
      return;
    }
    const video = this.video;
    if (video.requestVideoFrameCallback) {
      this.frameCallbackId = video.requestVideoFrameCallback(() => {
        void this.captureFrame().finally(() => this.scheduleNextFrame());
      });
      return;
    }

    this.frameTimerId = window.setTimeout(() => {
      void this.captureFrame().finally(() => this.scheduleNextFrame());
    }, DEFAULT_FRAME_INTERVAL_MS);
  }

  private async captureFrame(): Promise<void> {
    const video = this.video;
    if (this.stopped || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }
    const capturedAtMs = this.now();
    if (capturedAtMs - this.lastCapturedAtMs < DEFAULT_FRAME_INTERVAL_MS * 0.8) {
      return;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width <= 0 || height <= 0) {
      return;
    }

    this.lastCapturedAtMs = capturedAtMs;
    const bitmap = await createImageBitmap(video);
    this.frameCount += 1;
    this.pendingFrames.push({
      bitmap,
      width,
      height,
      capturedAtMs,
      displayAtMs: capturedAtMs + this.targetDelaySec * 1000,
      frameCount: this.frameCount,
    });
    this.trimPendingFrames();
    this.scheduleFlush();
    if (this.frameCount === 1) {
      this.postStatus('playing', '精准同步播放器已接收首帧。');
    }
  }

  private trimPendingFrames(): void {
    while (this.pendingFrames.length > MAX_PENDING_FRAMES) {
      this.pendingFrames.shift()?.bitmap.close();
    }
  }

  private scheduleFlush(): void {
    if (this.stopped) {
      return;
    }
    if (this.flushTimerId !== null) {
      clearTimeout(this.flushTimerId);
      this.flushTimerId = null;
    }
    const nextFrame = this.pendingFrames[0];
    if (!nextFrame) {
      return;
    }
    const delayMs = Math.max(0, nextFrame.displayAtMs - this.now());
    this.flushTimerId = window.setTimeout(() => this.flushReadyFrames(), delayMs);
  }

  private flushReadyFrames(): void {
    if (this.stopped) {
      return;
    }
    const now = this.now();
    while (this.pendingFrames.length > 0 && this.pendingFrames[0].displayAtMs <= now) {
      const frame = this.pendingFrames.shift()!;
      try {
        this.channel.postMessage({
          type: 'frame',
          bitmap: frame.bitmap,
          width: frame.width,
          height: frame.height,
          capturedAtMs: frame.capturedAtMs,
          displayAtMs: frame.displayAtMs,
          targetDelaySec: this.targetDelaySec,
          frameCount: frame.frameCount,
        } satisfies StrictDelayedVideoRelayMessage);
      } finally {
        frame.bitmap.close();
      }
    }
    this.scheduleFlush();
  }

  private postStatus(
    state: Extract<StrictDelayedVideoRelayMessage, { type: 'status' }>['state'],
    message: string
  ): void {
    this.channel.postMessage({
      type: 'status',
      state,
      message,
      targetDelaySec: this.targetDelaySec,
      frameCount: this.frameCount,
    } satisfies StrictDelayedVideoRelayMessage);
  }
}

function normalizeRelayDelaySec(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(8, Math.max(1, value));
}
