import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/types';

describe('options experience', () => {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'public', 'manifest.json'), 'utf8')
  );
  const optionsHtml = readFileSync(
    join(process.cwd(), 'public', 'html', 'options.html'),
    'utf8'
  );
  const viteConfig = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');

  it('registers an extension options page in manifest and build inputs', () => {
    expect(manifest.options_ui).toEqual({
      open_in_tab: true,
      page: 'html/options.html',
    });
    expect(viteConfig).toContain("options: resolve(__dirname, 'src/options/index.ts')");
    expect(viteConfig).toContain("return 'options.js'");
  });

  it('exposes command palette, settings search, appearance, locale, and beta controls', () => {
    expect(optionsHtml).toContain('id="open-command-palette"');
    expect(optionsHtml).toContain('id="settings-search"');
    expect(optionsHtml).toContain('name="theme"');
    expect(optionsHtml).toContain('id="options-language"');
    expect(optionsHtml).toContain('id="beta-experience-toggle"');
    expect(optionsHtml).toContain('id="command-palette"');
  });

  it('defaults read-frog style options experience switches', () => {
    expect(DEFAULT_SETTINGS.experience).toEqual({
      theme: 'system',
      language: 'system',
      betaExperienceEnabled: false,
      commandPaletteEnabled: true,
      settingsSearchEnabled: true,
    });
  });
});
