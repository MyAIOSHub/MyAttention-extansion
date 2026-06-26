export type SimulcastVideoSyncMode =
  | 'fallback-page-video'
  | 'strict-delayed-player'
  | 'subtitles-only';

export const DEFAULT_SIMULCAST_VIDEO_SYNC_MODE: SimulcastVideoSyncMode =
  'fallback-page-video';

export const SIMULCAST_STRICT_PLAYER_CHANNEL_PREFIX =
  'sayso:simulcast:strict-player:';

export function normalizeSimulcastVideoSyncMode(
  value: unknown
): SimulcastVideoSyncMode {
  return value === 'strict-delayed-player' || value === 'subtitles-only'
    ? value
    : DEFAULT_SIMULCAST_VIDEO_SYNC_MODE;
}

export function getSimulcastStrictPlayerChannel(sessionId: string): string {
  return `${SIMULCAST_STRICT_PLAYER_CHANNEL_PREFIX}${sessionId}`;
}
