import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('extension runtime verifier', () => {
  it('exposes a Chrome unpacked-extension runtime verification script', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const scriptPath = join(process.cwd(), 'scripts', 'verify-extension-runtime.js');

    expect(packageJson.scripts['verify:extension-runtime']).toBe(
      'node scripts/verify-extension-runtime.js'
    );
    expect(existsSync(scriptPath)).toBe(true);

    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toContain('--load-extension=');
    expect(source).toContain('codex-browsers');
    expect(source).toContain('chrome-extension://');
    expect(source).toContain('Target.createTarget');
    expect(source).toContain('tab-immersive-translation');
    expect(source).toContain('tab-simultaneous-interpretation');
    expect(source).toContain('simulcast:getStatus');
    expect(source).toContain('startMockAstProxy');
    expect(source).toContain('CONNECT openspeech.bytedance.com:443');
    expect(source).toContain('simulcast:start');
    expect(source).toContain('simulcast_offscreen.html');
    expect(source).toContain('Input.dispatchKeyEvent');
  });
});
