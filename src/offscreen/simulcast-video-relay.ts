import {
  getSimulcastStrictPlayerChannel,
  MAX_STRICT_BUFFER_SEC,
  MIN_STRICT_BUFFER_SEC,
} from '@/simulcast/video-sync-mode';

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
    }
  | {
      type: 'subtitle';
      source?: string;
      translation?: string;
      channel?: 'source' | 'translation';
      text?: string;
      event?: number;
      reset?: boolean;
      mode: string;
      clear?: boolean;
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
  frameCount: number;
}

export interface StrictVideoCrop {
  left: number;
  top: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

interface StrictDelayedVideoRelayOptions {
  sessionId: string;
  targetDelaySec: number;
  videoViewportRect?: StrictVideoCrop;
  now?: () => number;
}

const DEFAULT_FRAME_INTERVAL_MS = 1000 / 24;
const FIRST_FRAME_TIMEOUT_MS = 2500;
// 待发帧上限按当前缓冲动态算（缓冲增大时不能静默丢有效帧 → 否则永久失步），并设安全硬顶。
const ABSOLUTE_MAX_PENDING_FRAMES = 900;
function maxPendingFramesFor(targetDelaySec: number): number {
  return Math.min(ABSOLUTE_MAX_PENDING_FRAMES, Math.ceil((targetDelaySec + 1) * 60));
}

export class StrictDelayedVideoRelay {
  private readonly channel: BroadcastChannel;
  private readonly now: () => number;
  private video: VideoElementWithFrameCallback | null = null;
  private pendingFrames: PendingVideoFrame[] = [];
  private frameTimerId: number | null = null;
  private flushTimerId: number | null = null;
  private frameCallbackId: number | null = null;
  private firstFrameTimeoutId: number | null = null;
  private resolveFirstFrame: ((captured: boolean) => void) | null = null;
  private stopped = true;
  private lastCapturedAtMs = 0;
  private frameCount = 0;
  private targetDelaySec: number;
  private readonly videoViewportRect?: StrictVideoCrop;

  constructor(options: StrictDelayedVideoRelayOptions) {
    this.channel = new BroadcastChannel(
      getSimulcastStrictPlayerChannel(options.sessionId)
    );
    this.targetDelaySec = normalizeRelayDelaySec(options.targetDelaySec);
    this.videoViewportRect = normalizeCrop(options.videoViewportRect);
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
    const capturedFirstFrame = await this.waitForFirstFrame();
    if (!capturedFirstFrame) {
      this.postStatus('unsupported', '无法捕获标签页视频帧。');
      this.stop();
      return false;
    }

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
    if (this.firstFrameTimeoutId !== null) {
      clearTimeout(this.firstFrameTimeoutId);
      this.firstFrameTimeoutId = null;
    }
    this.resolveFirstFrame?.(false);
    this.resolveFirstFrame = null;
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
    // Offscreen documents do not reliably fire requestVideoFrameCallback for tabCapture
    // streams in every Chrome state. A fixed sampler keeps the relay from staying black.
    this.frameTimerId = window.setTimeout(() => {
      this.frameTimerId = null;
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

    const sourceRect = resolveSourceRect(
      width,
      height,
      this.videoViewportRect
    );

    this.lastCapturedAtMs = capturedAtMs;
    const bitmap = sourceRect
      ? await createImageBitmap(
          video,
          sourceRect.sx,
          sourceRect.sy,
          sourceRect.sw,
          sourceRect.sh
        )
      : await createImageBitmap(video);
    this.frameCount += 1;
    this.pendingFrames.push({
      bitmap,
      width: sourceRect?.sw ?? width,
      height: sourceRect?.sh ?? height,
      capturedAtMs,
      frameCount: this.frameCount,
    });
    this.trimPendingFrames();
    this.scheduleFlush();
    if (this.frameCount === 1) {
      this.resolveFirstFrame?.(true);
      this.resolveFirstFrame = null;
      if (this.firstFrameTimeoutId !== null) {
        clearTimeout(this.firstFrameTimeoutId);
        this.firstFrameTimeoutId = null;
      }
      this.postStatus('playing', '精准同步播放器已接收首帧。');
    }
  }

  private waitForFirstFrame(): Promise<boolean> {
    if (this.frameCount > 0) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      this.resolveFirstFrame = resolve;
      this.firstFrameTimeoutId = window.setTimeout(() => {
        this.firstFrameTimeoutId = null;
        this.resolveFirstFrame = null;
        resolve(false);
      }, FIRST_FRAME_TIMEOUT_MS);
    });
  }

  /** 帧投递时刻按「当前」targetDelaySec 实时计算：缓冲调大即把待发帧整体推后（=冻结），只增不减。 */
  private displayAtMs(frame: PendingVideoFrame): number {
    return frame.capturedAtMs + this.targetDelaySec * 1000;
  }

  private trimPendingFrames(): void {
    const max = maxPendingFramesFor(this.targetDelaySec);
    while (this.pendingFrames.length > max) {
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
    const delayMs = Math.max(0, this.displayAtMs(nextFrame) - this.now());
    this.flushTimerId = window.setTimeout(() => this.flushReadyFrames(), delayMs);
  }

  private flushReadyFrames(): void {
    if (this.stopped) {
      return;
    }
    const now = this.now();
    while (this.pendingFrames.length > 0 && this.displayAtMs(this.pendingFrames[0]) <= now) {
      const frame = this.pendingFrames.shift()!;
      try {
        this.channel.postMessage({
          type: 'frame',
          bitmap: frame.bitmap,
          width: frame.width,
          height: frame.height,
          capturedAtMs: frame.capturedAtMs,
          displayAtMs: this.displayAtMs(frame),
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
    return MIN_STRICT_BUFFER_SEC;
  }
  return Math.min(MAX_STRICT_BUFFER_SEC, Math.max(MIN_STRICT_BUFFER_SEC, value));
}

function normalizeCrop(crop: StrictVideoCrop | undefined): StrictVideoCrop | undefined {
  if (!crop) {
    return undefined;
  }

  const values = [
    crop.left,
    crop.top,
    crop.width,
    crop.height,
    crop.viewportWidth,
    crop.viewportHeight,
  ];
  if (!values.every((value) => Number.isFinite(value))) {
    return undefined;
  }
  if (crop.width <= 1 || crop.height <= 1 || crop.viewportWidth <= 1 || crop.viewportHeight <= 1) {
    return undefined;
  }

  return crop;
}

function resolveSourceRect(
  sourceWidth: number,
  sourceHeight: number,
  crop: StrictVideoCrop | undefined
): { sx: number; sy: number; sw: number; sh: number } | null {
  if (!crop) {
    return null;
  }

  const scaleX = sourceWidth / crop.viewportWidth;
  const scaleY = sourceHeight / crop.viewportHeight;
  const sx = clampInt(Math.round(crop.left * scaleX), 0, sourceWidth - 1);
  const sy = clampInt(Math.round(crop.top * scaleY), 0, sourceHeight - 1);
  const right = clampInt(Math.round((crop.left + crop.width) * scaleX), sx + 1, sourceWidth);
  const bottom = clampInt(Math.round((crop.top + crop.height) * scaleY), sy + 1, sourceHeight);
  const sw = right - sx;
  const sh = bottom - sy;

  if (sw <= 1 || sh <= 1) {
    return null;
  }

  return { sx, sy, sw, sh };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
