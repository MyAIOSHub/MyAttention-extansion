import { describe, expect, it, vi } from 'vitest';

import {
  PcmChunker,
  downsampleFloat32,
  floatTo16BitPcm,
} from '@/offscreen/pcm-audio';

describe('PCM audio helpers', () => {
  it('downsamples Float32 audio and clamps to signed 16-bit PCM', () => {
    const input = new Float32Array([0, 1, -1, 2, -2, 0.5]);
    const downsampled = downsampleFloat32(input, 48000, 16000);
    const pcm = floatTo16BitPcm(downsampled);

    expect([...downsampled]).toEqual([0, 2]);
    expect([...pcm]).toEqual([0, 0, 255, 127]);
  });

  it('emits fixed-size PCM chunks', () => {
    const onChunk = vi.fn();
    const chunker = new PcmChunker(4, onChunk);

    chunker.push(new Uint8Array([1, 2, 3]));
    chunker.push(new Uint8Array([4, 5, 6, 7, 8]));
    chunker.flush();

    expect(onChunk).toHaveBeenNthCalledWith(1, new Uint8Array([1, 2, 3, 4]));
    expect(onChunk).toHaveBeenNthCalledWith(2, new Uint8Array([5, 6, 7, 8]));
  });
});
