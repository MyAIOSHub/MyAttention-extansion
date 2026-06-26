import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StrictDelayedVideoRelay } from '@/offscreen/simulcast-video-relay';

type PostedMessage = Record<string, unknown>;

describe('StrictDelayedVideoRelay', () => {
  let postedMessages: PostedMessage[];
  let originalCreateElement: typeof document.createElement;
  let videoWidth = 640;
  let videoHeight = 360;
  let now = 100;

  beforeEach(() => {
    vi.useFakeTimers();
    postedMessages = [];
    originalCreateElement = document.createElement.bind(document);
    now = 100;
    videoWidth = 640;
    videoHeight = 360;

    vi.stubGlobal(
      'BroadcastChannel',
      class {
        constructor(public readonly name: string) {}
        postMessage(message: PostedMessage): void {
          postedMessages.push(message);
        }
        close(): void {}
      }
    );

    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({
        close: vi.fn(),
      }))
    );

    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (tagName.toLowerCase() === 'video') {
        Object.defineProperty(element, 'play', {
          configurable: true,
          value: vi.fn().mockResolvedValue(undefined),
        });
        Object.defineProperty(element, 'pause', {
          configurable: true,
          value: vi.fn(),
        });
        Object.defineProperty(element, 'readyState', {
          configurable: true,
          get: () => HTMLMediaElement.HAVE_CURRENT_DATA,
        });
        Object.defineProperty(element, 'videoWidth', {
          configurable: true,
          get: () => videoWidth,
        });
        Object.defineProperty(element, 'videoHeight', {
          configurable: true,
          get: () => videoHeight,
        });
      }
      return element;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not report active until the first tab frame is captured', async () => {
    const relay = new StrictDelayedVideoRelay({
      sessionId: 'session-1',
      targetDelaySec: 1,
      now: () => now,
    });

    const startPromise = relay.start(createFakeStreamWithVideo());

    await vi.advanceTimersByTimeAsync(50);
    await expect(startPromise).resolves.toBe(true);

    expect(postedMessages).toContainEqual(
      expect.objectContaining({
        type: 'status',
        state: 'playing',
        message: '精准同步播放器已接收首帧。',
      })
    );

    now = 1200;
    await vi.advanceTimersByTimeAsync(1000);

    expect(postedMessages).toContainEqual(
      expect.objectContaining({
        type: 'frame',
        width: 640,
        height: 360,
        frameCount: 1,
      })
    );

    relay.stop();
  });

  it('returns unavailable when no drawable frame arrives before the first-frame timeout', async () => {
    videoWidth = 0;
    videoHeight = 0;
    const relay = new StrictDelayedVideoRelay({
      sessionId: 'session-2',
      targetDelaySec: 1,
      now: () => now,
    });

    const startPromise = relay.start(createFakeStreamWithVideo());

    await vi.advanceTimersByTimeAsync(2600);

    await expect(startPromise).resolves.toBe(false);
    expect(postedMessages).toContainEqual(
      expect.objectContaining({
        type: 'status',
        state: 'unsupported',
        message: '无法捕获标签页视频帧。',
      })
    );
  });

  it('crops tab capture frames to the main video viewport rect', async () => {
    videoWidth = 1280;
    videoHeight = 720;
    const relay = new StrictDelayedVideoRelay({
      sessionId: 'session-crop',
      targetDelaySec: 1,
      videoViewportRect: {
        left: 160,
        top: 90,
        width: 320,
        height: 180,
        viewportWidth: 640,
        viewportHeight: 360,
      },
      now: () => now,
    });

    const startPromise = relay.start(createFakeStreamWithVideo());

    await vi.advanceTimersByTimeAsync(50);
    await expect(startPromise).resolves.toBe(true);

    expect(vi.mocked(createImageBitmap)).toHaveBeenCalledWith(
      expect.any(HTMLVideoElement),
      320,
      180,
      640,
      360
    );

    now = 1200;
    await vi.advanceTimersByTimeAsync(1000);

    expect(postedMessages).toContainEqual(
      expect.objectContaining({
        type: 'frame',
        width: 640,
        height: 360,
      })
    );

    relay.stop();
  });
});

function createFakeStreamWithVideo(): MediaStream {
  return {
    getVideoTracks: () => [{}],
  } as unknown as MediaStream;
}
