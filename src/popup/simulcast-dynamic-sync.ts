export type SimulcastDynamicSyncConfidence = 'warming' | 'stable';

export interface SimulcastDynamicSyncState {
  sourceAnchorsWallMs: number[];
  latencySamples: Array<{ observedAtMs: number; latencySec: number }>;
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
const LATENCY_WINDOW_MS = 60_000;
const TARGET_DELAY_MARGIN_SEC = 0.2;
const DELAY_DECREASE_ALPHA = 0.25;

export function createSimulcastDynamicSyncState(): SimulcastDynamicSyncState {
  return {
    sourceAnchorsWallMs: [],
    latencySamples: [],
    currentDelaySec: null,
    sampleCount: 0,
  };
}

export function resetSimulcastDynamicSyncState(state: SimulcastDynamicSyncState): void {
  state.sourceAnchorsWallMs = [];
  state.latencySamples = [];
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
  const measuredDelaySec = Math.max(0, (wallTimeMs - sourceWallMs) / 1000);
  const rawDelaySec = roundDelaySec(clampDelaySec(measuredDelaySec));
  state.latencySamples.push({ observedAtMs: wallTimeMs, latencySec: measuredDelaySec });
  state.latencySamples = state.latencySamples.filter(
    (sample) => wallTimeMs - sample.observedAtMs <= LATENCY_WINDOW_MS
  );

  const targetFromP95 = roundDelaySec(
    clampDelaySec(percentile95(state.latencySamples.map((sample) => sample.latencySec)) + TARGET_DELAY_MARGIN_SEC)
  );
  const targetFromLatest = roundDelaySec(
    clampDelaySec(measuredDelaySec + TARGET_DELAY_MARGIN_SEC)
  );
  let targetDelaySec = targetFromP95;
  if (state.currentDelaySec !== null) {
    if (targetFromP95 > state.currentDelaySec) {
      targetDelaySec = targetFromP95;
    } else if (targetFromLatest < state.currentDelaySec) {
      targetDelaySec = roundDelaySec(
        clampDelaySec(
          state.currentDelaySec +
            (targetFromLatest - state.currentDelaySec) * DELAY_DECREASE_ALPHA
        )
      );
    } else {
      targetDelaySec = state.currentDelaySec;
    }
  }

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

function percentile95(values: number[]): number {
  if (values.length === 0) {
    return MIN_SYNC_DELAY_SEC;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}
