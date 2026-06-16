/**
 * 同声传译音画同步：把页面主视频延迟 N 秒并静音原声，使其与滞后的译音对齐。
 * 译音天然滞后 N（AST 翻译+TTS），无法追上实时画面 → 只能延迟视频来对齐。
 *
 * - 点播(VOD)：currentTime 回退 N 秒。
 * - 直播(live)：暂停缓冲 N 秒后续播（退到 live edge 之后 N）。
 * 内容脚本运行在页面里，直接控制 <video>；译音由 offscreen 实时播放。
 */

export type SyncMode = 'vod' | 'live' | 'none';

export interface VideoSyncResult {
  videoFound: boolean;
  mode: SyncMode;
  reason?: string;
}

interface SyncState {
  video: HTMLVideoElement;
  origMuted: boolean;
  delaySec: number;
  mode: SyncMode;
  cleanup: () => void;
}

let state: SyncState | null = null;

/** 直播判定：duration 非有限或为 0（HLS live 等）。 */
export function isLiveVideo(video: Pick<HTMLVideoElement, 'duration'>): boolean {
  return !Number.isFinite(video.duration) || video.duration === 0;
}

/** 计算 VOD 回退后的目标位置（夹在 0 以上）。 */
export function computeSeekTarget(currentTime: number, delaySec: number): number {
  return Math.max(0, currentTime - Math.max(0, delaySec));
}

/** 选取主视频：可见、在播就绪、面积最大的 <video>。 */
export function findMainVideo(): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  document.querySelectorAll('video').forEach((video) => {
    const rect = video.getBoundingClientRect();
    const area = rect.width * rect.height;
    const onScreen = rect.bottom > 0 && rect.top < window.innerHeight;
    if (area > 10000 && onScreen && video.readyState > 0 && area > bestArea) {
      best = video;
      bestArea = area;
    }
  });
  return best;
}

function applyDelay(video: HTMLVideoElement, delaySec: number): SyncMode {
  if (isLiveVideo(video)) {
    video.pause();
    window.setTimeout(() => {
      void video.play().catch(() => undefined);
    }, Math.max(0, delaySec) * 1000);
    return 'live';
  }
  video.currentTime = computeSeekTarget(video.currentTime, delaySec);
  return 'vod';
}

/** 开启音画同步：静音原声 + 延迟主视频。重复调用先还原再应用。 */
export function enableVideoSync(delaySec: number): VideoSyncResult {
  disableVideoSync();
  const video = findMainVideo();
  if (!video) {
    return { videoFound: false, mode: 'none', reason: '未找到主视频' };
  }
  const origMuted = video.muted;
  video.muted = true;
  const mode = applyDelay(video, delaySec);

  // watchdog：换源/重新播放后重对齐（VOD）
  const onPlay = (): void => {
    if (state && state.mode === 'vod') {
      video.currentTime = computeSeekTarget(video.currentTime, state.delaySec);
    }
  };
  video.addEventListener('loadeddata', onPlay);
  state = {
    video,
    origMuted,
    delaySec,
    mode,
    cleanup: () => video.removeEventListener('loadeddata', onPlay),
  };
  return { videoFound: true, mode };
}

/** 自动测得延迟后重对齐：相对当前再调整差值（避免累计回退）。 */
export function reapplyVideoSync(delaySec: number): VideoSyncResult {
  if (state && state.mode === 'vod') {
    const diff = delaySec - state.delaySec;
    state.video.currentTime = computeSeekTarget(state.video.currentTime, diff);
    state.delaySec = delaySec;
    return { videoFound: true, mode: 'vod' };
  }
  return enableVideoSync(delaySec);
}

/** 关闭音画同步：还原静音，清理监听（不前进视频，保留当前位置）。 */
export function disableVideoSync(): void {
  if (!state) return;
  state.cleanup();
  state.video.muted = state.origMuted;
  state = null;
}

/** 是否同步中。 */
export function isVideoSyncActive(): boolean {
  return state !== null;
}

/** 注册 simulcast:syncVideo 监听（仅顶层页面调用）。 */
export function initSimulcastVideoSyncListener(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'simulcast:syncVideo') {
      return undefined;
    }
    try {
      if (message.enabled) {
        const delaySec = typeof message.delaySec === 'number' ? message.delaySec : 3;
        const result = isVideoSyncActive()
          ? reapplyVideoSync(delaySec)
          : enableVideoSync(delaySec);
        sendResponse({ status: 'ok', ...result });
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
