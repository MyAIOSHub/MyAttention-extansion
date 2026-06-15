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
    expect(popupSource).toContain('translatedAudioDelayMs');
    expect(popupSource).toContain('appendSimulcastSpeakerLog');
    expect(popupSource).toContain('chrome.tabCapture.getMediaStreamId');
    expect(popupSource).toContain('streamId');
    expect(popupSource).toContain('simulcast-secret-key');
  });

  it('loads local credential prefill into LLM and simulcast controls', () => {
    expect(popupSource).toContain('loadLocalCredentialPrefill');
    expect(popupSource).toContain('initializeSimulcastSettings');
    expect(popupSource).toContain('resolveLlmCredentialPrefill');
    expect(popupSource).toContain('resolveSimulcastCredentialPrefill');
  });
});
