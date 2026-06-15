import { describe, expect, it } from 'vitest';

import { isTopLevelFrame } from '@/content/frame-scope';

describe('content frame scope', () => {
  it('treats the page window as the only place for page-level extension UI', () => {
    const topWindow = {};

    expect(isTopLevelFrame({ self: topWindow, top: topWindow })).toBe(true);
    expect(isTopLevelFrame({ self: {}, top: topWindow })).toBe(false);
  });

  it('does not initialize page-level UI when frame access is restricted', () => {
    const restrictedWindow = {
      self: {},
      get top() {
        throw new Error('Blocked by frame policy');
      },
    };

    expect(isTopLevelFrame(restrictedWindow)).toBe(false);
  });
});
