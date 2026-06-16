import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('translation popup shell', () => {
  const popupHtml = readFileSync(join(process.cwd(), 'public', 'html', 'popup.html'), 'utf8');

  it('exposes a 翻译 tab with immersive / simultaneous sub-toggle', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'public', 'manifest.json'), 'utf8'));

    expect(manifest.action.default_popup).toBe('html/popup.html');
    // 5-tab IA: 沉浸翻译 + 同声传译 合并进「翻译」tab，经子页切换
    expect(popupHtml).toContain('id="tab-translate"');
    expect(popupHtml).toContain('title="翻译"');
    expect(popupHtml).toContain('data-translate-sub="immersive"');
    expect(popupHtml).toContain('data-translate-sub="simultaneous"');
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
    expect(popupHtml).toContain('id="simulcast-paired"');
  });
});
