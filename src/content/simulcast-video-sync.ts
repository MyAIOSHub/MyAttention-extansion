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

interface SyncState {
  video: HTMLVideoElement;
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

/** 开启音画同步：延迟主视频（不静音，见文件头注释）。重复调用先还原再应用。 */
export function enableVideoSync(delaySec: number): VideoSyncResult {
  disableVideoSync();
  const video = findMainVideo();
  if (!video) {
    return { videoFound: false, mode: 'none', reason: '未找到主视频' };
  }
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

/** 关闭音画同步：清理监听（不前进视频，保留当前位置）。 */
export function disableVideoSync(): void {
  if (!state) return;
  state.cleanup();
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

/** 注册 simulcast:syncVideo / queryVideoPlaying 监听 + 播放通知（仅顶层页面调用）。 */
export function initSimulcastVideoSyncListener(): void {
  initVideoPlayingNotifier();
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'simulcast:queryVideoPlaying') {
      sendResponse({ status: 'ok', playing: isMainVideoPlaying() });
      return true;
    }
    if (!message || message.type !== 'simulcast:syncVideo') {
      return undefined;
    }
    try {
      if (message.enabled) {
        const delaySec = typeof message.delaySec === 'number' ? message.delaySec : 3;
        const result = isVideoSyncActive()
          ? reapplyVideoSync(delaySec)
          : enableVideoSync(delaySec);
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
