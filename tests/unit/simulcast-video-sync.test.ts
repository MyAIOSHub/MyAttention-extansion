import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isLiveVideo,
  computeSeekTarget,
  findMainVideo,
  enableVideoSync,
  disableVideoSync,
  reapplyVideoSync,
  isVideoSyncActive,
  countVideos,
} from '../../src/content/simulcast-video-sync';

interface FakeOpts {
  w: number;
  h: number;
  duration: number;
  currentTime?: number;
  top?: number;
}

function makeVideo(opts: FakeOpts): HTMLVideoElement {
  const v = document.createElement('video');
  Object.defineProperty(v, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: opts.w, height: opts.h, top: opts.top ?? 10, bottom: (opts.top ?? 10) + opts.h, left: 0, right: opts.w } as DOMRect),
  });
  Object.defineProperty(v, 'readyState', { configurable: true, value: 2 });
  Object.defineProperty(v, 'duration', { configurable: true, value: opts.duration });
  let ct = opts.currentTime ?? 0;
  Object.defineProperty(v, 'currentTime', {
    configurable: true,
    get: () => ct,
    set: (x: number) => { ct = x; },
  });
  v.play = vi.fn().mockResolvedValue(undefined) as unknown as HTMLVideoElement['play'];
  v.pause = vi.fn() as unknown as HTMLVideoElement['pause'];
  document.body.appendChild(v);
  return v;
}

describe('simulcast-video-sync helpers', () => {
  beforeEach(() => {
    disableVideoSync();
    document.body.innerHTML = '';
  });

  describe('computeSeekTarget', () => {
    it('subtracts delay, clamps at 0', () => {
      expect(computeSeekTarget(100, 3)).toBe(97);
      expect(computeSeekTarget(2, 5)).toBe(0);
      expect(computeSeekTarget(100, -1)).toBe(100);
    });
  });

  describe('isLiveVideo', () => {
    it('treats Infinity/0 duration as live', () => {
      expect(isLiveVideo({ duration: Infinity })).toBe(true);
      expect(isLiveVideo({ duration: 0 })).toBe(true);
      expect(isLiveVideo({ duration: NaN })).toBe(true);
      expect(isLiveVideo({ duration: 600 })).toBe(false);
    });
  });

  describe('findMainVideo', () => {
    it('picks the largest visible video', () => {
      makeVideo({ w: 200, h: 120, duration: 600 });
      const big = makeVideo({ w: 640, h: 360, duration: 600 });
      expect(findMainVideo()).toBe(big);
    });
    it('falls back to any usable video when none are large', () => {
      const tiny = makeVideo({ w: 40, h: 30, duration: 600 });
      expect(findMainVideo()).toBe(tiny); // 兜底：仍返回可用视频，不再为 null
    });
    it('returns null when no video at all', () => {
      expect(findMainVideo()).toBeNull();
      expect(countVideos()).toBe(0);
    });
  });

  describe('enable / disable', () => {
    it('VOD: mutes and seeks back, restores mute on disable', () => {
      const v = makeVideo({ w: 640, h: 360, duration: 600, currentTime: 100 });
      v.muted = false;
      const res = enableVideoSync(3);
      expect(res).toEqual({ videoFound: true, mode: 'vod' });
      expect(v.muted).toBe(true);
      expect(v.currentTime).toBe(97);
      expect(isVideoSyncActive()).toBe(true);
      disableVideoSync();
      expect(v.muted).toBe(false);
      expect(isVideoSyncActive()).toBe(false);
    });

    it('live: pauses and reports live mode', () => {
      const v = makeVideo({ w: 640, h: 360, duration: Infinity });
      const res = enableVideoSync(3);
      expect(res.mode).toBe('live');
      expect(v.pause).toHaveBeenCalled();
    });

    it('returns videoFound:false when no main video', () => {
      expect(enableVideoSync(3)).toEqual({ videoFound: false, mode: 'none', reason: '未找到主视频' });
    });

    it('reapply adjusts by the delta only', () => {
      const v = makeVideo({ w: 640, h: 360, duration: 600, currentTime: 100 });
      enableVideoSync(3); // → 97
      reapplyVideoSync(5); // diff 2 → 95
      expect(v.currentTime).toBe(95);
    });
  });
});
