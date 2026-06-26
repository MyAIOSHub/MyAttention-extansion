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
    expect(viteConfig).toContain('simulcastPlayer');
    expect(viteConfig).toContain('src/player/simulcast-player.ts');
    expect(viteConfig).toContain('simulcast-player.js');
  });

  it('declares a strict delayed simulcast player page', () => {
    const htmlPath = join(process.cwd(), 'public', 'html', 'simulcast_player.html');

    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, 'utf8');
    expect(html).toContain('../simulcast-player.js');
    expect(html).toContain('simulcast-player-subtitle');
    expect(html).toContain('subtitle-bar');
    expect(html).toContain('grid-template-rows: 1fr 76px auto');
    expect(html).toContain('height: 76px');
    expect(html).not.toContain('display: none;');
    expect(html).toContain('simulcast-player-stop');
    expect(html).toContain('停止同传');
  });

  it('renders strict player subtitles below the video instead of over the canvas', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'player', 'simulcast-player.ts'),
      'utf8'
    );

    expect(source).toContain("message.type === 'subtitle'");
    expect(source).toContain('simulcast-player-subtitle-source');
    expect(source).toContain('simulcast-player-subtitle-translation');
    expect(source).toContain('SUBTITLE_AUDIO_LEAD_MS');
    expect(source).toContain('getSubtitleDisplayDelayMs');
    expect(source).toContain('mergeStreamingText');
    expect(source).toContain("type: 'simulcast:stop'");
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
    expect(source).toContain('StrictDelayedVideoRelay');
    expect(source).toContain('createTabCaptureConstraints');
    expect(source).toContain('translatedAudioQueue.enqueue');
    expect(source).toContain('translatedAudioQueue.updateActiveVolume');
    expect(source).toContain('translatedAudioQueue.stop');
    expect(source).toContain('stopTranslatedAudios');
    expect(source).toContain('normalizeSimulcastPlaybackDelayMs');
    expect(source).toContain('translatedAudio');
    expect(queueSource).toContain('playback-started');
    expect(queueSource).toContain('playback-scheduled');
    expect(queueSource).toContain('playback-ended');
    expect(source).toContain('cleanupFailedCapture');
  });
});
