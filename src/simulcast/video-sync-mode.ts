export type SimulcastVideoSyncMode =
  | 'fallback-page-video'
  | 'strict-delayed-player'
  | 'subtitles-only';

// 默认走严格延迟播放器：源继续实时喂 AST 不被倒回，另窗显示延迟画面，
// 是「音画完全锁步」唯一可行路径（页面同一个 video 无法只延画面不倒源）。
// 抓不到视频轨（DRM/无视频）时由 popup 本会话回退页面模式。
export const DEFAULT_SIMULCAST_VIDEO_SYNC_MODE: SimulcastVideoSyncMode =
  'strict-delayed-player';

export const SIMULCAST_STRICT_PLAYER_CHANNEL_PREFIX =
  'sayso:simulcast:strict-player:';

// 精准同步固定缓冲（秒）：视频帧与译音共用的主时钟缓冲，缺料时单向增长。
export const DEFAULT_STRICT_BUFFER_SEC = 5;
export const MIN_STRICT_BUFFER_SEC = 1;
export const MAX_STRICT_BUFFER_SEC = 12;

/** 归一精准同步缓冲秒数，clamp 到 [1,12]，非法回落默认 5。 */
export function normalizeStrictBufferSec(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    return DEFAULT_STRICT_BUFFER_SEC;
  }
  return Math.min(MAX_STRICT_BUFFER_SEC, Math.max(MIN_STRICT_BUFFER_SEC, n));
}

export function normalizeSimulcastVideoSyncMode(
  value: unknown
): SimulcastVideoSyncMode {
  // 保留全部三个合法值；仅对非法/缺省输入回落默认。
  // （默认已改 strict，故不能再把 'fallback-page-video' 当非法漏掉，否则手选标准同步会被错误归一成 strict。）
  return value === 'strict-delayed-player' ||
    value === 'subtitles-only' ||
    value === 'fallback-page-video'
    ? value
    : DEFAULT_SIMULCAST_VIDEO_SYNC_MODE;
}

export function getSimulcastStrictPlayerChannel(sessionId: string): string {
  return `${SIMULCAST_STRICT_PLAYER_CHANNEL_PREFIX}${sessionId}`;
}
