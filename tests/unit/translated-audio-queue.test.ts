import { describe, expect, it, vi } from 'vitest';

import { TranslatedAudioPlaybackQueue } from '@/offscreen/translated-audio-queue';

class FakeAudioBuffer {
  constructor(readonly duration: number) {}
}

class FakeBufferSource {
  buffer: FakeAudioBuffer | null = null;
  onended: (() => void) | null = null;
  playbackRate = { value: 1 };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn();

  end(): void {
    this.onended?.();
  }
}

class FakeGainNode {
  gain = { value: 1 };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

function makeAudioContextQueue() {
  const sources: FakeBufferSource[] = [];
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  let nextTimerId = 1;
  const decodedDurations = [0.4, 0.4, 0.7, 0.7, 0.7];
  const context = {
    currentTime: 10,
    destination: {},
    outputLatency: 0.03,
    decodeAudioData: vi.fn().mockImplementation(async () => {
      return new FakeAudioBuffer(decodedDurations.shift() ?? 0.4);
    }),
    createBufferSource: vi.fn().mockImplementation(() => {
      const source = new FakeBufferSource();
      sources.push(source);
      return source;
    }),
    createGain: vi.fn().mockImplementation(() => new FakeGainNode()),
    getOutputTimestamp: vi.fn(() => ({ contextTime: context.currentTime, performanceTime: 5_000 })),
  };

  const queue = new TranslatedAudioPlaybackQueue({
    audioContext: context as unknown as AudioContext,
    setTimeout: (callback, delayMs) => {
      const id = nextTimerId++;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    now: () => 1_000,
  });

  return { context, queue, sources, timers };
}

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
  it('schedules decoded translated audio on the AudioContext source timeline', async () => {
    const { context, queue, sources, timers } = makeAudioContextQueue();
    const events: unknown[] = [];

    queue.enqueue({
      segmentId: 1,
      chunks: [new Uint8Array([1])],
      getVolume: () => 1,
      delayMs: 2_000,
      sourceStartPts: 4,
      sourceEndPts: 4.4,
      receivedAtMs: 900,
      onTranslatedAudio: (event) => events.push(event),
    });
    queue.enqueue({
      segmentId: 2,
      chunks: [new Uint8Array([2])],
      getVolume: () => 1,
      delayMs: 2_000,
      sourceStartPts: 4.4,
      sourceEndPts: 4.8,
      receivedAtMs: 950,
      onTranslatedAudio: (event) => events.push(event),
    });

    await queue.waitUntilIdle();

    expect(context.decodeAudioData).toHaveBeenCalledTimes(2);
    expect(sources).toHaveLength(2);
    expect(sources[0].start).toHaveBeenCalledWith(12);
    expect(sources[1].start).toHaveBeenCalledWith(12.4);
    expect(Array.from(timers.values()).map((timer) => timer.delayMs)).toEqual([2000, 2400]);
    expect(events).toEqual([
      expect.objectContaining({
        event: 'playback-scheduled',
        segmentId: 1,
        sourceStartPts: 4,
        scheduledAtContextTime: 12,
        outputLatencySec: 0.03,
      }),
      expect.objectContaining({
        event: 'playback-scheduled',
        segmentId: 2,
        sourceStartPts: 4.4,
        scheduledAtContextTime: 12.4,
        outputLatencySec: 0.03,
      }),
    ]);
  });

  it('uses queued duration instead of segment count for AudioContext backlog catch-up', async () => {
    const { queue, sources } = makeAudioContextQueue();

    queue.enqueue({
      segmentId: 1,
      chunks: [new Uint8Array([1])],
      getVolume: () => 1,
      delayMs: 0,
      sourceStartPts: 0,
      sourceEndPts: 0.7,
    });
    queue.enqueue({
      segmentId: 2,
      chunks: [new Uint8Array([2])],
      getVolume: () => 1,
      delayMs: 0,
      sourceStartPts: 0.7,
      sourceEndPts: 1.4,
    });
    queue.enqueue({
      segmentId: 3,
      chunks: [new Uint8Array([3])],
      getVolume: () => 1,
      delayMs: 0,
      sourceStartPts: 1.4,
      sourceEndPts: 2.1,
    });

    await queue.waitUntilIdle();

    expect(queue.queuedDurationMs).toBeGreaterThan(1000);
    expect(sources[2].playbackRate.value).toBeGreaterThan(1);
  });

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

  it('applies the base playback rate immediately even with no backlog', () => {
    const { audios, queue } = makeQueue();
    queue.setBasePlaybackRate(1.5);

    queue.enqueue({
      segmentId: 1,
      chunks: [new Uint8Array([1])],
      getVolume: () => 1,
      delayMs: 0,
    });

    // 无积压也按用户设定的基础倍速播放（即时生效）
    expect(audios[0].playbackRate).toBeCloseTo(1.5, 5);
  });

  it('updates the currently playing clip when the base rate changes live', () => {
    const { audios, queue } = makeQueue();
    queue.enqueue({
      segmentId: 1,
      chunks: [new Uint8Array([1])],
      getVolume: () => 1,
      delayMs: 0,
    });
    expect(audios[0].playbackRate).toBe(1);

    queue.setBasePlaybackRate(1.4);
    expect(audios[0].playbackRate).toBeCloseTo(1.4, 5);
  });

  it('honors a base rate below 1.0 (slow playback) with no backlog', () => {
    const { audios, queue } = makeQueue();
    queue.setBasePlaybackRate(0.5);

    queue.enqueue({
      segmentId: 1,
      chunks: [new Uint8Array([1])],
      getVolume: () => 1,
      delayMs: 0,
    });

    // 0.5x 不被积压加速掩盖（无积压）→ 即时放慢
    expect(audios[0].playbackRate).toBeCloseTo(0.5, 5);
  });

  it('adds backlog boost on top of the base rate, hard-capped at 3.0x', () => {
    const { audios, queue } = makeQueue();
    queue.setBasePlaybackRate(1);

    // 21 段：20 段排队 → 1 + 0.12*20 = 3.4，硬封顶到 3.0
    for (let id = 1; id <= 21; id += 1) {
      queue.enqueue({
        segmentId: id,
        chunks: [new Uint8Array([id])],
        getVolume: () => 1,
        delayMs: 0,
      });
    }

    expect(audios[0].playbackRate).toBeCloseTo(3, 5);
  });
});
