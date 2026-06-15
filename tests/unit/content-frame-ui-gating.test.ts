import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('content frame UI gating', () => {
  const contentSource = readFileSync(join(process.cwd(), 'src', 'content', 'index.ts'), 'utf8');

  it('keeps page-level sidebar UI out of child iframes', () => {
    expect(contentSource).toContain('isTopLevelFrame');
    expect(contentSource).toContain('const isPageFrame = isTopLevelFrame()');
    expect(contentSource).toContain('if (isPageFrame) {\n      // 初始化侧边栏消息监听');
    expect(contentSource).toContain('} else {\n      cleanupSidebar();');
    expect(contentSource).toContain('initPageTranslationListener();');
  });
});
