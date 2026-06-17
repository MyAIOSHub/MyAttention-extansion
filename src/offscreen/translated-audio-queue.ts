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

function computeAdaptivePlaybackRate(pendingSegments: number): number {
  if (pendingSegments <= 0) {
    return 1;
  }
  if (pendingSegments === 1) {
    return 1.06;
  }
  return 1.12;
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
    setAudioPlaybackRate(audio, computeAdaptivePlaybackRate(this.queue.length));
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
      setAudioPlaybackRate(this.activeAudio, computeAdaptivePlaybackRate(this.queue.length));
    }
  }
}
