import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('translation popup shell', () => {
  const popupHtml = readFileSync(join(process.cwd(), 'public', 'html', 'popup.html'), 'utf8');

  it('exposes immersive translation and simultaneous interpretation tab buttons', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'public', 'manifest.json'), 'utf8'));

    expect(manifest.action.default_popup).toBe('html/popup.html');
    expect(popupHtml).toContain('id="tab-immersive-translation"');
    expect(popupHtml).toContain('id="tab-simultaneous-interpretation"');
    expect(popupHtml).toContain('title="沉浸翻译"');
    expect(popupHtml).toContain('title="同声传译"');
  });

  it('contains command panels for page translation and live interpretation controls', () => {
    expect(popupHtml).toContain('id="immersive-translation-content"');
    expect(popupHtml).toContain('id="simultaneous-interpretation-content"');
    expect(popupHtml).toContain('id="immersive-translate-current-page"');
    expect(popupHtml).toContain('id="simulcast-start-btn"');
    expect(popupHtml).toContain('id="simulcast-stop-btn"');
    expect(popupHtml).toContain('id="simulcast-api-key"');
    expect(popupHtml).toContain('id="simulcast-app-id"');
    expect(popupHtml).toContain('id="simulcast-access-token"');
    expect(popupHtml).toContain('id="simulcast-secret-key"');
    expect(popupHtml).toContain('id="simulcast-translated-delay-ms"');
    expect(popupHtml).toContain('id="simulcast-speaker-log"');
  });
});
