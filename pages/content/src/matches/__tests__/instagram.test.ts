/**
 * Instagram content-script mocked-platform tests — ROADMAP Phase 2.2.
 *
 * Mirrors `facebook.test.ts` but drives `instagram/index.ts` against the IG
 * Creator Studio fixture. The IG scheduler is a single-step flow (no Publish
 * dropdown — a Schedule toggle reveals the date + final Schedule button) and
 * uses different selectors (notably `button[type="button"][aria-label*="Schedule"]`
 * vs. the `role="button"` toggle).
 *
 * Fake timers flush every `delay(ms)` and poll loop in constant time.
 */

import {
  __dispatchStartScheduling,
  __getLastOfType,
  __getSent,
  __resetShim,
  isolateWindowBeforeUnload,
} from './chrome-shim';
import { buildInstagramFixture } from './fixtures/instagram-fixture';
import { installMockAssetFetch } from './fixtures/mock-asset';
import { useFakeTimers } from './timer-harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampaignPayload } from '@extension/shared';

const formatDateTimeLocal = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const baseCampaign = (overrides: Partial<CampaignPayload> = {}): CampaignPayload => ({
  campaignId: 'c-ig-1',
  restaurantId: 'r-1',
  platform: 'instagram',
  assetUrl: 'https://cdn.litoral.agency/asset.jpg',
  caption: 'Friday paella night 🥘',
  scheduledTime: '2026-07-20T10:00:00Z',
  mediaType: 'image',
  ...overrides,
});

describe('instagram content script', () => {
  beforeEach(async () => {
    __resetShim();
    document.body.innerHTML = '';
    isolateWindowBeforeUnload(window);
    installMockAssetFetch();
    vi.resetModules();
    vi.useFakeTimers();
    // The imported binding is unused: the import exists for its top-level
    // side effect (installing the onMessage listener).
    await import('../instagram/index');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('I1: happy path with scheduledTime sends SCHEDULE_COMPLETE and mutates the composer DOM', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign();
    buildInstagramFixture({ outcome: 'success' });

    __dispatchStartScheduling(campaign);
    await flush(35_000);

    expect(__getLastOfType('SCHEDULE_COMPLETE')).toMatchObject({
      campaignId: 'c-ig-1',
      scheduledAt: campaign.scheduledTime,
    });

    const progressSteps = __getSent()
      .filter(
        (m): m is { type: 'SCHEDULING_PROGRESS'; campaignId: string; step: string } => m.type === 'SCHEDULING_PROGRESS',
      )
      .map(m => m.step);
    // IG has fewer steps than FB — no publish dropdown.
    expect(progressSteps).toEqual([
      'instagram: Opening post creator',
      'instagram: Uploading media',
      'instagram: Writing caption',
      'instagram: Setting schedule time',
      'instagram: Clicking Schedule button',
      'instagram: Waiting for confirmation',
    ]);

    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput?.files?.[0]?.name).toBe('litoral_campaign.jpg');
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Write a caption..."]')?.value).toBe(
      campaign.caption,
    );
    expect(document.querySelector<HTMLInputElement>('input[type="datetime-local"]')?.value).toBe(
      formatDateTimeLocal(campaign.scheduledTime!),
    );
    // The IG success dialog has aria-label containing "Scheduled".
    expect(document.querySelector('[role="dialog"][aria-label*="Scheduled"]')).not.toBeNull();
  });

  it('I2: happy path without scheduledTime skips the datetime sub-step and falls back to now()', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign({ scheduledTime: undefined });
    buildInstagramFixture({ outcome: 'success' });

    __dispatchStartScheduling(campaign);
    await flush(35_000);

    const complete = __getLastOfType('SCHEDULE_COMPLETE');
    expect(complete).toMatchObject({ campaignId: 'c-ig-1' });
    expect(complete?.scheduledAt).toBeTypeOf('string');
    // 'Setting schedule time' DOES still appear (the script logs it before the
    // `if (campaign.scheduledTime)` guard toggles the picker), but the date
    // input itself is never written — guard the DOM, not the progress log.
    const dateInput = document.querySelector<HTMLInputElement>('input[type="datetime-local"]');
    expect(dateInput?.value ?? '').toBe('');
  });

  it('I3: when no authenticatedMarker is present, bails fast with SCHEDULE_FAILED(LOGIN_REQUIRED) and mutates nothing', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign();
    // Logged-out: NO Instagram logo / Profile anchor. Add a lone Create post
    // button so we can assert the script never clicked it.
    const orphanCreate = document.createElement('button');
    orphanCreate.setAttribute('aria-label', 'Create post');
    document.body.appendChild(orphanCreate);

    __dispatchStartScheduling(campaign);
    await flush(6_000);

    expect(__getLastOfType('SCHEDULE_FAILED')).toMatchObject({
      campaignId: 'c-ig-1',
      reason: expect.stringMatching(/^LOGIN_REQUIRED:/),
    });
    expect(__getLastOfType('SCHEDULE_COMPLETE')).toBeUndefined();
    // No file input was ever revealed.
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('I4: when createPostButton never appears, fails with ELEMENT_NOT_FOUND', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign();
    buildInstagramFixture({ outcome: 'success' });
    document.querySelector('[aria-label="Create post"]')?.remove();

    __dispatchStartScheduling(campaign);
    await flush(16_000);

    const reason = __getLastOfType('SCHEDULE_FAILED')?.reason ?? '';
    expect(reason).toContain('ELEMENT_NOT_FOUND');
    expect(reason).toContain('[aria-label="Create post"]');
  });

  it('I5: when the error indicator wins the waitForOutcome race, fails with the typed code + selector', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign();
    buildInstagramFixture({ outcome: 'error' });

    __dispatchStartScheduling(campaign);
    await flush(35_000);

    // Same catch formatting as FB: `${code}${selector ? `: ${selector}` : ''}`
    // — the human-readable extractFailureReason becomes the error's .message,
    // not the recorded reason.
    expect(__getLastOfType('SCHEDULE_FAILED')).toMatchObject({
      campaignId: 'c-ig-1',
      reason: 'TEXT_SET_FAILED: [role="dialog"][aria-label*="error"], [role="alert"]',
    });
    expect(__getLastOfType('SCHEDULE_COMPLETE')).toBeUndefined();
  });

  it('I6: MEDIA_TOO_LARGE when the asset Content-Length exceeds 200MB', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign();
    buildInstagramFixture({ outcome: 'success' });
    installMockAssetFetch({ contentLength: String(250 * 1024 * 1024) });

    __dispatchStartScheduling(campaign);
    await flush(30_000);

    expect(__getLastOfType('SCHEDULE_FAILED')).toMatchObject({
      campaignId: 'c-ig-1',
      reason: expect.stringContaining('MEDIA_TOO_LARGE'),
    });
  });

  it('I7: MEDIA_FETCH_FAILED when the asset fetch returns a non-2xx status', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign();
    buildInstagramFixture({ outcome: 'success' });
    installMockAssetFetch({ status: 404 });

    __dispatchStartScheduling(campaign);
    await flush(30_000);

    expect(__getLastOfType('SCHEDULE_FAILED')).toMatchObject({
      campaignId: 'c-ig-1',
      reason: expect.stringContaining('MEDIA_FETCH_FAILED'),
    });
  });

  it('I8: beforeunload mid-schedule emits exactly one SCHEDULE_FAILED(tab_closed) and the catch guard suppresses a duplicate', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign();
    buildInstagramFixture({ outcome: 'success' });

    __dispatchStartScheduling(campaign);
    await flush(2_500);

    window.dispatchEvent(new Event('beforeunload'));
    await flush(35_000);

    const tabClosedMessages = __getSent().filter(
      (m): m is { type: 'SCHEDULE_FAILED'; campaignId: string; reason: string } =>
        m.type === 'SCHEDULE_FAILED' && m.reason === 'tab_closed',
    );
    expect(tabClosedMessages).toHaveLength(1);
    // Catch guard suppresses the duplicate SCHEDULE_FAILED.
    expect(__getSent().filter(m => m.type === 'SCHEDULE_FAILED')).toHaveLength(1);
  });
});
