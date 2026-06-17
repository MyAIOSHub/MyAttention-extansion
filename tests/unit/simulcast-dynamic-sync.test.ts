import { describe, expect, it } from 'vitest';

import {
  createSimulcastDynamicSyncState,
  observeSourceSubtitleAnchor,
  observeTranslatedAudioPlayback,
} from '@/popup/simulcast-dynamic-sync';

describe('simulcast dynamic sync estimator', () => {
  it('updates the target delay from successive source/audio anchors', () => {
    const state = createSimulcastDynamicSyncState();

    observeSourceSubtitleAnchor(state, 1_000);
    const first = observeTranslatedAudioPlayback(state, 3_200);

    observeSourceSubtitleAnchor(state, 5_000);
    const second = observeTranslatedAudioPlayback(state, 7_600);

    expect(first).toMatchObject({
      rawDelaySec: 2.2,
      targetDelaySec: 2.2,
      sampleCount: 1,
      confidence: 'warming',
    });
    expect(second).toMatchObject({
      rawDelaySec: 2.6,
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
});
