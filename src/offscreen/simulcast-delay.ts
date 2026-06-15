export const MAX_SIMULCAST_PLAYBACK_DELAY_MS = 5000;

export function normalizeSimulcastPlaybackDelayMs(value: unknown): number {
  const numberValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(numberValue)) {
    return 0;
  }

  return Math.min(
    MAX_SIMULCAST_PLAYBACK_DELAY_MS,
    Math.max(0, Math.round(numberValue))
  );
}
