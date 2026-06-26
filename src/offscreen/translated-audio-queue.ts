import { normalizeSimulcastPlaybackDelayMs } from './simulcast-delay';

export interface TranslatedAudioPlaybackEvent {
  event: 'playback-scheduled' | 'playback-started' | 'playback-ended';
  segmentId: number;
  wallTimeMs: number;
  delayMs: number;
  playbackRate: number;
  sourceStartPts?: number;
  sourceEndPts?: number;
  scheduledAtContextTime?: number;
  outputLatencySec?: number;
  queuedDurationMs?: number;
}

export interface TranslatedAudioQueueItem {
  segmentId: number;
  chunks: Uint8Array[];
  getVolume: () => number;
  delayMs: number;
  sourceStartPts?: number;
  sourceEndPts?: number;
  receivedAtMs?: number;
  codec?: string;
  durationSec?: number;
  onPlaybackStatus?: (status: { kind: 'success' | 'error' | 'info'; message: string }) => void;
  onTranslatedAudio?: (event: TranslatedAudioPlaybackEvent) => void;
}

interface QueuedTranslatedAudio extends TranslatedAudioQueueItem {
  notBeforeMs: number;
  normalizedDelayMs: number;
}

export interface TranslatedAudioPlaybackQueueDependencies {
  createAudio: (url: string) => HTMLAudioElement;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (timerId: number) => void;
  now: () => number;
  audioContext?: AudioContext | null;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.length;
  });
  return output;
}

function clampVolume(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

export const DEFAULT_BASE_PLAYBACK_RATE = 1;
const MIN_PLAYBACK_RATE = 0.5;
const HARD_MAX_PLAYBACK_RATE = 3;
const PLAYBACK_RATE_STEP_PER_BACKLOG = 0.12;
const MILD_BACKLOG_MS = 200;
const MEDIUM_BACKLOG_MS = 500;
const HARD_BACKLOG_MS = 1000;

function clampBasePlaybackRate(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_BASE_PLAYBACK_RATE;
  }
  return Math.min(HARD_MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, value));
}

/**
 * 译音播放倍速 = clamp(用户基础倍速 + 0.12×排队积压, 0.5, 3)。
 * - 基础倍速「即时生效」且可低于 1.0（放慢）：基础值始终叠加，不会被积压加速掩盖。
 * - 积压在基础之上继续加速以追回滞后，硬封顶 3.0x（保音高）。
 */
function computeAdaptivePlaybackRate(pendingSegments: number, baseRate: number): number {
  const backlogBoost = pendingSegments > 0 ? PLAYBACK_RATE_STEP_PER_BACKLOG * pendingSegments : 0;
  return Math.min(HARD_MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, baseRate + backlogBoost));
}

function computeAdaptivePlaybackRateForDuration(queuedDurationMs: number, baseRate: number): number {
  let backlogBoost = 0;
  if (queuedDurationMs > HARD_BACKLOG_MS) {
    backlogBoost = 0.5;
  } else if (queuedDurationMs > MEDIUM_BACKLOG_MS) {
    backlogBoost = 0.25;
  } else if (queuedDurationMs > MILD_BACKLOG_MS) {
    backlogBoost = 0.08;
  }
  return Math.min(HARD_MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, baseRate + backlogBoost));
}

function setAudioPlaybackRate(audio: HTMLAudioElement, playbackRate: number): void {
  audio.playbackRate = playbackRate;
  const pitchPreservingAudio = audio as HTMLAudioElement & { preservesPitch?: boolean };
  if ('preservesPitch' in pitchPreservingAudio) {
    pitchPreservingAudio.preservesPitch = true;
  }
}

export class TranslatedAudioPlaybackQueue {
  private readonly dependencies: TranslatedAudioPlaybackQueueDependencies;
  private queue: QueuedTranslatedAudio[] = [];
  private activeAudio: HTMLAudioElement | null = null;
  private activeUrl: string | null = null;
  private startTimerId: number | null = null;
  private startTimerIds: number[] = [];
  private activeSources: AudioBufferSourceNode[] = [];
  private activeGains: GainNode[] = [];
  private audioContext: AudioContext | null;
  private timelineOriginContextTime: number | null = null;
  private lastScheduledEndContextTime = 0;
  private scheduleChain: Promise<void> = Promise.resolve();
  private pendingScheduledItems = 0;
  private generation = 0;
  private basePlaybackRate = DEFAULT_BASE_PLAYBACK_RATE;

  constructor(dependencies: Partial<TranslatedAudioPlaybackQueueDependencies> = {}) {
    this.dependencies = {
      createAudio: dependencies.createAudio ?? ((url) => new Audio(url)),
      createObjectUrl: dependencies.createObjectUrl ?? ((blob) => URL.createObjectURL(blob)),
      revokeObjectUrl: dependencies.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url)),
      setTimeout:
        dependencies.setTimeout ??
        ((callback, delayMs) => window.setTimeout(callback, delayMs)),
      clearTimeout: dependencies.clearTimeout ?? ((timerId) => window.clearTimeout(timerId)),
      now: dependencies.now ?? (() => Date.now()),
      audioContext: dependencies.audioContext ?? null,
    };
    this.audioContext = this.dependencies.audioContext ?? null;
  }

  get size(): number {
    return (
      this.queue.length +
      (this.activeAudio ? 1 : 0) +
      this.activeSources.length +
      this.pendingScheduledItems
    );
  }

  get queuedDurationMs(): number {
    if (!this.audioContext) {
      return 0;
    }
    return Math.max(0, Math.round((this.lastScheduledEndContextTime - this.audioContext.currentTime) * 1000));
  }

  setAudioContext(audioContext: AudioContext | null): void {
    this.audioContext = audioContext;
    this.timelineOriginContextTime = null;
    this.lastScheduledEndContextTime = audioContext?.currentTime ?? 0;
  }

  waitUntilIdle(): Promise<void> {
    return this.scheduleChain;
  }

  enqueue(item: TranslatedAudioQueueItem): void {
    if (!item.chunks.length || item.getVolume() <= 0) {
      return;
    }

    const normalizedDelayMs = normalizeSimulcastPlaybackDelayMs(item.delayMs);
    if (normalizedDelayMs > 0) {
      item.onPlaybackStatus?.({
        kind: 'info',
        message: `译音已返回，将在 ${normalizedDelayMs}ms 后播放。`,
      });
    }

    if (this.audioContext) {
      this.enqueueAudioContextItem({ ...item, delayMs: normalizedDelayMs });
      return;
    }

    this.queue.push({
      ...item,
      normalizedDelayMs,
      notBeforeMs: this.dependencies.now() + normalizedDelayMs,
    });
    this.updateActivePlaybackRate();
    this.scheduleNext();
  }

  updateActiveVolume(volume: number): void {
    if (this.activeAudio) {
      this.activeAudio.volume = clampVolume(volume, 1);
    }
    this.activeGains.forEach((gain) => {
      gain.gain.value = clampVolume(volume, 1);
    });
  }

  /** 设置译音基础倍速（夹在 1~2），并立即应用到正在播放的片段。 */
  setBasePlaybackRate(baseRate: number | undefined): void {
    this.basePlaybackRate = clampBasePlaybackRate(baseRate);
    this.updateActivePlaybackRate();
  }

  stop(): void {
    this.generation += 1;
    this.queue = [];
    this.pendingScheduledItems = 0;
    this.timelineOriginContextTime = null;
    this.lastScheduledEndContextTime = this.audioContext?.currentTime ?? 0;
    if (this.startTimerId !== null) {
      this.dependencies.clearTimeout(this.startTimerId);
      this.startTimerId = null;
    }
    this.startTimerIds.forEach((timerId) => this.dependencies.clearTimeout(timerId));
    this.startTimerIds = [];
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // A source can throw if it already ended; stopping is best-effort cleanup.
      }
      source.disconnect();
    });
    this.activeGains.forEach((gain) => gain.disconnect());
    this.activeSources = [];
    this.activeGains = [];
    if (this.activeAudio) {
      this.activeAudio.pause();
      this.activeAudio.src = '';
    }
    this.cleanupActiveAudio();
  }

  private enqueueAudioContextItem(item: TranslatedAudioQueueItem): void {
    const generation = this.generation;
    this.pendingScheduledItems += 1;
    this.scheduleChain = this.scheduleChain
      .then(async () => {
        if (this.generation !== generation || !this.audioContext) return;
        await this.scheduleAudioContextPlayback(item, generation);
      })
      .catch((error) => {
        item.onPlaybackStatus?.({
          kind: 'error',
          message: `译音已返回，但浏览器排程失败：${error instanceof Error ? error.message : String(error)}`,
        });
      })
      .finally(() => {
        this.pendingScheduledItems = Math.max(0, this.pendingScheduledItems - 1);
      });
  }

  private async scheduleAudioContextPlayback(
    item: TranslatedAudioQueueItem,
    generation: number
  ): Promise<void> {
    const audioContext = this.audioContext;
    if (!audioContext) return;
    const volume = clampVolume(item.getVolume(), 1);
    if (volume <= 0) return;

    const audioBytes = concatChunks(item.chunks);
    const audioBuffer = new ArrayBuffer(audioBytes.byteLength);
    new Uint8Array(audioBuffer).set(audioBytes);
    const decoded = await audioContext.decodeAudioData(audioBuffer);
    if (this.generation !== generation || this.audioContext !== audioContext) return;

    const normalizedDelayMs = normalizeSimulcastPlaybackDelayMs(item.delayMs);
    const sourceStartPts = typeof item.sourceStartPts === 'number' ? item.sourceStartPts : 0;
    const sourceEndPts =
      typeof item.sourceEndPts === 'number'
        ? item.sourceEndPts
        : sourceStartPts + (item.durationSec ?? decoded.duration);

    if (this.timelineOriginContextTime === null) {
      this.timelineOriginContextTime = audioContext.currentTime - sourceStartPts;
      this.lastScheduledEndContextTime = Math.max(this.lastScheduledEndContextTime, audioContext.currentTime);
    }

    const targetContextTime =
      this.timelineOriginContextTime + sourceStartPts + normalizedDelayMs / 1000;
    const scheduledAtContextTime = Math.max(
      audioContext.currentTime,
      targetContextTime,
      this.lastScheduledEndContextTime
    );
    const queuedDurationBefore = Math.max(
      0,
      Math.round((this.lastScheduledEndContextTime - audioContext.currentTime) * 1000)
    );
    const playbackRate = computeAdaptivePlaybackRateForDuration(
      queuedDurationBefore,
      this.basePlaybackRate
    );
    const durationSec = decoded.duration / playbackRate;
    this.lastScheduledEndContextTime = scheduledAtContextTime + durationSec;

    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();
    source.buffer = decoded;
    source.playbackRate.value = playbackRate;
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(audioContext.destination);

    const outputLatencySec =
      typeof audioContext.outputLatency === 'number' && Number.isFinite(audioContext.outputLatency)
        ? audioContext.outputLatency
        : undefined;
    const queuedDurationMs = this.queuedDurationMs;
    item.onTranslatedAudio?.({
      event: 'playback-scheduled',
      segmentId: item.segmentId,
      wallTimeMs: this.contextTimeToWallTimeMs(audioContext, scheduledAtContextTime),
      delayMs: normalizedDelayMs,
      playbackRate,
      sourceStartPts,
      sourceEndPts,
      scheduledAtContextTime,
      outputLatencySec,
      queuedDurationMs,
    });

    this.activeSources.push(source);
    this.activeGains.push(gain);
    const startDelayMs = Math.max(
      0,
      Math.round((scheduledAtContextTime - audioContext.currentTime) * 1000)
    );
    const startTimerId = this.dependencies.setTimeout(() => {
      this.startTimerIds = this.startTimerIds.filter((timerId) => timerId !== startTimerId);
      if (this.generation !== generation) return;
      item.onTranslatedAudio?.({
        event: 'playback-started',
        segmentId: item.segmentId,
        wallTimeMs: this.contextTimeToWallTimeMs(audioContext, scheduledAtContextTime),
        delayMs: normalizedDelayMs,
        playbackRate,
        sourceStartPts,
        sourceEndPts,
        scheduledAtContextTime,
        outputLatencySec,
        queuedDurationMs: this.queuedDurationMs,
      });
      item.onPlaybackStatus?.({
        kind: 'success',
        message: '同声传译运行中：正在播放译音。',
      });
    }, startDelayMs);
    this.startTimerIds.push(startTimerId);

    source.onended = (): void => {
      this.activeSources = this.activeSources.filter((active) => active !== source);
      this.activeGains = this.activeGains.filter((active) => active !== gain);
      source.disconnect();
      gain.disconnect();
      if (this.generation !== generation) return;
      item.onTranslatedAudio?.({
        event: 'playback-ended',
        segmentId: item.segmentId,
        wallTimeMs: this.dependencies.now(),
        delayMs: normalizedDelayMs,
        playbackRate,
        sourceStartPts,
        sourceEndPts,
        scheduledAtContextTime,
        outputLatencySec,
        queuedDurationMs: this.queuedDurationMs,
      });
    };

    source.start(scheduledAtContextTime);
  }

  private contextTimeToWallTimeMs(audioContext: AudioContext, contextTime: number): number {
    if (typeof audioContext.getOutputTimestamp === 'function') {
      const timestamp = audioContext.getOutputTimestamp();
      if (
        typeof timestamp.contextTime === 'number' &&
        typeof timestamp.performanceTime === 'number'
      ) {
        return timestamp.performanceTime + (contextTime - timestamp.contextTime) * 1000;
      }
    }
    return this.dependencies.now() + Math.max(0, (contextTime - audioContext.currentTime) * 1000);
  }

  private scheduleNext(): void {
    if (this.activeAudio || this.startTimerId !== null) {
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      return;
    }

    const waitMs = Math.max(0, next.notBeforeMs - this.dependencies.now());
    if (waitMs > 0) {
      const generation = this.generation;
      this.startTimerId = this.dependencies.setTimeout(() => {
        this.startTimerId = null;
        if (this.generation !== generation) {
          return;
        }
        this.startPlayback(next);
      }, waitMs);
      return;
    }

    this.startPlayback(next);
  }

  private startPlayback(item: QueuedTranslatedAudio): void {
    const volume = clampVolume(item.getVolume(), 1);
    if (volume <= 0) {
      this.scheduleNext();
      return;
    }

    const audioBytes = concatChunks(item.chunks);
    const audioBuffer = new ArrayBuffer(audioBytes.byteLength);
    new Uint8Array(audioBuffer).set(audioBytes);
    const blob = new Blob([audioBuffer], { type: 'audio/ogg; codecs=opus' });
    const url = this.dependencies.createObjectUrl(blob);
    const audio = this.dependencies.createAudio(url);
    const generation = this.generation;

    audio.volume = volume;
    setAudioPlaybackRate(audio, computeAdaptivePlaybackRate(this.queue.length, this.basePlaybackRate));
    audio.onended = (): void => {
      if (this.activeAudio !== audio || this.generation !== generation) return;
      item.onTranslatedAudio?.({
        event: 'playback-ended',
        segmentId: item.segmentId,
        wallTimeMs: this.dependencies.now(),
        delayMs: item.normalizedDelayMs,
        playbackRate: audio.playbackRate,
      });
      this.cleanupActiveAudio();
      this.scheduleNext();
    };

    this.activeAudio = audio;
    this.activeUrl = url;
    void audio
      .play()
      .then(() => {
        if (this.activeAudio !== audio || this.generation !== generation) return;
        item.onTranslatedAudio?.({
          event: 'playback-started',
          segmentId: item.segmentId,
          wallTimeMs: this.dependencies.now(),
          delayMs: item.normalizedDelayMs,
          playbackRate: audio.playbackRate,
        });
        item.onPlaybackStatus?.({
          kind: 'success',
          message: '同声传译运行中：正在播放译音。',
        });
      })
      .catch((error) => {
        if (this.activeAudio !== audio || this.generation !== generation) return;
        this.cleanupActiveAudio();
        item.onPlaybackStatus?.({
          kind: 'error',
          message: `译音已返回，但浏览器播放失败：${error instanceof Error ? error.message : String(error)}`,
        });
        this.scheduleNext();
      });
  }

  private cleanupActiveAudio(): void {
    if (this.activeUrl) {
      this.dependencies.revokeObjectUrl(this.activeUrl);
    }
    this.activeAudio = null;
    this.activeUrl = null;
  }

  private updateActivePlaybackRate(): void {
    if (this.activeAudio) {
      setAudioPlaybackRate(
        this.activeAudio,
        computeAdaptivePlaybackRate(this.queue.length, this.basePlaybackRate)
      );
    }
  }
}
