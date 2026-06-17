export type SimulcastDynamicSyncConfidence = 'warming' | 'stable';

export interface SimulcastDynamicSyncState {
  sourceAnchorsWallMs: number[];
  currentDelaySec: number | null;
  sampleCount: number;
}

export interface SimulcastDynamicSyncSample {
  sourceWallMs: number;
  audioPlaybackWallMs: number;
  rawDelaySec: number;
  targetDelaySec: number;
  sampleCount: number;
  confidence: SimulcastDynamicSyncConfidence;
}

const MIN_SYNC_DELAY_SEC = 1;
const MAX_SYNC_DELAY_SEC = 8;
const MAX_SOURCE_ANCHORS = 8;
const SMOOTHING_ALPHA = 0.35;

export function createSimulcastDynamicSyncState(): SimulcastDynamicSyncState {
  return {
    sourceAnchorsWallMs: [],
    currentDelaySec: null,
    sampleCount: 0,
  };
}

export function resetSimulcastDynamicSyncState(state: SimulcastDynamicSyncState): void {
  state.sourceAnchorsWallMs = [];
  state.currentDelaySec = null;
  state.sampleCount = 0;
}

export function observeSourceSubtitleAnchor(
  state: SimulcastDynamicSyncState,
  wallTimeMs: number
): void {
  if (!Number.isFinite(wallTimeMs)) {
    return;
  }
  state.sourceAnchorsWallMs.push(wallTimeMs);
  if (state.sourceAnchorsWallMs.length > MAX_SOURCE_ANCHORS) {
    state.sourceAnchorsWallMs = state.sourceAnchorsWallMs.slice(-MAX_SOURCE_ANCHORS);
  }
}

export function observeTranslatedAudioPlayback(
  state: SimulcastDynamicSyncState,
  wallTimeMs: number
): SimulcastDynamicSyncSample | null {
  if (!Number.isFinite(wallTimeMs) || state.sourceAnchorsWallMs.length === 0) {
    return null;
  }

  const sourceWallMs = state.sourceAnchorsWallMs.shift()!;
  const rawDelaySec = roundDelaySec(clampDelaySec((wallTimeMs - sourceWallMs) / 1000));
  const targetDelaySec =
    state.currentDelaySec === null
      ? rawDelaySec
      : roundDelaySec(
          clampDelaySec(
            state.currentDelaySec + (rawDelaySec - state.currentDelaySec) * SMOOTHING_ALPHA
          )
        );

  state.currentDelaySec = targetDelaySec;
  state.sampleCount += 1;

  return {
    sourceWallMs,
    audioPlaybackWallMs: wallTimeMs,
    rawDelaySec,
    targetDelaySec,
    sampleCount: state.sampleCount,
    confidence: state.sampleCount >= 2 ? 'stable' : 'warming',
  };
}

function clampDelaySec(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_SYNC_DELAY_SEC;
  }
  return Math.min(MAX_SYNC_DELAY_SEC, Math.max(MIN_SYNC_DELAY_SEC, value));
}

function roundDelaySec(value: number): number {
  return Math.round(value * 10) / 10;
}
