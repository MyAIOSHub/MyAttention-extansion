import { describe, expect, it } from 'vitest';

import {
  MAX_SIMULCAST_PLAYBACK_DELAY_MS,
  normalizeSimulcastPlaybackDelayMs,
} from '@/offscreen/simulcast-delay';

describe('simulcast playback delay', () => {
  it('keeps manual translated audio delay inside the supported range', () => {
    expect(normalizeSimulcastPlaybackDelayMs(undefined)).toBe(0);
    expect(normalizeSimulcastPlaybackDelayMs('bad')).toBe(0);
    expect(normalizeSimulcastPlaybackDelayMs(-100)).toBe(0);
    expect(normalizeSimulcastPlaybackDelayMs(1200)).toBe(1200);
    expect(normalizeSimulcastPlaybackDelayMs(String(MAX_SIMULCAST_PLAYBACK_DELAY_MS + 1000))).toBe(
      MAX_SIMULCAST_PLAYBACK_DELAY_MS
    );
  });
});
