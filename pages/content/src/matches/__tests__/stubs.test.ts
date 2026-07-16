/**
 * TikTok & GBP stub contract tests — ROADMAP Phase 2.2.
 *
 * Both `tiktok/index.ts` and `gbp/index.ts` are LEGAL stubs (the real scripts
 * are Phase 1.1/1.2, deferred pending Q1/Q2). They exist so the orchestrator's
 * dynamic dispatch doesn't fail at runtime — they must reply to
 * `START_SCHEDULING` with `SCHEDULE_FAILED` carrying a stable "not yet
 * supported" reason so the server requeues the campaign.
 *
 * These tests lock in that contract so a future refactor that breaks the
 * stub response (e.g. silently no-ops, or sends SCHEDULE_COMPLETE) fails
 * loudly before Phase 1.1/1.2 lands.
 */
import {
  __dispatchStartScheduling,
  __getLastOfType,
  __getSent,
  __resetShim,
  isolateWindowBeforeUnload,
} from './chrome-shim';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampaignPayload } from '@extension/shared';

const baseCampaign = (overrides: Partial<CampaignPayload> = {}): CampaignPayload => ({
  campaignId: 'c-stub-1',
  restaurantId: 'r-1',
  platform: 'tiktok',
  assetUrl: 'https://cdn.litoral.agency/asset.jpg',
  caption: 'stub',
  mediaType: 'image',
  ...overrides,
});

describe('tiktok + gbp stubs', () => {
  beforeEach(() => {
    __resetShim();
    document.body.innerHTML = '';
    isolateWindowBeforeUnload(window);
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('tiktok stub replies to START_SCHEDULING with SCHEDULE_FAILED(not yet supported)', async () => {
    await import('../tiktok/index');
    const campaign = baseCampaign({ campaignId: 'c-tt', platform: 'tiktok' });

    __dispatchStartScheduling(campaign);

    // Stubs send SCHEDULE_FAILED synchronously inside the onMessage listener.
    expect(__getLastOfType('SCHEDULE_FAILED')).toMatchObject({
      campaignId: 'c-tt',
      reason: 'Platform not yet supported (Story 6.4)',
    });
    // No completion, no progress — the stub does zero work.
    expect(__getSent().some(m => m.type === 'SCHEDULE_COMPLETE')).toBe(false);
  });

  it('gbp stub replies to START_SCHEDULING with SCHEDULE_FAILED(not yet supported)', async () => {
    await import('../gbp/index');
    const campaign = baseCampaign({ campaignId: 'c-gbp', platform: 'gbp' });

    __dispatchStartScheduling(campaign);

    expect(__getLastOfType('SCHEDULE_FAILED')).toMatchObject({
      campaignId: 'c-gbp',
      reason: 'Platform not yet supported (Story 6.4)',
    });
    expect(__getSent().some(m => m.type === 'SCHEDULE_COMPLETE')).toBe(false);
  });
});
