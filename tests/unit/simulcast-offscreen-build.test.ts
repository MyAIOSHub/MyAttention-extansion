import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('simulcast offscreen build assets', () => {
  it('declares an offscreen document that loads the simulcast audio entry', () => {
    const htmlPath = join(process.cwd(), 'public', 'html', 'simulcast_offscreen.html');

    expect(existsSync(htmlPath)).toBe(true);
    expect(readFileSync(htmlPath, 'utf8')).toContain('../simulcast-offscreen.js');
  });

  it('builds a dedicated simulcast offscreen bundle', () => {
    const viteConfig = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');

    expect(viteConfig).toContain('simulcastOffscreen');
    expect(viteConfig).toContain('src/offscreen/simulcast-audio.ts');
    expect(viteConfig).toContain('simulcast-offscreen.js');
  });

  it('streams captured tab audio into Volcengine AST and plays translated TTS audio', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'offscreen', 'simulcast-audio.ts'),
      'utf8'
    );
    const queueSource = readFileSync(
      join(process.cwd(), 'src', 'offscreen', 'translated-audio-queue.ts'),
      'utf8'
    );

    expect(source).toContain('VolcengineAstSession');
    expect(source).toContain('PcmChunker');
    expect(source).toContain('createScriptProcessor');
    expect(source).toContain('createGain');
    expect(source).toContain('resolveAstLanguagePair');
    expect(source).toContain('sendAudioChunk');
    expect(source).toContain('translatedVolume');
    expect(source).toContain('translatedAudioDelayMs');
    expect(source).toContain('SimulcastOffscreenUpdatePlaybackMessage');
    expect(source).toContain('updateActivePlaybackSettings');
    expect(source).toContain("message.type === 'simulcast:offscreenUpdatePlayback'");
    expect(source).toContain('activeOriginalGain.gain.value = getOriginalPlaybackVolume(session)');
    expect(source).toContain('TranslatedAudioPlaybackQueue');
    expect(source).toContain('translatedAudioQueue.enqueue');
    expect(source).toContain('translatedAudioQueue.updateActiveVolume');
    expect(source).toContain('translatedAudioQueue.stop');
    expect(source).toContain('stopTranslatedAudios');
    expect(source).toContain('normalizeSimulcastPlaybackDelayMs');
    expect(source).toContain('translatedAudio');
    expect(queueSource).toContain('playback-started');
    expect(queueSource).toContain('playback-ended');
    expect(source).toContain('cleanupFailedCapture');
  });
});
