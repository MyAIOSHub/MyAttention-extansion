/**
 * 同声传译音画同步：把页面主视频延迟 N 秒，使其与滞后的译音对齐。
 * 译音天然滞后 N（AST 翻译+TTS），无法追上实时画面 → 只能延迟视频来对齐。
 *
 * - 点播(VOD)：currentTime 回退 N 秒。
 * - 直播(live)：暂停缓冲 N 秒后续播（退到 live edge 之后 N）。
 * 内容脚本运行在页面里，直接控制 <video>；译音由 offscreen 实时播放。
 *
 * 注意：不可对 <video> 设 muted——标签页捕获抓取的正是该视频音频，
 * muted 会让捕获到的样本变静音、AST 收不到声音。原声对用户的静音由标签页
 * 捕获本身完成（offscreen 按 originalVolume/输出模式 决定是否回放原声）。
 */

export type SyncMode = 'vod' | 'live' | 'none';

export interface VideoSyncResult {
  videoFound: boolean;
  mode: SyncMode;
  reason?: string;
}

export type DynamicVideoSyncAction = 'none' | 'enable' | 'release' | 'rate' | 'seek' | 'live-buffer';

export interface DynamicVideoSyncResult extends VideoSyncResult {
  action: DynamicVideoSyncAction;
  targetDelaySec: number;
  previousDelaySec?: number;
  diffSec?: number;
  playbackRate?: number;
  durationMs?: number;
}

interface SyncState {
  video: HTMLVideoElement;
  delaySec: number;
  mode: SyncMode;
}

let state: SyncState | null = null;
let videoLifecycleNotifierInitialized = false;
let scrubReporterInitialized = false;
let lastScrubSentAt = 0;
let lastVideoStoppedSentAt = 0;
let suppressVideoStoppedUntil = 0;
let videoClockState: {
  video: HTMLVideoElement;
  mode: SyncMode;
  requestId?: number;
  intervalId?: number;
  lastSentAt: number;
} | null = null;
let playbackRateRestoreTimer: number | null = null;
let holdVisualState: {
  video: HTMLVideoElement;
  overlay: HTMLCanvasElement;
  previousOpacity: string;
} | null = null;

type VideoFrameMetadataLike = {
  expectedDisplayTime?: number;
  mediaTime?: number;
  presentedFrames?: number;
};

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameMetadataLike) => void
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const VIDEO_CLOCK_SAMPLE_INTERVAL_MS = 250;
const DYNAMIC_SYNC_IGNORE_DRIFT_SEC = 0.15;
const DYNAMIC_SYNC_RATE_DRIFT_LIMIT_SEC = 0.6;
const DYNAMIC_SYNC_RATE_DELTA = 0.04;
const DYNAMIC_SYNC_MIN_RATE_NUDGE_MS = 1000;
const DYNAMIC_SYNC_MAX_RATE_NUDGE_MS = 15000;

function removeVideoHoldVisual(): void {
  if (!holdVisualState) return;
  holdVisualState.video.style.opacity = holdVisualState.previousOpacity;
  holdVisualState.overlay.remove();
  holdVisualState = null;
}

function freezeVideoFrame(video: HTMLVideoElement): void {
  removeVideoHoldVisual();
  const rect = video.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const scale = Math.max(1, window.devicePixelRatio || 1);
  const overlay = document.createElement('canvas');
  overlay.dataset.saysoSimulcastHold = 'true';
  overlay.width = Math.max(1, Math.round(width * scale));
  overlay.height = Math.max(1, Math.round(height * scale));
  overlay.style.cssText = [
    'position:fixed',
    `left:${rect.left}px`,
    `top:${rect.top}px`,
    `width:${width}px`,
    `height:${height}px`,
    'z-index:2147483646',
    'pointer-events:none',
    'background:transparent',
  ].join(';');

  const context =
    typeof window.CanvasRenderingContext2D === 'function' ? overlay.getContext('2d') : null;
  if (context) {
    try {
      context.scale(scale, scale);
      context.drawImage(video, 0, 0, width, height);
    } catch {
      // Cross-origin video frames can be unavailable; keep a transparent hold layer.
    }
  }

  const previousOpacity = video.style.opacity;
  video.style.opacity = '0';
  document.documentElement.appendChild(overlay);
  holdVisualState = { video, overlay, previousOpacity };
}

/** 直播判定：duration 非有限或为 0（HLS live 等）。 */
export function isLiveVideo(video: Pick<HTMLVideoElement, 'duration'>): boolean {
  return !Number.isFinite(video.duration) || video.duration === 0;
}

/** 计算 VOD 回退后的目标位置（夹在 0 以上）。 */
export function computeSeekTarget(currentTime: number, delaySec: number): number {
  return Math.max(0, currentTime - Math.max(0, delaySec));
}

/** 视频是否“可用作主视频”（有源或在播/有时长）。 */
function isUsableVideo(v: HTMLVideoElement): boolean {
  return v.readyState > 0 || !v.paused || v.duration > 0 || !!v.currentSrc || !!v.src;
}

/**
 * 选取主视频：优先可见、面积最大；找不到则兜底到任意在播/有时长的 <video>。
 * （YouTube 等站点视频在顶层文档；放宽过滤避免“未找到”。）
 */
export function findMainVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll('video'));
  let best: HTMLVideoElement | null = null;
  let bestArea = -1;
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  for (const v of videos) {
    if (!isUsableVideo(v)) continue;
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    const onScreen = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    // 在屏的优先；面积更大的优先
    const score = (onScreen ? 1e12 : 0) + area;
    if (score > bestArea) {
      best = v;
      bestArea = score;
    }
  }
  if (best) return best;
  // 兜底：任意 video
  return videos.find(isUsableVideo) ?? videos[0] ?? null;
}

/** 统计页面 video 数量（诊断用）。 */
export function countVideos(): number {
  return document.querySelectorAll('video').length;
}

function clampDynamicDelaySec(delaySec: number): number {
  if (!Number.isFinite(delaySec)) {
    return 0;
  }
  return Math.min(8, Math.max(0, delaySec));
}

function sendVideoClockSample(
  video: HTMLVideoElement,
  mode: SyncMode,
  now: number,
  metadata: VideoFrameMetadataLike = {}
): void {
  const current = videoClockState;
  if (!current || current.video !== video) return;
  if (now - current.lastSentAt < VIDEO_CLOCK_SAMPLE_INTERVAL_MS) return;
  current.lastSentAt = now;

  try {
    chrome.runtime.sendMessage({
      type: 'simulcast:videoClock',
      url: window.location.href,
      mode,
      mediaTime: metadata.mediaTime ?? video.currentTime,
      expectedDisplayTime: metadata.expectedDisplayTime ?? now,
      performanceNow: now,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      paused: video.paused,
      ended: video.ended,
      presentedFrames: metadata.presentedFrames,
    });
  } catch {
    // popup/background 可能未打开或页面正在卸载，采样失败不影响视频播放。
  }
}

function stopVideoClockReporting(): void {
  const current = videoClockState;
  if (!current) return;
  const video = current.video as VideoWithFrameCallback;
  if (typeof current.requestId === 'number' && video.cancelVideoFrameCallback) {
    video.cancelVideoFrameCallback(current.requestId);
  }
  if (typeof current.intervalId === 'number') {
    window.clearInterval(current.intervalId);
  }
  videoClockState = null;
}

function startVideoClockReporting(video: HTMLVideoElement, mode: SyncMode): void {
  if (mode === 'none') return;
  if (videoClockState?.video === video) {
    videoClockState.mode = mode;
    return;
  }

  stopVideoClockReporting();
  videoClockState = {
    video,
    mode,
    lastSentAt: 0,
  };

  const callbackVideo = video as VideoWithFrameCallback;
  if (callbackVideo.requestVideoFrameCallback) {
    const schedule = (): void => {
      if (!videoClockState || videoClockState.video !== video) return;
      videoClockState.requestId = callbackVideo.requestVideoFrameCallback!(
        (now, metadata): void => {
          sendVideoClockSample(video, videoClockState?.mode ?? mode, now, metadata);
          schedule();
        }
      );
    };
    schedule();
    return;
  }

  videoClockState.intervalId = window.setInterval(() => {
    sendVideoClockSample(video, videoClockState?.mode ?? mode, performance.now());
  }, VIDEO_CLOCK_SAMPLE_INTERVAL_MS);
}

function applyDelay(video: HTMLVideoElement, delaySec: number): SyncMode {
  if (isLiveVideo(video)) {
    suppressVideoStoppedUntil = Date.now() + Math.max(0, delaySec) * 1000 + 500;
    video.pause();
    window.setTimeout(() => {
      void video.play().catch(() => undefined);
    }, Math.max(0, delaySec) * 1000);
    return 'live';
  }
  video.currentTime = computeSeekTarget(video.currentTime, delaySec);
  return 'vod';
}

function clearPlaybackRateNudge(): void {
  if (playbackRateRestoreTimer !== null) {
    window.clearTimeout(playbackRateRestoreTimer);
    playbackRateRestoreTimer = null;
  }
}

function nudgePlaybackRate(
  video: HTMLVideoElement,
  diffSec: number
): { playbackRate: number; durationMs: number } {
  clearPlaybackRateNudge();
  const playbackRate =
    diffSec > 0 ? 1 - DYNAMIC_SYNC_RATE_DELTA : 1 + DYNAMIC_SYNC_RATE_DELTA;
  const durationMs = Math.min(
    DYNAMIC_SYNC_MAX_RATE_NUDGE_MS,
    Math.max(
      DYNAMIC_SYNC_MIN_RATE_NUDGE_MS,
      Math.round((Math.abs(diffSec) / DYNAMIC_SYNC_RATE_DELTA) * 1000)
    )
  );

  video.playbackRate = playbackRate;
  playbackRateRestoreTimer = window.setTimeout(() => {
    if (state?.video === video) {
      video.playbackRate = 1;
    }
    playbackRateRestoreTimer = null;
  }, durationMs);

  return { playbackRate, durationMs };
}

export function holdVideoUntilTranslatedAudio(): VideoSyncResult {
  const video = findMainVideo();
  if (!video) {
    return { videoFound: false, mode: 'none', reason: '未找到主视频' };
  }

  const mode: SyncMode = isLiveVideo(video) ? 'live' : 'vod';
  state = {
    video,
    delaySec: state?.delaySec ?? 0,
    mode,
  };
  freezeVideoFrame(video);
  startVideoClockReporting(video, mode);
  return { videoFound: true, mode };
}

export function releaseVideoHold(delaySec: number): VideoSyncResult {
  const video = state?.video ?? findMainVideo();
  if (!video) {
    return { videoFound: false, mode: 'none', reason: '未找到主视频' };
  }

  const mode: SyncMode = isLiveVideo(video) ? 'live' : 'vod';
  if (mode === 'vod') {
    video.currentTime = computeSeekTarget(video.currentTime, delaySec);
  }
  removeVideoHoldVisual();
  state = { video, delaySec, mode };
  startVideoClockReporting(video, mode);
  return { videoFound: true, mode };
}

/**
 * 开启音画同步：把主视频一次性回退 delaySec（不静音，见文件头注释）。
 * 不挂 loadeddata watchdog——大幅 seek 会触发 YouTube 缓冲并再发 loadeddata，
 * 若在回调里再次回退就会无限向后循环。故仅做一次性对齐。
 */
export function enableVideoSync(delaySec: number): VideoSyncResult {
  disableVideoSync();
  const video = findMainVideo();
  if (!video) {
    return { videoFound: false, mode: 'none', reason: '未找到主视频' };
  }
  const mode = applyDelay(video, delaySec);
  state = { video, delaySec, mode };
  startVideoClockReporting(video, mode);
  return { videoFound: true, mode };
}

/** 自动测得延迟后重对齐：相对当前再调整差值（避免累计回退）。 */
export function reapplyVideoSync(delaySec: number): VideoSyncResult {
  if (state && state.mode === 'vod') {
    const diff = delaySec - state.delaySec;
    state.video.currentTime = computeSeekTarget(state.video.currentTime, diff);
    state.delaySec = delaySec;
    startVideoClockReporting(state.video, state.mode);
    return { videoFound: true, mode: 'vod' };
  }
  return enableVideoSync(delaySec);
}

export function applyDynamicVideoSyncControl(targetDelaySec: number): DynamicVideoSyncResult {
  const normalizedTargetDelaySec = clampDynamicDelaySec(targetDelaySec);
  if (!state) {
    const result = enableVideoSync(normalizedTargetDelaySec);
    return {
      ...result,
      action: result.videoFound ? 'enable' : 'none',
      targetDelaySec: normalizedTargetDelaySec,
    };
  }

  const previousDelaySec = state.delaySec;
  const diffSec = normalizedTargetDelaySec - previousDelaySec;
  if (Math.abs(diffSec) < DYNAMIC_SYNC_IGNORE_DRIFT_SEC) {
    state.delaySec = normalizedTargetDelaySec;
    return {
      videoFound: true,
      mode: state.mode,
      action: 'none',
      targetDelaySec: normalizedTargetDelaySec,
      previousDelaySec,
      diffSec,
    };
  }

  if (state.mode === 'live') {
    suppressVideoStoppedUntil = Date.now() + Math.abs(diffSec) * 1000 + 500;
    state.video.pause();
    window.setTimeout(() => {
      void state?.video.play().catch(() => undefined);
    }, Math.max(0, diffSec) * 1000);
    state.delaySec = normalizedTargetDelaySec;
    return {
      videoFound: true,
      mode: 'live',
      action: 'live-buffer',
      targetDelaySec: normalizedTargetDelaySec,
      previousDelaySec,
      diffSec,
      durationMs: Math.max(0, Math.round(diffSec * 1000)),
    };
  }

  if (Math.abs(diffSec) <= DYNAMIC_SYNC_RATE_DRIFT_LIMIT_SEC) {
    const { playbackRate, durationMs } = nudgePlaybackRate(state.video, diffSec);
    state.delaySec = normalizedTargetDelaySec;
    return {
      videoFound: true,
      mode: 'vod',
      action: 'rate',
      targetDelaySec: normalizedTargetDelaySec,
      previousDelaySec,
      diffSec,
      playbackRate,
      durationMs,
    };
  }

  clearPlaybackRateNudge();
  state.video.playbackRate = 1;
  state.video.currentTime = computeSeekTarget(state.video.currentTime, diffSec);
  state.delaySec = normalizedTargetDelaySec;
  return {
    videoFound: true,
    mode: 'vod',
    action: 'seek',
    targetDelaySec: normalizedTargetDelaySec,
    previousDelaySec,
    diffSec,
  };
}

/** 关闭音画同步：保留当前播放位置（不前进视频）。 */
export function disableVideoSync(): void {
  suppressVideoStoppedUntil = 0;
  clearPlaybackRateNudge();
  removeVideoHoldVisual();
  if (state?.video) {
    state.video.playbackRate = 1;
  }
  stopVideoClockReporting();
  state = null;
}

/** 是否同步中。 */
export function isVideoSyncActive(): boolean {
  return state !== null;
}

/** 主视频是否正在播放（用于自动同传）。 */
function isMainVideoPlaying(): boolean {
  const v = findMainVideo();
  return !!v && !v.paused && !v.ended && v.readyState > 2;
}

/**
 * 监听页面视频「开始播放」→ 通知 popup（自动同传用）。
 * 节流：每个播放事件最多 1.5s 上报一次，避免 seek/缓冲反复触发。
 */
function initVideoPlayingNotifier(): void {
  let lastSent = 0;
  const notify = (): void => {
    const now = Date.now();
    if (now - lastSent < 1500) return;
    if (!isMainVideoPlaying()) return;
    lastSent = now;
    try {
      chrome.runtime.sendMessage({ type: 'simulcast:videoPlaying' });
    } catch {
      // popup 未打开/上下文失效：忽略
    }
  };
  // 捕获阶段监听所有 <video> 的 play（含动态插入的）
  document.addEventListener('play', notify, true);
}

function sendVideoStopped(reason: 'pause' | 'ended' | 'pagehide'): void {
  const now = Date.now();
  if (now < suppressVideoStoppedUntil) return;
  if (now - lastVideoStoppedSentAt < 500) return;
  lastVideoStoppedSentAt = now;
  disableVideoSync();
  try {
    chrome.runtime.sendMessage({
      type: 'simulcast:videoStopped',
      reason,
      url: window.location.href,
    });
  } catch {
    // 页面正在卸载或扩展上下文失效：尽力通知即可。
  }
}

function isRelevantVideo(video: HTMLVideoElement): boolean {
  return state?.video === video || findMainVideo() === video;
}

function initVideoLifecycleNotifier(): void {
  if (videoLifecycleNotifierInitialized) return;
  videoLifecycleNotifierInitialized = true;

  document.addEventListener(
    'pause',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLVideoElement) || !isRelevantVideo(target)) return;
      sendVideoStopped('pause');
    },
    true
  );
  document.addEventListener(
    'ended',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLVideoElement) || !isRelevantVideo(target)) return;
      sendVideoStopped('ended');
    },
    true
  );
  window.addEventListener('pagehide', () => sendVideoStopped('pagehide'));
  window.addEventListener('beforeunload', () => sendVideoStopped('pagehide'));
}

/**
 * 上报视频拖动位置（seeked）：独立于同传会话生命周期，停掉同传/暂停后仍上报，
 * 让 popup 的转写面板/字幕随拖动跟随当前帧（rVFC 仅在播放时触发，无法覆盖暂停拖动）。
 */
function initVideoScrubReporter(): void {
  if (scrubReporterInitialized) return;
  scrubReporterInitialized = true;
  document.addEventListener(
    'seeked',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLVideoElement) || !isRelevantVideo(target)) return;
      const now = Date.now();
      if (now - lastScrubSentAt < 150) return;
      lastScrubSentAt = now;
      try {
        chrome.runtime.sendMessage({
          type: 'simulcast:videoClock',
          url: window.location.href,
          mediaTime: target.currentTime,
          currentTime: target.currentTime,
          playbackRate: target.playbackRate,
          paused: target.paused,
          ended: target.ended,
        });
      } catch {
        // popup/background 未打开或上下文失效：忽略
      }
    },
    true
  );
}

/** 注册 simulcast:syncVideo / queryVideoPlaying 监听 + 播放通知（仅顶层页面调用）。 */
export function initSimulcastVideoSyncListener(): void {
  initVideoPlayingNotifier();
  initVideoLifecycleNotifier();
  initVideoScrubReporter();
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'simulcast:queryVideoPlaying') {
      sendResponse({ status: 'ok', playing: isMainVideoPlaying() });
      return true;
    }
    if (message?.type === 'simulcast:dynamicVideoSync') {
      try {
        const targetDelaySec =
          typeof message.targetDelaySec === 'number' ? message.targetDelaySec : 0;
        if (message.releaseHold) {
          const result = releaseVideoHold(targetDelaySec);
          sendResponse({
            status: 'ok',
            ...result,
            action: result.videoFound ? 'release' : 'none',
            targetDelaySec,
          });
        } else {
          sendResponse({ status: 'ok', ...applyDynamicVideoSyncControl(targetDelaySec) });
        }
      } catch (error) {
        sendResponse({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (!message || message.type !== 'simulcast:syncVideo') {
      return undefined;
    }
    try {
      if (message.enabled) {
        const delaySec = typeof message.delaySec === 'number' ? message.delaySec : 3;
        let result: VideoSyncResult;
        if (message.holdUntilAudio) {
          result = holdVideoUntilTranslatedAudio();
        } else if (message.releaseHold) {
          result = releaseVideoHold(delaySec);
        } else {
          result = isVideoSyncActive()
            ? reapplyVideoSync(delaySec)
            : enableVideoSync(delaySec);
        }
        sendResponse({ status: 'ok', videoCount: countVideos(), ...result });
      } else {
        disableVideoSync();
        sendResponse({ status: 'ok', videoFound: true, mode: 'none' });
      }
    } catch (error) {
      sendResponse({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  });
}
