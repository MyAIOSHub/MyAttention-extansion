import { describe, expect, it, vi } from 'vitest';

import { TranslatedAudioPlaybackQueue } from '@/offscreen/translated-audio-queue';

class FakeAudio {
  onended: (() => void) | null = null;
  volume = 1;
  src = '';
  readonly play = vi.fn().mockResolvedValue(undefined);
  readonly pause = vi.fn();
  playbackRate = 1;

  constructor(readonly url: string) {
    this.src = url;
  }

  end(): void {
    this.onended?.();
  }
}

function makeQueue() {
  const audios: FakeAudio[] = [];
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;
  let objectUrlCount = 0;
  const revoked: string[] = [];

  const queue = new TranslatedAudioPlaybackQueue({
    createAudio: (url) => {
      const audio = new FakeAudio(url);
      audios.push(audio);
      return audio as unknown as HTMLAudioElement;
    },
    createObjectUrl: () => `blob:tts-${++objectUrlCount}`,
    revokeObjectUrl: (url) => revoked.push(url),
    setTimeout: (callback) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    now: () => 1_000,
  });

  return { audios, queue, revoked, timers };
}

describe('TranslatedAudioPlaybackQueue', () => {
  it('plays translated TTS segments sequentially instead of starting the next one immediately', async () => {
    const { audios, queue } = makeQueue();

    queue.enqueue({
      segmentId: 1,
      chunks: [new Uint8Array([1])],
      getVolume: () => 1,
      delayMs: 0,
    });
    queue.enqueue({
      segmentId: 2,
      chunks: [new Uint8Array([2])],
      getVolume: () => 1,
      delayMs: 0,
    });

    expect(audios).toHaveLength(1);
    expect(audios[0].play).toHaveBeenCalledTimes(1);

    audios[0].end();
    await Promise.resolve();

    expect(audios).toHaveLength(2);
    expect(audios[1].play).toHaveBeenCalledTimes(1);
  });

  it('stops queued and active translated TTS audio on explicit stop', () => {
    const { audios, queue, revoked } = makeQueue();

    queue.enqueue({
      segmentId: 1,
      chunks: [new Uint8Array([1])],
      getVolume: () => 1,
      delayMs: 0,
    });
    queue.enqueue({
      segmentId: 2,
      chunks: [new Uint8Array([2])],
      getVolume: () => 1,
      delayMs: 0,
    });

    queue.stop();

    expect(audios[0].pause).toHaveBeenCalledTimes(1);
    expect(revoked).toEqual(['blob:tts-1']);
    expect(queue.size).toBe(0);
  });

  it('does not start a delayed TTS segment after the queue is stopped', () => {
    const { audios, queue, timers } = makeQueue();

    queue.enqueue({
      segmentId: 1,
      chunks: [new Uint8Array([1])],
      getVolume: () => 1,
      delayMs: 500,
    });

    const lateTimer = Array.from(timers.values())[0];
    queue.stop();
    lateTimer();

    expect(audios).toHaveLength(0);
    expect(queue.size).toBe(0);
  });

  it('accelerates translated TTS playback proportionally to the queued backlog', async () => {
    const { audios, queue } = makeQueue();

    queue.enqueue({
      segmentId: 1,
      chunks: [new Uint8Array([1])],
      getVolume: () => 1,
      delayMs: 0,
    });

    // 无积压 → 不加速
    expect(audios[0].playbackRate).toBe(1);

    queue.enqueue({
      segmentId: 2,
      chunks: [new Uint8Array([2])],
      getVolume: () => 1,
      delayMs: 0,
    });
    queue.enqueue({
      segmentId: 3,
      chunks: [new Uint8Array([3])],
      getVolume: () => 1,
      delayMs: 0,
    });

    // 2 段在排队 → 1 + 0.12*2 = 1.24（比旧的 1.12 更激进）
    expect(audios[0].playbackRate).toBeCloseTo(1.24, 5);

    audios[0].end();
    await Promise.resolve();

    // 1 段在排队 → 1.12
    expect(audios[1].playbackRate).toBeCloseTo(1.12, 5);

    audios[1].end();
    await Promise.resolve();

    // 无积压 → 回到 1.0
    expect(audios[2].playbackRate).toBe(1);
  });

  it('caps the adaptive rate at the configured maximum and applies it live', async () => {
    const { audios, queue } = makeQueue();
    queue.setMaxPlaybackRate(1.3);

    // 排 6 段，第一段在播、后 5 段排队 → 1 + 0.12*5 = 1.6，被封顶到 1.3
    for (let id = 1; id <= 6; id += 1) {
      queue.enqueue({
        segmentId: id,
        chunks: [new Uint8Array([id])],
        getVolume: () => 1,
        delayMs: 0,
      });
    }

    expect(audios[0].playbackRate).toBeCloseTo(1.3, 5);
  });
});
