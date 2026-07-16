/**
 * Facebook content-script mocked-platform tests — ROADMAP Phase 2.2.
 *
 * Loads `facebook/index.ts` against a jsdom reconstruction of the Meta
 * Business Suite composer (`fixtures/facebook-fixture.ts`), drives the
 * `START_SCHEDULING` listener via the chrome shim, and asserts:
 *   - the correct ordering of `SCHEDULING_PROGRESS` steps,
 *   - the correct DOM mutations (file set, caption set, datetime set, dialog
 *     revealed), and
 *   - the correct final `chrome.runtime.sendMessage` outcome
 *     (`SCHEDULE_COMPLETE` or `SCHEDULE_FAILED` with a typed `reason`).
 *
 * Fake timers flush every `delay(ms)` and poll loop in constant time.
 */

import {
  __dispatchStartScheduling,
  __getLastOfType,
  __getSent,
  __resetShim,
  __setSendMessageRejects,
  isolateWindowBeforeUnload,
} from './chrome-shim';
import { buildFacebookFixture } from './fixtures/facebook-fixture';
import { installMockAssetFetch } from './fixtures/mock-asset';
import { useFakeTimers } from './timer-harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampaignPayload } from '@extension/shared';

/** Localized datetime the SERVICE emits — mirrors `dom-utils.setDateTimeInput`
 *  (YYYY-MM-DDTHH:mm in *local* time). The script's owner is a restaurant
 *  whose wall-clock scheduling is always local, so the test only locks in
 *  the format, not the timezone. */
const formatDateTimeLocal = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const baseCampaign = (overrides: Partial<CampaignPayload> = {}): CampaignPayload => ({
  campaignId: 'c-fb-1',
  restaurantId: 'r-1',
  platform: 'facebook',
  assetUrl: 'https://cdn.litoral.agency/asset.jpg',
  caption: 'Tonight: wood-fired seafood platter 🦞',
  scheduledTime: '2026-07-20T10:00:00Z',
  mediaType: 'image',
  ...overrides,
});

// The module installs its `onMessage` listener at top level — import it AFTER
// `chrome` is on globalThis (the shim module sets it). Vitest isolates modules
// per file, so the listener is fresh in each file even with module-level caching.
// We re-import in beforeEach so a reset between tests is impossible.
describe('facebook content script', () => {
  beforeEach(async () => {
    __resetShim();
    document.body.innerHTML = '';
    isolateWindowBeforeUnload(window);
    installMockAssetFetch();
    // Fresh module instance per test so the script's top-level state
    // (currentCampaignId / isUnloading) doesn't leak between tests — the
    // listener is re-installed on every import. The imported binding is unused:
    // the import exists for its top-level side effect (addListener).
    vi.resetModules();
    vi.useFakeTimers();
    await import('../facebook/index');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('F1: happy path with scheduledTime sends SCHEDULE_COMPLETE and mutates the composer DOM', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign();
    buildFacebookFixture({ outcome: 'success' });

    __dispatchStartScheduling(campaign);
    // Past every `delay()` plus the 30s waitForOutcome confirmation poll.
    await flush(35_000);

    expect(__getLastOfType('SCHEDULE_COMPLETE')).toMatchObject({
      campaignId: 'c-fb-1',
      scheduledAt: campaign.scheduledTime,
    });

    const progressSteps = __getSent()
      .filter(
        (m): m is { type: 'SCHEDULING_PROGRESS'; campaignId: string; step: string } => m.type === 'SCHEDULING_PROGRESS',
      )
      .map(m => m.step);
    expect(progressSteps).toEqual([
      'facebook: Opening post composer',
      'facebook: Opening media upload',
      'facebook: Uploading media',
      'facebook: Writing caption',
      'facebook: Opening publish dropdown',
      'facebook: Selecting schedule option',
      'facebook: Setting schedule time',
      'facebook: Clicking Schedule post button',
      'facebook: Waiting for confirmation',
    ]);

    // DOM mutations
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput?.files?.[0]?.name).toBe('litoral_campaign.jpg');
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label*="What\'s on your mind"]')?.value).toBe(
      campaign.caption,
    );
    expect(document.querySelector<HTMLInputElement>('input[type="datetime-local"]')?.value).toBe(
      formatDateTimeLocal(campaign.scheduledTime!),
    );
    expect(document.querySelector('[role="dialog"][aria-label*="Post scheduled"]')).not.toBeNull();
  });

  it('F2: happy path without scheduledTime skips the datetime step and falls back to now()', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign({ scheduledTime: undefined });
    buildFacebookFixture({ outcome: 'success' });

    __dispatchStartScheduling(campaign);
    await flush(35_000);

    const complete = __getLastOfType('SCHEDULE_COMPLETE');
    expect(complete).toMatchObject({ campaignId: 'c-fb-1' });
    expect(complete?.scheduledAt).toBeTypeOf('string');
    // 'Setting schedule time' must NOT appear; date input must remain empty/absent.
    const progressSteps = __getSent()
      .filter(m => m.type === 'SCHEDULING_PROGRESS')
      .map(m => (m as { step: string }).step);
    expect(progressSteps).not.toContain('facebook: Setting schedule time');
    const dateInput = document.querySelector<HTMLInputElement>('input[type="datetime-local"]');
    expect(dateInput?.value ?? '').toBe('');
  });

  it('F3: when no authenticatedMarker is present, bails fast with SCHEDULE_FAILED(LOGIN_REQUIRED) and mutates nothing', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign();
    // Logged-out: NO nav / authenticated marker. Build the composer by hand
    // so we can assert the script never touched it.
    const orphanCreate = document.createElement('button');
    orphanCreate.setAttribute('aria-label', 'Create post');
    document.body.appendChild(orphanCreate);

    __dispatchStartScheduling(campaign);
    // detectLogin polls up to 5s before giving up.
    await flush(6_000);

    expect(__getLastOfType('SCHEDULE_FAILED')).toMatchObject({
      campaignId: 'c-fb-1',
      // reason format: `LOGIN_REQUIRED: <selector>`
      reason: expect.stringMatching(/^LOGIN_REQUIRED: .+account/i),
    });
    expect(__getLastOfType('SCHEDULE_COMPLETE')).toBeUndefined();
    // Composer must be untouched — no file input revealed, no Photo/Video button added.
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(document.querySelector('[aria-label="Photo/Video"]')).toBeNull();
  });

  it('F4: when createPostButton never appears, fails with ELEMENT_NOT_FOUND', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign();
    buildFacebookFixture({ outcome: 'success' });
    // Remove the composer button so waitForElement times out — keep the login
    // marker so we get past the detectLogin gate to the composer wait.
    document.querySelector('[aria-label="Create post"]')?.remove();

    __dispatchStartScheduling(campaign);
    // detectLogin (5s) + waitForElement(createPost, 10s) = up to 15s.
    await flush(16_000);

    expect(__getLastOfType('SCHEDULE_FAILED')).toMatchObject({
      campaignId: 'c-fb-1',
    });
    // The reason carries both the typed code and the failing selector.
    const reason = __getLastOfType('SCHEDULE_FAILED')?.reason ?? '';
    expect(reason).toContain('ELEMENT_NOT_FOUND');
    expect(reason).toContain('[aria-label="Create post"]');
  });

  it('F5: when the error indicator wins the waitForOutcome race, fails with the platform error text', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign();
    buildFacebookFixture({ outcome: 'error' });

    __dispatchStartScheduling(campaign);
    await flush(35_000);

    expect(__getLastOfType('SCHEDULE_FAILED')).toMatchObject({
      campaignId: 'c-fb-1',
      // The content-script catch formats a DomUtilError as
      // `${code}${selector ? `: ${selector}` : ''}` — it does NOT use the
      // human-readable `.message` that `extractFailureReason` built. So the
      // recorded reason is the typed code + the full failure-selector list.
      reason: 'TEXT_SET_FAILED: [role="dialog"][aria-label*="error"], [role="alert"]',
    });
    expect(__getLastOfType('SCHEDULE_COMPLETE')).toBeUndefined();
    // No success dialog was ever added.
    expect(document.querySelector('[role="dialog"][aria-label*="Post scheduled"]')).toBeNull();
  });

  it('F6: MEDIA_TOO_LARGE when the asset Content-Length exceeds 200MB', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign();
    buildFacebookFixture({ outcome: 'success' });
    installMockAssetFetch({ contentLength: String(250 * 1024 * 1024) });

    __dispatchStartScheduling(campaign);
    // detectLogin + open composer + open media + waitForElement(file input) +
    // uploadMedia fails the size check before fetching the blob.
    await flush(30_000);

    expect(__getLastOfType('SCHEDULE_FAILED')).toMatchObject({
      campaignId: 'c-fb-1',
      reason: expect.stringContaining('MEDIA_TOO_LARGE'),
    });
  });

  it('F7: MEDIA_FETCH_FAILED when the asset fetch returns a non-2xx status', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign();
    buildFacebookFixture({ outcome: 'success' });
    installMockAssetFetch({ status: 404 });

    __dispatchStartScheduling(campaign);
    await flush(30_000);

    expect(__getLastOfType('SCHEDULE_FAILED')).toMatchObject({
      campaignId: 'c-fb-1',
      reason: expect.stringContaining('MEDIA_FETCH_FAILED'),
    });
  });

  it('F8: beforeunload mid-schedule emits exactly one SCHEDULE_FAILED(tab_closed) — no duplicate, no late SCHEDULE_COMPLETE', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign();
    // 'pending' reveals nothing on the Schedule-button click — the scheduler
    // parks in waitForOutcome (30s poll loop), so beforeunload can fire
    // mid-flight without racing a terminal outcome.
    buildFacebookFixture({ outcome: 'pending' });

    __dispatchStartScheduling(campaign);
    // Drive past the composer open + caption + publish dropdown + schedule
    // button click so the scheduler reaches waitForOutcome and parks.
    await flush(5_000);

    // The content script registers a `window` beforeunload listener at top
    // level; dispatching it flips `isUnloading` and sends SCHEDULE_FAILED.
    window.dispatchEvent(new Event('beforeunload'));

    // Flush past the 30s waitForOutcome timeout so the in-flight scheduler
    // resolves/rejects and its catch arm runs under fake time.
    await flush(35_000);

    const tabClosedMessages = __getSent().filter(
      (m): m is { type: 'SCHEDULE_FAILED'; campaignId: string; reason: string } =>
        m.type === 'SCHEDULE_FAILED' && m.reason === 'tab_closed',
    );
    // Exactly one tab_closed came from the beforeunload handler.
    expect(tabClosedMessages).toHaveLength(1);
    // The script's catch arm guards on `if (currentCampaignId !== campaign.campaignId) return`
    // — beforeunload nulled currentCampaignId, so the catch must NOT have
    // emitted a SECOND SCHEDULE_FAILED.
    expect(__getSent().filter(m => m.type === 'SCHEDULE_FAILED')).toHaveLength(1);
    // The success path now guards on `isUnloading` too: even if waitForOutcome
    // were to resolve, the in-flight scheduler must NOT emit a contradictory
    // SCHEDULE_COMPLETE after the tab_closed failure.
    expect(__getLastOfType('SCHEDULE_COMPLETE')).toBeUndefined();
  });

  it('F9: sendProgress swallows a rejected sendMessage without breaking the scheduling flow', async () => {
    const flush = useFakeTimers();
    const campaign = baseCampaign();
    buildFacebookFixture({ outcome: 'success' });
    __setSendMessageRejects(new Error('Extension context invalidated'));

    // The final SCHEDULE_COMPLETE send is NOT wrapped in `.catch()` (only the
    // SCHEDULING_PROGRESS sends are), so its rejection becomes unhandled.
    // Attach a no-op sink for this test so Vitest doesn't false-fail on the
    // expected rejection.
    const sink = (): void => {
      /* swallow expected completion rejection */
    };
    window.addEventListener('unhandledrejection', sink);
    process.on('unhandledRejection', sink);

    __dispatchStartScheduling(campaign);
    await flush(35_000);

    try {
      // The `sendProgress` `.catch(() => {})` swallowed every rejected
      // SCHEDULING_PROGRESS send — confirms the rejection didn't abort the
      // scheduler, which proceeded all the way to the completion call.
      expect(__getSent().some(m => m.type === 'SCHEDULING_PROGRESS')).toBe(true);
      expect(
        __getSent().filter(m => m.type === 'SCHEDULING_PROGRESS'),
        'all 9 progress steps were attempted despite each rejecting',
      ).toHaveLength(9);
    } finally {
      window.removeEventListener('unhandledrejection', sink);
      process.off('unhandledRejection', sink);
    }
  });
});
