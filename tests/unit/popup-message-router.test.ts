import { describe, expect, it } from 'vitest';

import {
  createPopupMessageRouter,
  DEFAULT_IGNORED_REQUEST_TYPES,
} from '@/popup/message-router';

describe('popup message router', () => {
  it('ignores getStorageUsage request message for popup listeners', () => {
    const router = createPopupMessageRouter();

    expect(DEFAULT_IGNORED_REQUEST_TYPES.has('getStorageUsage')).toBe(true);

    const decision = router.classify('getStorageUsage', false);

    expect(decision.kind).toBe('ignored-request');
    expect(decision.shouldLogUnknown).toBe(false);
  });

  it('routes settingsUpdated as notification', () => {
    const router = createPopupMessageRouter();

    const decision = router.classify('settingsUpdated', false);

    expect(decision.kind).toBe('notification');
    expect(decision.shouldLogUnknown).toBe(false);
  });

  it('routes simulcast subtitle updates as notifications', () => {
    const router = createPopupMessageRouter();

    expect(router.classify('simulcast:update', false).kind).toBe('notification');
    expect(router.classify('simulcast:popupUpdate', false).kind).toBe('notification');
  });

  it('samples unknown message logs within a 60s window', () => {
    let now = 1_000;
    const router = createPopupMessageRouter({
      now: () => now,
      sampleWindowMs: 60_000,
    });

    const first = router.classify('mystery:event', false);
    const second = router.classify('mystery:event', false);

    now += 60_000;
    const third = router.classify('mystery:event', false);

    expect(first.kind).toBe('unknown');
    expect(first.shouldLogUnknown).toBe(true);

    expect(second.kind).toBe('unknown');
    expect(second.shouldLogUnknown).toBe(false);

    expect(third.kind).toBe('unknown');
    expect(third.shouldLogUnknown).toBe(true);
  });
});
