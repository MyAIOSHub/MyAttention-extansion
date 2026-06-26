import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('simulcast message types', () => {
  it('registers popup, background, and offscreen simulcast messages', () => {
    const typesSource = readFileSync(join(process.cwd(), 'src', 'types', 'index.ts'), 'utf8');

    expect(typesSource).toContain("'simulcast:start'");
    expect(typesSource).toContain("'simulcast:stop'");
    expect(typesSource).toContain("'simulcast:getStatus'");
    expect(typesSource).toContain("'simulcast:update'");
    expect(typesSource).toContain("'simulcast:updatePlayback'");
    expect(typesSource).toContain("'simulcast:strictPlayerDelay'");
    expect(typesSource).toContain("'simulcast:popupUpdate'");
    expect(typesSource).toContain("'simulcast:offscreenStart'");
    expect(typesSource).toContain("'simulcast:offscreenStop'");
    expect(typesSource).toContain("'simulcast:offscreenUpdatePlayback'");
    expect(typesSource).toContain("'simulcast:offscreenStrictPlayerDelay'");
    expect(typesSource).toContain("'simulcast:syncVideo'");
    expect(typesSource).toContain("'simulcast:videoPlaying'");
    expect(typesSource).toContain("'simulcast:videoStopped'");
    expect(typesSource).toContain("'simulcast:queryVideoPlaying'");
    expect(typesSource).toContain("'simulcast:subtitle'");
    expect(typesSource).toContain("'simulcast:videoClock'");
    expect(typesSource).toContain("'simulcast:dynamicVideoSync'");
  });
});
