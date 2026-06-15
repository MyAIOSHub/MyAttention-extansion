import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '@/types';
import {
  REQUIRED_TRANSLATION_HOST_PERMISSIONS,
  REQUIRED_TRANSLATION_PERMISSIONS,
  TRANSLATION_FEATURES,
  createDefaultImmersiveTranslationConfig,
  createDefaultSimultaneousInterpretationConfig,
} from '@/translation/config';

describe('translation feature configuration', () => {
  it('declares the full read-frog feature surface for planning and UI routing', () => {
    expect(TRANSLATION_FEATURES).toEqual([
      'general',
      'apiProviders',
      'customActions',
      'pageTranslation',
      'videoSubtitles',
      'floatingButton',
      'selectionToolbar',
      'contextMenu',
      'inputTranslation',
      'textToSpeech',
      'statistics',
      'configSync',
      'simultaneousInterpretation',
    ]);
  });

  it('adds safe defaults for immersive translation and simultaneous interpretation', () => {
    expect(DEFAULT_SETTINGS.immersiveTranslation).toEqual(createDefaultImmersiveTranslationConfig());
    expect(DEFAULT_SETTINGS.simultaneousInterpretation).toEqual(createDefaultSimultaneousInterpretationConfig());
    expect(DEFAULT_SETTINGS.simultaneousInterpretation?.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.simultaneousInterpretation?.credentials.accessToken).toBe('');
    expect(DEFAULT_SETTINGS.simultaneousInterpretation?.credentials.secretKey).toBe('');
    expect(DEFAULT_SETTINGS.simultaneousInterpretation?.translatedAudioDelayMs).toBe(0);
  });

  it('declares the extension permissions needed by translation, iframe, tts, side panel, and tab audio capture', () => {
    expect(REQUIRED_TRANSLATION_PERMISSIONS).toEqual([
      'storage',
      'tabs',
      'contextMenus',
      'scripting',
      'alarms',
      'cookies',
      'identity',
      'webNavigation',
      'offscreen',
      'sidePanel',
      'tabCapture',
    ]);
    expect(REQUIRED_TRANSLATION_HOST_PERMISSIONS).toContain('*://*/*');
  });

  it('keeps manifest permissions aligned with the translation runtime requirements', () => {
    const manifestPath = join(process.cwd(), 'public', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      permissions?: string[];
      host_permissions?: string[];
      content_scripts?: Array<{ all_frames?: boolean; match_about_blank?: boolean }>;
    };

    for (const permission of REQUIRED_TRANSLATION_PERMISSIONS) {
      expect(manifest.permissions).toContain(permission);
    }
    for (const hostPermission of REQUIRED_TRANSLATION_HOST_PERMISSIONS) {
      expect(manifest.host_permissions).toContain(hostPermission);
    }
    expect(manifest.content_scripts?.[0]?.all_frames).toBe(true);
    expect(manifest.content_scripts?.[0]?.match_about_blank).toBe(true);
  });
});
