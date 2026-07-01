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

function makeAudioContextQueue(durations: number[] = [0.4, 0.4, 0.7, 0.7, 0.7]) {
  const sources: FakeBufferSource[] = [];
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  let nextTimerId = 1;
  const decodedDurations = [...durations];
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
    performanceNow: () => 5_000,
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

describe('TranslatedAudioPlaybackQueue master-clock mode', () => {
  it('schedules at source-wall-origin + fixed buffer (locked to video frames)', async () => {
    const { queue, sources } = makeAudioContextQueue();
    // wall→ctx 映射（fake getOutputTimestamp）：ctx = 10 + (wall - 5000)/1000
    queue.setSourceTimeline({ originWallMs: 5000, bufferMs: 2000 });
    queue.enqueue({
      segmentId: 1,
      chunks: [new Uint8Array([1])],
      getVolume: () => 1,
      delayMs: 0,
      sourceStartPts: 4,
      sourceEndPts: 4.4,
    });
    await queue.waitUntilIdle();
    // targetWall = 5000 + 4*1000 + 2000 = 11000 → ctx = 10 + 6 = 16
    expect(sources[0].start).toHaveBeenCalledWith(16);
  });

  it('grows the buffer and notifies the relay when a segment lands late', async () => {
    const { queue, sources } = makeAudioContextQueue();
    const grows: number[] = [];
    queue.setSourceTimeline({ originWallMs: 5000, bufferMs: 0, onBufferChange: (s) => grows.push(s) });
    // 两段都锚到同一源时间(pts=0)；第一段占住时间线，第二段被迫排到其后 → shortfall → 缓冲增长。
    queue.enqueue({ segmentId: 1, chunks: [new Uint8Array([1])], getVolume: () => 1, delayMs: 0, sourceStartPts: 0, sourceEndPts: 0 });
    queue.enqueue({ segmentId: 2, chunks: [new Uint8Array([2])], getVolume: () => 1, delayMs: 0, sourceStartPts: 0, sourceEndPts: 0 });
    await queue.waitUntilIdle();
    // 第一段 dur 0.4 → lastEnd 10.4；第二段理想 ctx=10，被钳到 10.4 → shortfall 0.4s → 缓冲增至 0.4s。
    expect(sources[0].start).toHaveBeenCalledWith(10);
    expect(sources[1].start).toHaveBeenCalledWith(10.4);
    expect(grows).toHaveLength(1);
    expect(grows[0]).toBeCloseTo(0.4, 5);
  });

  it('boosts playback rate (bounded) in master mode when backlog accumulates', async () => {
    const { queue, sources } = makeAudioContextQueue();
    queue.setSourceTimeline({ originWallMs: 5000, bufferMs: 0 });
    for (let id = 1; id <= 3; id += 1) {
      queue.enqueue({ segmentId: id, chunks: [new Uint8Array([id])], getVolume: () => 1, delayMs: 0, sourceStartPts: 0, sourceEndPts: 0 });
    }
    await queue.waitUntilIdle();
    // 首段无积压 → 基础倍速；后续队尾领先理想点 → 排水加速，但封顶 1.25x（保音高在可接受范围）。
    expect(sources[0].playbackRate.value).toBe(1);
    expect(sources[2].playbackRate.value).toBeGreaterThan(1);
    expect(sources.every((s) => s.playbackRate.value <= 1.25 + 1e-9)).toBe(true);
  });

  it('caps the drain playback rate at 1.25x under heavy backlog', async () => {
    // 每段译音 2s，同一源时刻 → 队尾迅速领先 → backlog>1s → 倍速本应 >1.25，被封顶。
    const { queue, sources } = makeAudioContextQueue([2, 2, 2]);
    queue.setSourceTimeline({ originWallMs: 5000, bufferMs: 0 });
    for (let id = 1; id <= 3; id += 1) {
      queue.enqueue({ segmentId: id, chunks: [new Uint8Array([id])], getVolume: () => 1, delayMs: 0, sourceStartPts: 0, sourceEndPts: 0 });
    }
    await queue.waitUntilIdle();
    expect(sources[2].playbackRate.value).toBeCloseTo(1.25, 5);
  });

  it('shrinks the grown buffer back toward base once segments schedule on time', async () => {
    // 全段 0.4s。base=2s。先用一段几乎贴脸的 pts 制造 shortfall → 缓冲增长；
    // 再喂一段 pts 大幅前进的准点段 → 队尾落后理想点 → 缓冲收缩，relay 同步缩。
    const { queue } = makeAudioContextQueue([0.4, 0.4, 0.4]);
    const changes: number[] = [];
    queue.setSourceTimeline({ originWallMs: 5000, bufferMs: 2000, onBufferChange: (s) => changes.push(s) });
    queue.enqueue({ segmentId: 1, chunks: [new Uint8Array([1])], getVolume: () => 1, delayMs: 0, sourceStartPts: 0, sourceEndPts: 0.4 });
    queue.enqueue({ segmentId: 2, chunks: [new Uint8Array([2])], getVolume: () => 1, delayMs: 0, sourceStartPts: 0.1, sourceEndPts: 0.5 });
    queue.enqueue({ segmentId: 3, chunks: [new Uint8Array([3])], getVolume: () => 1, delayMs: 0, sourceStartPts: 1, sourceEndPts: 1.4 });
    await queue.waitUntilIdle();
    // 第2段晚到 → 增长(>2.0)；第3段准点 → 收缩(< 上一次增长值)。
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(changes[0]).toBeGreaterThan(2);
    expect(changes[changes.length - 1]).toBeLessThan(changes[0]);
    expect(changes[changes.length - 1]).toBeGreaterThanOrEqual(2);
  });

  it('falls back to sequential (no master target, no grow) when a segment lacks sourceStartPts', async () => {
    const { queue, sources } = makeAudioContextQueue();
    const grows: number[] = [];
    queue.setSourceTimeline({ originWallMs: 5000, bufferMs: 2000, onBufferChange: (s) => grows.push(s) });
    queue.enqueue({ segmentId: 1, chunks: [new Uint8Array([1])], getVolume: () => 1, delayMs: 0 });
    await queue.waitUntilIdle();
    expect(sources).toHaveLength(1);
    expect(grows).toEqual([]);
  });

  it('uses the currentTime/performanceNow fallback when getOutputTimestamp is missing', async () => {
    const sources: FakeBufferSource[] = [];
    const timers = new Map<number, { callback: () => void; delayMs: number }>();
    let nextTimerId = 1;
    const context = {
      currentTime: 10,
      destination: {},
      decodeAudioData: vi.fn().mockResolvedValue(new FakeAudioBuffer(0.4)),
      createBufferSource: vi.fn().mockImplementation(() => {
        const s = new FakeBufferSource();
        sources.push(s);
        return s;
      }),
      createGain: vi.fn().mockImplementation(() => new FakeGainNode()),
      // 无 getOutputTimestamp → 走 currentTime + (wall - performanceNow)/1000 兜底
    };
    const queue = new TranslatedAudioPlaybackQueue({
      audioContext: context as unknown as AudioContext,
      setTimeout: (cb, delayMs) => {
        const id = nextTimerId++;
        timers.set(id, { callback: cb, delayMs });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
      now: () => 1_000,
      performanceNow: () => 5_000,
    });
    queue.setSourceTimeline({ originWallMs: 5000, bufferMs: 2000 });
    queue.enqueue({ segmentId: 1, chunks: [new Uint8Array([1])], getVolume: () => 1, delayMs: 0, sourceStartPts: 4, sourceEndPts: 4.4 });
    await queue.waitUntilIdle();
    // 兜底映射与 getOutputTimestamp 同结果：ctx = 10 + (11000-5000)/1000 = 16
    expect(sources[0].start).toHaveBeenCalledWith(16);
  });
});

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
