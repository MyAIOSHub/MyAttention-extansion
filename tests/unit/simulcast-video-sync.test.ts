import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isLiveVideo,
  computeSeekTarget,
  findMainVideo,
  resolveRequestedVideoSyncMode,
  enableVideoSync,
  holdVideoUntilTranslatedAudio,
  initSimulcastVideoSyncListener,
  disableVideoSync,
  releaseVideoHold,
  reapplyVideoSync,
  applyDynamicVideoSyncControl,
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
    vi.useRealTimers();
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
    it('classifies direct page-video sync as fallback while strict sync is handled by the player path', () => {
      expect(resolveRequestedVideoSyncMode()).toEqual({
        requestedMode: 'fallback-page-video',
        effectiveMode: 'fallback-page-video',
        strictSyncSupported: false,
      });
      expect(resolveRequestedVideoSyncMode('strict-delayed-player')).toEqual({
        requestedMode: 'strict-delayed-player',
        effectiveMode: 'fallback-page-video',
        strictSyncSupported: false,
        reason: '精准同步由独立播放器处理；当前页面视频控制仅作为标准兼容模式。',
      });
      expect(resolveRequestedVideoSyncMode('subtitles-only')).toEqual({
        requestedMode: 'subtitles-only',
        effectiveMode: 'subtitles-only',
        strictSyncSupported: false,
      });
    });

    it('VOD: seeks back without muting (tab capture needs the video audio)', () => {
      const v = makeVideo({ w: 640, h: 360, duration: 600, currentTime: 100 });
      v.muted = false;
      const res = enableVideoSync(3);
      expect(res).toEqual({ videoFound: true, mode: 'vod' });
      expect(v.muted).toBe(false); // 不静音：muted 会让标签页捕获到静音、AST 收不到声音
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

    it('dynamic sync nudges moderate drift with temporary playbackRate instead of seeking', () => {
      vi.useFakeTimers();
      const v = makeVideo({ w: 640, h: 360, duration: 600, currentTime: 100 });
      enableVideoSync(3);
      v.currentTime = 120;

      const result = applyDynamicVideoSyncControl(3.4);

      expect(result).toMatchObject({
        videoFound: true,
        mode: 'vod',
        action: 'rate',
        targetDelaySec: 3.4,
      });
      expect(v.currentTime).toBe(120);
      expect(v.playbackRate).toBeLessThan(1);

      vi.advanceTimersByTime(result.durationMs ?? 0);

      expect(v.playbackRate).toBe(1);
    });

    it('dynamic sync seeks when drift is too large for a gentle rate nudge', () => {
      const v = makeVideo({ w: 640, h: 360, duration: 600, currentTime: 100 });
      enableVideoSync(3);
      v.currentTime = 120;

      const result = applyDynamicVideoSyncControl(4.2);

      expect(result).toMatchObject({
        videoFound: true,
        mode: 'vod',
        action: 'seek',
        targetDelaySec: 4.2,
      });
      expect(v.currentTime).toBeCloseTo(118.8);
    });

    it('dynamic sync ignores tiny delay drift', () => {
      const v = makeVideo({ w: 640, h: 360, duration: 600, currentTime: 100 });
      enableVideoSync(3);
      v.currentTime = 120;

      const result = applyDynamicVideoSyncControl(3.05);

      expect(result).toMatchObject({
        videoFound: true,
        mode: 'vod',
        action: 'none',
        targetDelaySec: 3.05,
      });
      expect(v.currentTime).toBe(120);
      expect(v.playbackRate).toBe(1);
    });

    it('freezes the visible frame while capture continues, then releases at the delayed time', () => {
      const v = makeVideo({ w: 640, h: 360, duration: 600, currentTime: 100 });

      expect(holdVideoUntilTranslatedAudio()).toEqual({ videoFound: true, mode: 'vod' });
      expect(v.pause).not.toHaveBeenCalled();
      expect(v.style.opacity).toBe('0');
      expect(document.querySelector('[data-sayso-simulcast-hold="true"]')).not.toBeNull();

      v.currentTime = 102;
      expect(releaseVideoHold(2)).toEqual({ videoFound: true, mode: 'vod' });

      expect(v.currentTime).toBe(100);
      expect(v.style.opacity).toBe('');
      expect(document.querySelector('[data-sayso-simulcast-hold="true"]')).toBeNull();
      expect(isVideoSyncActive()).toBe(true);
    });

    it('notifies the runtime when the main video pauses', () => {
      const sendMessage = vi.fn();
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage,
          onMessage: { addListener: vi.fn() },
        },
      });
      const v = makeVideo({ w: 640, h: 360, duration: 600, currentTime: 100 });

      initSimulcastVideoSyncListener();
      v.dispatchEvent(new Event('pause', { bubbles: true }));

      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'simulcast:videoStopped',
          reason: 'pause',
        })
      );
      vi.unstubAllGlobals();
    });

    it('releases the visual hold from a dynamic sync message with releaseHold', () => {
      let listener:
        | ((message: any, sender: unknown, sendResponse: (response: any) => void) => boolean | undefined)
        | undefined;
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn(),
          onMessage: {
            addListener: vi.fn((fn) => {
              listener = fn;
            }),
          },
        },
      });
      const v = makeVideo({ w: 640, h: 360, duration: 600, currentTime: 100 });

      initSimulcastVideoSyncListener();
      expect(holdVideoUntilTranslatedAudio()).toEqual({ videoFound: true, mode: 'vod' });
      v.currentTime = 103;

      const sendResponse = vi.fn();
      expect(
        listener?.(
          { type: 'simulcast:dynamicVideoSync', targetDelaySec: 2, releaseHold: true },
          {},
          sendResponse
        )
      ).toBe(true);

      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          videoFound: true,
          mode: 'vod',
          action: 'release',
          targetDelaySec: 2,
        })
      );
      expect(v.currentTime).toBe(101);
      expect(v.style.opacity).toBe('');
      expect(document.querySelector('[data-sayso-simulcast-hold="true"]')).toBeNull();
      vi.unstubAllGlobals();
    });

    it('returns fallback mode metadata when strict delayed-player sync is requested', () => {
      let listener:
        | ((message: any, sender: unknown, sendResponse: (response: any) => void) => boolean | undefined)
        | undefined;
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn(),
          onMessage: {
            addListener: vi.fn((fn) => {
              listener = fn;
            }),
          },
        },
      });
      makeVideo({ w: 640, h: 360, duration: 600, currentTime: 100 });

      initSimulcastVideoSyncListener();
      const sendResponse = vi.fn();
      expect(
        listener?.(
          {
            type: 'simulcast:syncVideo',
            enabled: true,
            delaySec: 2,
            videoSyncMode: 'strict-delayed-player',
          },
          {},
          sendResponse
        )
      ).toBe(true);

      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          videoFound: true,
          videoSyncMode: 'fallback-page-video',
          requestedVideoSyncMode: 'strict-delayed-player',
          strictSyncSupported: false,
          reason: '精准同步由独立播放器处理；当前页面视频控制仅作为标准兼容模式。',
        })
      );
      vi.unstubAllGlobals();
    });
  });
});
