import { describe, expect, it, vi } from 'vitest';

import {
  SIMULCAST_OFFSCREEN_DOCUMENT_PATH,
  SimulcastRuntime,
} from '@/background/simulcast-runtime';
import { VOLCENGINE_AST_WS_URL } from '@/translation/volcengine-ast';

function createRuntime(overrides: Partial<ConstructorParameters<typeof SimulcastRuntime>[0]> = {}) {
  const dependencies = {
    hasOffscreenDocument: vi.fn().mockResolvedValue(false),
    createOffscreenDocument: vi.fn().mockResolvedValue(undefined),
    closeOffscreenDocument: vi.fn().mockResolvedValue(undefined),
    getTabMediaStreamId: vi.fn().mockResolvedValue('stream-id-1'),
    sendRuntimeMessage: vi.fn().mockResolvedValue({ status: 'ok' }),
    installAstAuthRule: vi.fn().mockResolvedValue(undefined),
    removeAstAuthRule: vi.fn().mockResolvedValue(undefined),
    now: vi.fn(() => '2026-06-12T10:00:00.000Z'),
    wait: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  return {
    dependencies,
    runtime: new SimulcastRuntime(dependencies),
  };
}

const baseRequest = {
  tabId: 42,
  sourceLanguage: 'en',
  targetLanguage: 'zh-CN',
  model: 'Doubao_scene_SLM_Doubao_SI_model2000000748711437826',
  audioOutputMode: 'translatedOnly' as const,
  originalVolume: 0.25,
  translatedVolume: 0.9,
  translatedAudioDelayMs: 1200,
  subtitleDisplayMode: 'bilingual' as const,
  voiceCloneEnabled: true,
  credentials: {
    apiKey: 'api-key',
    appId: '',
    accessToken: '',
    secretKey: '',
    resourceId: '',
  },
};

describe('SimulcastRuntime', () => {
  it('creates the offscreen document, captures tab audio, and starts the offscreen session', async () => {
    const { dependencies, runtime } = createRuntime();

    const result = await runtime.start(baseRequest);

    expect(result).toMatchObject({
      state: 'capturing',
      tabId: 42,
      startedAt: '2026-06-12T10:00:00.000Z',
    });
    expect(dependencies.createOffscreenDocument).toHaveBeenCalledWith({
      url: SIMULCAST_OFFSCREEN_DOCUMENT_PATH,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capture tab audio for simultaneous interpretation and translated audio playback.',
    });
    expect(dependencies.getTabMediaStreamId).toHaveBeenCalledWith(42);
    expect(dependencies.installAstAuthRule).toHaveBeenCalledWith({
      'X-Api-Key': 'api-key',
      'X-Api-Resource-Id': 'volc.service_type.10053',
    });
    expect(dependencies.sendRuntimeMessage).toHaveBeenCalledWith({
      type: 'simulcast:offscreenStart',
      session: {
        tabId: 42,
        streamId: 'stream-id-1',
        audioSource: 'tab',
        recordAudio: false,
        sourceLanguage: 'en',
        targetLanguage: 'zh-CN',
        model: 'Doubao_scene_SLM_Doubao_SI_model2000000748711437826',
        audioOutputMode: 'translatedOnly',
        originalVolume: 0.25,
        translatedVolume: 0.9,
        translatedAudioDelayMs: 1200,
        subtitleDisplayMode: 'bilingual',
        voiceCloneEnabled: true,
        ast: {
          url: VOLCENGINE_AST_WS_URL,
          headers: {
            'X-Api-Key': 'api-key',
            'X-Api-Resource-Id': 'volc.service_type.10053',
          },
        },
      },
    });
  });

  it('reuses an existing offscreen document', async () => {
    const { dependencies, runtime } = createRuntime({
      hasOffscreenDocument: vi.fn().mockResolvedValue(true),
    });

    await runtime.start(baseRequest);

    expect(dependencies.createOffscreenDocument).not.toHaveBeenCalled();
  });

  it('uses a caller-provided tab capture stream id without calling tabCapture again', async () => {
    const { dependencies, runtime } = createRuntime();

    await runtime.start({
      ...baseRequest,
      streamId: 'popup-stream-id',
    });

    expect(dependencies.getTabMediaStreamId).not.toHaveBeenCalled();
    expect(dependencies.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          streamId: 'popup-stream-id',
        }),
      })
    );
  });

  it('retries the offscreen start message while a newly-created document becomes ready', async () => {
    const { dependencies, runtime } = createRuntime({
      sendRuntimeMessage: vi
        .fn()
        .mockRejectedValueOnce(
          new Error('Could not establish connection. Receiving end does not exist.')
        )
        .mockResolvedValueOnce({ status: 'ok' }),
    });

    const result = await runtime.start(baseRequest);

    expect(result.state).toBe('capturing');
    expect(dependencies.sendRuntimeMessage).toHaveBeenCalledTimes(2);
    expect(dependencies.wait).toHaveBeenCalledWith(100);
    expect(dependencies.removeAstAuthRule).not.toHaveBeenCalled();
  });

  it('stops the active offscreen session and clears status', async () => {
    const { dependencies, runtime } = createRuntime();

    await runtime.start(baseRequest);
    const result = await runtime.stop();

    expect(result).toEqual({ state: 'stopped' });
    expect(dependencies.sendRuntimeMessage).toHaveBeenLastCalledWith({
      type: 'simulcast:offscreenStop',
      tabId: 42,
    });
    expect(dependencies.closeOffscreenDocument).toHaveBeenCalledTimes(1);
    expect(dependencies.removeAstAuthRule).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus()).toEqual({ state: 'stopped' });
  });

  it('removes AST auth rule when startup fails after installing headers', async () => {
    const { dependencies, runtime } = createRuntime({
      getTabMediaStreamId: vi.fn().mockRejectedValue(new Error('tab capture denied')),
    });

    await expect(runtime.start(baseRequest)).rejects.toThrow('tab capture denied');

    expect(dependencies.installAstAuthRule).toHaveBeenCalledTimes(1);
    expect(dependencies.removeAstAuthRule).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus()).toEqual({ state: 'stopped' });
  });
});
