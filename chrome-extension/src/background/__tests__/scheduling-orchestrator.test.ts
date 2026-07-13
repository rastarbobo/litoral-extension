import { __resetChromeShim, __sendRuntimeMessage, __tabCreateCalls, __tabMessages, __emitTabUpdated } from './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampaignPayload } from '@extension/shared';

// ─── Per-test isolation ─────────────────────────────────
//
// The orchestrator instantiates `const breaker = new CircuitBreaker()` at
// module load and keeps `isSchedulingInProgress` as module-scoped state.
// `vi.resetModules()` + a fresh `await import()` per test gives every test a
// clean `breaker` instance and `isSchedulingInProgress = false`. The breaker
// state lives in `chrome.storage.local`, which `__resetChromeShim` clears.
//
// `extensionPollStorage` is re-imported for the same reason (internal cache +
// onChanged listener reused by both the test setup and the orchestrator's
// top-level import — they share the same module instance within one test).

const BREAKER_OPEN_MS = 15 * 60 * 1000;

const flushMicrotasks = async (iterations = 30) => {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
};

/** Flush microtasks until `chrome.tabs.create` has been invoked `expected` times. */
const flushUntilTabCreates = async (expected: number, maxIterations = 60) => {
  for (let i = 0; i < maxIterations && __tabCreateCalls.length < expected; i++) {
    await Promise.resolve();
    await Promise.resolve();
  }
};

const reimportOrchestrator = async () => {
  const mod = await import('../scheduling-orchestrator');
  return {
    processPendingSchedules: mod.processPendingSchedules,
    getSchedulingInProgress: mod.getSchedulingInProgress,
  };
};

const reimportStorage = async () => {
  const mod = await import('@extension/storage');
  return { poll: mod.extensionPollStorage, auth: mod.extensionAuthStorage };
};

const reimportBreaker = async () => {
  const mod = await import('../circuit-breaker');
  return {
    setBreakerState: mod.setBreakerState,
    getBreakerState: mod.getBreakerState,
  };
};

// ─── Fixtures ────────────────────────────────────────────

const makeCampaign = (overrides: Partial<CampaignPayload> = {}): CampaignPayload => ({
  campaignId: 'c-' + Math.random().toString(36).slice(2),
  restaurantId: 'r-default',
  platform: 'instagram',
  assetUrl: 'https://r2.example/asset.png',
  caption: 'hello',
  scheduledTime: '2026-12-15T10:30:00.000Z',
  mediaType: 'image',
  ...overrides,
});

const SCHEDULED_AT = '2026-12-15T10:30:00.000Z';

/** Resolve a campaign via the SCHEDULE_COMPLETE message listener once registerd. */
const completeCampaignViaMessage = (campaignId: string, scheduledAt: string = SCHEDULED_AT) => {
  __sendRuntimeMessage({ type: 'SCHEDULE_COMPLETE', campaignId, scheduledAt });
};

describe('scheduling-orchestrator', () => {
  beforeEach(() => {
    __resetChromeShim();
    vi.resetModules();
  });

  // ── Test 1: empty queue is a no-op ─────────────────────
  it('returns early when no campaigns are pending', async () => {
    const { processPendingSchedules, getSchedulingInProgress } = await reimportOrchestrator();

    await processPendingSchedules();

    expect(__tabCreateCalls).toHaveLength(0);
    expect(getSchedulingInProgress()).toBe(false);
  });

  // ── Test 8 (tested early to keep success + telemetry together) ────────
  it('records platform success telemetry when a campaign completes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');

    const campaign = makeCampaign({ campaignId: 'c-success', platform: 'facebook' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules, getSchedulingInProgress } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    // The orchestrator's messageListener is registered before chrome.tabs.create
    // fires; flush until the tab has been created (i.e. scheduleOneCampaign has
    // committed to looping through inner), then send SCHEDULE_COMPLETE.
    await flushUntilTabCreates(1);
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    await promise;

    expect(__tabCreateCalls).toHaveLength(1);
    expect(getSchedulingInProgress()).toBe(false);

    const telemetry = await poll.getTelemetry();
    expect(telemetry.facebook?.lastSuccessAt).toBe(new Date('2026-07-13T10:00:00.000Z').getTime());
    expect(telemetry.facebook?.lastErrorCode).toBeNull();

    // pendingSchedules cleared.
    const state = await poll.get();
    expect(state.pendingSchedules).toEqual([]);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Test 2: bounded batch (max 2 per cycle) ────────────
  it('processes at most 2 campaigns per scheduling cycle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');

    // Five campaigns; orchestrator should only touch the first two this cycle.
    const campaigns = Array.from({ length: 5 }, (_, i) =>
      makeCampaign({ campaignId: `c-batch-${i}`, platform: 'instagram' }),
    );
    for (const c of campaigns) {
      await poll.storeClaimedCampaign(c);
    }

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    // Wait for the FIRST tab to be created, then complete it. Repeat for 2.
    await flushUntilTabCreates(1);
    completeCampaignViaMessage(campaigns[0]!.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    // The orchestrator pauses 90s before the 2nd campaign. Advance through it.
    // (advanceTimersByTimeAsync also flushes microtasks so the loop progresses.)
    await vi.advanceTimersByTimeAsync(90_000);
    await flushUntilTabCreates(2);
    completeCampaignViaMessage(campaigns[1]!.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    // No 3rd campaign should be processed in this cycle (max 2).
    await vi.advanceTimersByTimeAsync(90_000);
    await promise;

    expect(__tabCreateCalls).toHaveLength(2);
    const state = await poll.get();
    expect(state.pendingSchedules).toHaveLength(3);
    expect(state.pendingSchedules.map(c => c.campaignId)).toEqual([
      campaigns[2]!.campaignId,
      campaigns[3]!.campaignId,
      campaigns[4]!.campaignId,
    ]);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Test 3: 90s inter-campaign delay observed before 2nd campaign ───────
  it('waits 90s between campaigns within a scheduling cycle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const c1 = makeCampaign({ campaignId: 'c-delay-1', platform: 'instagram' });
    const c2 = makeCampaign({ campaignId: 'c-delay-2', platform: 'facebook' });
    await poll.storeClaimedCampaign(c1);
    await poll.storeClaimedCampaign(c2);

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    completeCampaignViaMessage(c1.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    // First campaign done. Without advancing timers, the second tab creation
    // must NOT have happened yet (the 90s delay is pending).
    expect(__tabCreateCalls).toHaveLength(1);

    // Advance < 90s — still no second tab.
    await vi.advanceTimersByTimeAsync(89_999);
    expect(__tabCreateCalls).toHaveLength(1);

    // Advance to 90s+ → delay resolves, second campaign enters scheduleOneCampaign.
    await vi.advanceTimersByTimeAsync(1);
    await flushUntilTabCreates(2);
    completeCampaignViaMessage(c2.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(__tabCreateCalls).toHaveLength(2);
    const state = await poll.get();
    expect(state.pendingSchedules).toEqual([]);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Test 4: 90s scheduling timeout (tab loads OK, content script silent) ──
  it('marks a campaign failed with reason "timeout" after the 90s scheduling window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-timeout', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules, getSchedulingInProgress } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    // The orchestrator's create cb is now awaiting waitForTabLoad. To isolate
    // the 90s scheduling timeout (vs the 30s tab-load timeout), satisfy
    // waitForTabLoad so its 30s timer is canceled — then only the 90s global
    // timeout remains pending. Tab IDs in the shim start at 1, and this test
    // creates exactly one tab, so id=1.
    __emitTabUpdated(1, { status: 'complete' });
    await flushMicrotasks();

    // Now advance 90s — only the global scheduling timeout remains.
    await vi.advanceTimersByTimeAsync(90_000);
    await flushMicrotasks();
    await promise;

    expect(__tabCreateCalls).toHaveLength(1);
    expect(getSchedulingInProgress()).toBe(false);

    const telemetry = await poll.getTelemetry();
    expect(telemetry.instagram?.lastErrorCode).toBe('PLATFORM');
    // parseReason('timeout') falls through to {code:'PLATFORM', message:'timeout'}
    // — the orchestrator logs the structured code via `recordPlatformFailure`.
    expect(telemetry.instagram?.lastErrorReason).toBe('timeout');
    expect(telemetry.instagram?.consecutiveFailures).toBeGreaterThan(0);

    const state = await poll.get();
    expect(state.pendingSchedules).toEqual([]);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Test 5: 30s tab-load timeout ───────────────────────
  it('marks a campaign failed with reason "tab_load_failed_or_redirected" after the 30s tab-load window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-load-fail', platform: 'tiktok' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules, getSchedulingInProgress } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    // Never emit tabs.onUpdated('complete') — waitForTabLoad's 30s timer fires.
    await vi.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();

    // waitForTabLoad has just resolved false; the done() above schedules a microtask.
    await flushMicrotasks();
    await promise;

    expect(__tabCreateCalls).toHaveLength(1);
    expect(getSchedulingInProgress()).toBe(false);

    const telemetry = await poll.getTelemetry();
    expect(telemetry.tiktok?.lastErrorCode).toBe('PLATFORM');
    expect(telemetry.tiktok?.lastErrorReason).toBe('tab_load_failed_or_redirected');
    expect(telemetry.tiktok?.consecutiveFailures).toBeGreaterThan(0);

    const state = await poll.get();
    expect(state.pendingSchedules).toEqual([]);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Test 6: circuit breaker short-circuit ──────────────
  it('skips a campaign whose platform breaker is open, records BREAKER telemetry, and removes it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));

    const { setBreakerState } = await reimportBreaker();
    const future = new Date('2026-07-13T10:00:00.000Z').getTime() + BREAKER_OPEN_MS;
    await setBreakerState({
      openUntil: { instagram: future },
      consecutiveFailures: { instagram: 3 },
      lastUpdatedAt: null,
    });

    const { poll } = await reimportStorage();
    const campaign = makeCampaign({ campaignId: 'c-breaker', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules, getSchedulingInProgress } = await reimportOrchestrator();
    await processPendingSchedules();

    expect(__tabCreateCalls).toHaveLength(0);
    expect(getSchedulingInProgress()).toBe(false);

    const state = await poll.get();
    expect(state.pendingSchedules).toEqual([]);

    const telemetry = await poll.getTelemetry();
    expect(telemetry.instagram?.lastErrorCode).toBe('BREAKER');
    expect(telemetry.instagram?.lastErrorReason).toBe('circuit_breaker_open');
    expect(telemetry.instagram?.consecutiveFailures).toBe(1);

    vi.useRealTimers();
  });

  // ── Test 7: same-campaign retry is NOT attempted today ─
  it('does not retry a failed campaign within the same cycle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-no-retry', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules, getSchedulingInProgress } = await reimportOrchestrator();

    const firstPromise = processPendingSchedules();
    await flushUntilTabCreates(1);
    // Fire SCHEDULE_FAILED so the campaign ends in failure (still removed from queue).
    __sendRuntimeMessage({
      type: 'SCHEDULE_FAILED',
      campaignId: campaign.campaignId,
      reason: 'TEXT_SET_FAILED: caption',
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await firstPromise;

    expect(__tabCreateCalls).toHaveLength(1);
    expect(getSchedulingInProgress()).toBe(false);
    expect((await poll.get()).pendingSchedules).toEqual([]);

    // Calling again should be a no-op — the campaign was removed from the queue.
    const secondPromise = processPendingSchedules();
    await flushMicrotasks();
    await secondPromise;

    expect(__tabCreateCalls).toHaveLength(1);
    expect(getSchedulingInProgress()).toBe(false);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Tab message recording smoke test ─────────────────────
  it('sends START_SCHEDULING to the content script after tab load', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-tabmsg', platform: 'gbp' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);

    // Emit tab 'complete' so waitForTabLoad resolves true — orchestrator then
    // calls chrome.tabs.sendMessage to dispatch START_SCHEDULING. Tab id is 1
    // (first created in this test).
    __emitTabUpdated(1, { status: 'complete' });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    // The orchestrator hasn't yet received SCHEDULE_COMPLETE — quickly resolve
    // via message so the cycle terminates cleanly.
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(__tabMessages.length).toBeGreaterThanOrEqual(1);
    const start = __tabMessages.find(m => (m.msg as { type?: string }).type === 'START_SCHEDULING');
    expect(start).toBeDefined();
    expect(start!.msg as { campaign: { campaignId: string } }).toMatchObject({
      campaign: { campaignId: campaign.campaignId },
    });

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Telemetry for SCHEDULE_FAILED content-script path ───
  it('records parsed failure code+reason from a SCHEDULE_FAILED message', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-failed', platform: 'facebook' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    __sendRuntimeMessage({
      type: 'SCHEDULE_FAILED',
      campaignId: campaign.campaignId,
      reason: 'TEXT_SET_FAILED: input.form',
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const telemetry = await poll.getTelemetry();
    expect(telemetry.facebook?.lastErrorCode).toBe('TEXT_SET_FAILED');
    expect(telemetry.facebook?.lastErrorReason).toBe('input.form');
    expect(telemetry.facebook?.consecutiveFailures).toBe(1);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
