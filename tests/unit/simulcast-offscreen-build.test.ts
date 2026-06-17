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
    expect(source).toContain('audio.volume = getTranslatedPlaybackVolume(session)');
    expect(source).toContain('activeTranslatedAudioTimers');
    expect(source).toContain('activeTranslatedAudioUrls');
    expect(source).toContain('stopTranslatedAudios');
    expect(source).toContain('normalizeSimulcastPlaybackDelayMs');
    expect(source).toContain('译音已返回，但浏览器播放失败');
    expect(source).toContain('translatedAudio');
    expect(source).toContain('playback-started');
    expect(source).toContain('playback-ended');
    expect(source).toContain('Date.now()');
    expect(source).toContain('cleanupFailedCapture');
    expect(source).toContain('new Audio');
  });
});
