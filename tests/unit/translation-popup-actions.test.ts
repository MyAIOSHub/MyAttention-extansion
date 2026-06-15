import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('translation popup actions', () => {
  const popupSource = readFileSync(join(process.cwd(), 'src', 'popup', 'index.ts'), 'utf8');

  it('routes page translation through the background iframe runtime', () => {
    expect(popupSource).toContain("type: 'translation:translateTabFrames'");
    expect(popupSource).toContain("type: 'translation:clearTabTranslations'");
  });
});
