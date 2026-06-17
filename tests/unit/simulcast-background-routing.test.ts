import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('simulcast background routing', () => {
  const backgroundSource = readFileSync(join(process.cwd(), 'src', 'background', 'index.ts'), 'utf8');

  it('forwards translated audio telemetry and video clock samples to the popup', () => {
    expect(backgroundSource).toContain('translatedAudio: params.translatedAudio');
    expect(backgroundSource).toContain("'simulcast:videoClock'");
    expect(backgroundSource).toContain('videoClock');
  });
});
