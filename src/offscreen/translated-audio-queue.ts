import { normalizeSimulcastPlaybackDelayMs } from './simulcast-delay';

export interface TranslatedAudioPlaybackEvent {
  event: 'playback-started' | 'playback-ended';
  segmentId: number;
  wallTimeMs: number;
  delayMs: number;
  playbackRate: number;
}

export interface TranslatedAudioQueueItem {
  segmentId: number;
  chunks: Uint8Array[];
  getVolume: () => number;
  delayMs: number;
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
    };
  }

  get size(): number {
    return this.queue.length + (this.activeAudio ? 1 : 0);
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
  }

  /** 设置译音基础倍速（夹在 1~2），并立即应用到正在播放的片段。 */
  setBasePlaybackRate(baseRate: number | undefined): void {
    this.basePlaybackRate = clampBasePlaybackRate(baseRate);
    this.updateActivePlaybackRate();
  }

  stop(): void {
    this.generation += 1;
    this.queue = [];
    if (this.startTimerId !== null) {
      this.dependencies.clearTimeout(this.startTimerId);
      this.startTimerId = null;
    }
    if (this.activeAudio) {
      this.activeAudio.pause();
      this.activeAudio.src = '';
    }
    this.cleanupActiveAudio();
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
