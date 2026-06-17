import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('simulcast popup actions', () => {
  const popupSource = readFileSync(join(process.cwd(), 'src', 'popup', 'index.ts'), 'utf8');

  it('starts and stops simulcast through background runtime messages', () => {
    expect(popupSource).toContain("type: 'simulcast:start'");
    expect(popupSource).toContain("type: 'simulcast:stop'");
    expect(popupSource).toContain("simulcast:update");
    expect(popupSource).toContain('handleSimulcastUpdate');
    expect(popupSource).toContain('statusMessage');
    expect(popupSource).toContain("getNumberControlValue('simulcast-original-volume'");
    expect(popupSource).toContain("getNumberControlValue('simulcast-translated-volume'");
    expect(popupSource).toContain("getDelayControlValue('simulcast-translated-delay-ms'");
    expect(popupSource).toContain('bindSimulcastPlaybackControl');
    expect(popupSource).toContain("type: 'simulcast:updatePlayback'");
    expect(popupSource).toContain('translatedAudioDelayMs');
    expect(popupSource).toContain('appendSimulcastSpeakerLog');
    expect(popupSource).toContain('chrome.tabCapture.getMediaStreamId');
    expect(popupSource).toContain('streamId');
    expect(popupSource).toContain('simulcast-secret-key');
    expect(popupSource).toContain('SIMULCAST_TRANSLATED_AUDIO_PLAYING_STATUS');
    expect(popupSource).toContain("maybeAutoMeasureSyncDelay('subtitle')");
    expect(popupSource).toContain('createSimulcastDynamicSyncState');
    expect(popupSource).toContain('observeSourceSubtitleAnchor');
    expect(popupSource).toContain('observeTranslatedAudioPlayback');
    expect(popupSource).toContain('handleTranslatedAudioPlaybackStarted');
    expect(popupSource).toContain("type: 'simulcast:dynamicVideoSync'");
    expect(popupSource).toContain('自动动态对齐');
    expect(popupSource).toContain('holdUntilAudio: true');
    expect(popupSource).toContain('releaseHold: simulcastVideoHoldPending');
    expect(popupSource).toContain('videoClock');
    expect(popupSource).toContain('videoStopped');
  });

  it('loads local credential prefill into LLM and simulcast controls', () => {
    expect(popupSource).toContain('loadLocalCredentialPrefill');
    expect(popupSource).toContain('initializeSimulcastSettings');
    expect(popupSource).toContain('resolveLlmCredentialPrefill');
    expect(popupSource).toContain('resolveSimulcastCredentialPrefill');
  });

  it('does not drop playback volume changes when popup running state is stale', () => {
    const start = popupSource.indexOf(
      'async function updateSimulcastPlaybackSettings(): Promise<void>'
    );
    const end = popupSource.indexOf('function bindSimulcastPlaybackControl', start);
    const updatePlaybackSource = popupSource.slice(start, end);

    expect(updatePlaybackSource).toContain("type: 'simulcast:updatePlayback'");
    expect(updatePlaybackSource).toContain("getNumberControlValue('simulcast-original-volume'");
    expect(updatePlaybackSource).not.toContain('!simulcastRunning');
  });
});
