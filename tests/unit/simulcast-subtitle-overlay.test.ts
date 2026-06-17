import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('simulcast subtitle overlay', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'content', 'simulcast-subtitle-overlay.ts'),
    'utf8'
  );

  it('renders video subtitles without a black background mask', () => {
    expect(source).toContain("__ma_simulcast_subtitle__");
    expect(source).toContain('background:transparent');
    expect(source).not.toContain('background:rgba(0,0,0,.5)');
    expect(source).not.toContain('background:rgba(0,0,0,.58)');
    expect(source).not.toContain('border-radius:6px');
    expect(source).not.toContain('border-radius:7px');
  });
});
