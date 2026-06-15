import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const repositoryMocks = vi.hoisted(() => ({
  getSnippetStatusForTab: vi.fn(),
}));

const settingsMocks = vi.hoisted(() => ({
  getBackgroundWebCaptureSettings: vi.fn(),
}));

vi.mock('@/background/repository/snippet-repository', () => ({
  snippetRepository: repositoryMocks,
}));

vi.mock('@/background/settings', () => settingsMocks);

import { getSnippetStatusForUrl, refreshSnippetBadge } from '@/background/snippet-status';

describe('snippet status badge', () => {
  const setBadgeText = vi.fn();
  const setBadgeBackgroundColor = vi.fn();

  beforeEach(() => {
    (globalThis as any).chrome = {
      action: {
        setBadgeText,
        setBadgeBackgroundColor,
      },
    };

    settingsMocks.getBackgroundWebCaptureSettings.mockResolvedValue({
      enabled: true,
      highlightEnabled: true,
      dwellEnabled: true,
      contextMenuEnabled: true,
      badgeEnabled: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setBadgeText.mockReset();
    setBadgeBackgroundColor.mockReset();
  });

  it('proxies snippet status lookups', async () => {
    repositoryMocks.getSnippetStatusForTab.mockResolvedValue({
      url: 'https://example.com',
      hasSnippet: true,
      snippetCount: 1,
      latestSnippetAt: '2026-03-02T10:00:00.000Z',
    });

    const status = await getSnippetStatusForUrl('https://example.com');
    expect(status.hasSnippet).toBe(true);
  });

  it('clears badge when badge display is disabled', async () => {
    settingsMocks.getBackgroundWebCaptureSettings.mockResolvedValue({
      enabled: true,
      highlightEnabled: true,
      dwellEnabled: true,
      contextMenuEnabled: true,
      badgeEnabled: false,
    });

    await refreshSnippetBadge(11, 'https://example.com/article');

    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 11, text: '' });
    expect(setBadgeBackgroundColor).not.toHaveBeenCalled();
  });

  it('uses AI badge color when snippets exist on AI pages', async () => {
    repositoryMocks.getSnippetStatusForTab.mockResolvedValue({
      url: 'https://chatgpt.com/c/abc',
      hasSnippet: true,
      snippetCount: 2,
      latestSnippetAt: '2026-03-02T10:00:00.000Z',
    });

    await refreshSnippetBadge(7, 'https://chatgpt.com/c/abc');

    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '•' });
    expect(setBadgeBackgroundColor).toHaveBeenCalledWith({
      tabId: 7,
      color: '#5e6ad2',
    });
  });
});
