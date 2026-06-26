import { describe, expect, it } from 'vitest';

import {
  createSimulcastDynamicSyncState,
  observeSourceSubtitleAnchor,
  observeTranslatedAudioPlayback,
} from '@/popup/simulcast-dynamic-sync';

describe('simulcast dynamic sync estimator', () => {
  it('uses p95 latency plus margin for stable target video delay', () => {
    const state = createSimulcastDynamicSyncState();

    observeSourceSubtitleAnchor(state, 1_000);
    const first = observeTranslatedAudioPlayback(state, 3_100);

    observeSourceSubtitleAnchor(state, 5_000);
    const second = observeTranslatedAudioPlayback(state, 7_100);

    expect(first).toMatchObject({
      rawDelaySec: 2.1,
      targetDelaySec: 2.3,
      sampleCount: 1,
      confidence: 'warming',
    });
    expect(second).toMatchObject({
      rawDelaySec: 2.1,
      targetDelaySec: 2.3,
      sampleCount: 2,
      confidence: 'stable',
    });
  });

  it('waits for a source anchor before emitting a delay sample', () => {
    const state = createSimulcastDynamicSyncState();

    expect(observeTranslatedAudioPlayback(state, 3_200)).toBeNull();
  });

  it('clamps unstable delay samples into the supported sync window', () => {
    const state = createSimulcastDynamicSyncState();

    observeSourceSubtitleAnchor(state, 1_000);
    const tooSmall = observeTranslatedAudioPlayback(state, 1_200);

    observeSourceSubtitleAnchor(state, 2_000);
    const tooLarge = observeTranslatedAudioPlayback(state, 20_000);

    expect(tooSmall?.targetDelaySec).toBe(1);
    expect(tooLarge?.targetDelaySec).toBeLessThanOrEqual(8);
  });

  it('raises target delay quickly on latency spikes and decays slowly after recovery', () => {
    const state = createSimulcastDynamicSyncState();

    observeSourceSubtitleAnchor(state, 1_000);
    const stable = observeTranslatedAudioPlayback(state, 3_100);

    observeSourceSubtitleAnchor(state, 5_000);
    const spike = observeTranslatedAudioPlayback(state, 9_000);

    observeSourceSubtitleAnchor(state, 10_000);
    const recovery = observeTranslatedAudioPlayback(state, 12_100);

    expect(stable?.targetDelaySec).toBe(2.3);
    expect(spike?.targetDelaySec).toBe(4.2);
    expect(recovery?.targetDelaySec).toBeGreaterThan(2.3);
    expect(recovery?.targetDelaySec).toBeLessThan(4.2);
  });
});
