import { assertFetchedUrl, mockFetchHang, mockFetchReject, mockFetchStatus } from './fetch-harness';
import {
  __resetChromeShim,
  __sendRuntimeMessage,
  __tabCreateCalls,
  __tabMessages,
  __emitTabUpdated,
  __emitTabRemoved,
  __setNextTabCreateFails,
  __setNextTabsSendMessageThrows,
  __badge,
} from './setup';
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

  // ─── Rate-limiting: overlapping-cycle guard (processPendingSchedules:95) ──
  it('skips the scheduling cycle when one is already in progress', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-guard', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules, getSchedulingInProgress } = await reimportOrchestrator();
    const firstPromise = processPendingSchedules();
    // Flush past the storage lookup and the empty-queue guard so the first
    // cycle sets `isSchedulingInProgress = true` and opens its tab. THEN call
    // processPendingSchedules a second time — the early-return guard at line 95
    // must short-circuit the second invocation without opening a 2nd tab.
    await flushUntilTabCreates(1);
    expect(getSchedulingInProgress()).toBe(true);
    const secondPromise = processPendingSchedules();
    await secondPromise; // resolves synchronously via the early return

    expect(__tabCreateCalls).toHaveLength(1); // only the first cycle opened a tab

    // Drain the in-flight first cycle so the test cleans up.
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await firstPromise;

    expect(getSchedulingInProgress()).toBe(false);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── Rate-limiting: no delay after the last campaign in a batch ────────
  it('does not wait 90s after the last campaign in a batch completes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    // Single campaign = batch[0] === last. The `i < batch.length - 1` branch
    // must be falsy → no delay(...) call.
    const campaign = makeCampaign({ campaignId: 'c-no-delay-after-last', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    // The promise already resolved: if a 90s delay had been queued, it would
    // still be pending here. Advance a tiny bit and confirm nothing fired.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(__tabCreateCalls).toHaveLength(1);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── scheduleOneCampaign: chrome.tabs.create returns no tab.id ──────────
  it('marks a campaign failed with reason "tab_creation_failed" when chrome.tabs.create returns no tab id', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));

    const { poll } = await reimportStorage();
    const campaign = makeCampaign({ campaignId: 'c-tab-fail', platform: 'facebook' });
    await poll.storeClaimedCampaign(campaign);

    __setNextTabCreateFails(true);
    const { processPendingSchedules, getSchedulingInProgress } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushMicrotasks();
    await flushMicrotasks();
    await promise;

    expect(__tabCreateCalls).toHaveLength(1);
    expect(getSchedulingInProgress()).toBe(false);

    const telemetry = await poll.getTelemetry();
    expect(telemetry.facebook?.lastErrorCode).toBe('PLATFORM');
    expect(telemetry.facebook?.lastErrorReason).toBe('tab_creation_failed');
    expect(telemetry.facebook?.consecutiveFailures).toBe(1);

    const state = await poll.get();
    expect(state.pendingSchedules).toEqual([]);

    vi.useRealTimers();
  });

  // ─── scheduleOneCampaign: chrome.tabs.sendMessage rejects (catch arm) ─
  it('continues waiting after chrome.tabs.sendMessage rejects, then times out at 90s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-send-throws', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    // Emit the complete event BEFORE arming the throw. The tab-complete
    // listener fires synchronously inside __emitTabUpdated, resolving
    // waitForTabLoad. It queues the orchestrator's async callback continuation
    // (which will call chrome.tabs.sendMessage) as a microtask. Arm the
    // throw NOW while we're still synchronous, so the next flush's
    // continuation sees the throw flag set.
    __emitTabUpdated(1, { status: 'complete' });
    __setNextTabsSendMessageThrows(true);
    await flushMicrotasks();
    await flushMicrotasks();

    // Catch path swallowed the error — orchestrator keeps waiting on the 90s
    // scheduling timeout. Advance to fire it.
    await vi.advanceTimersByTimeAsync(90_000);
    await flushMicrotasks();
    await promise;

    expect(__tabMessages.length).toBeGreaterThanOrEqual(1);
    const telemetry = await poll.getTelemetry();
    expect(telemetry.instagram?.lastErrorReason).toBe('timeout');
    expect(telemetry.instagram?.consecutiveFailures).toBe(1);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── SCHEDULING_PROGRESS message arm (listener no-op branch @246) ───────
  it('logs SCHEDULING_PROGRESS messages without resolving the campaign', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-progress', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules, getSchedulingInProgress } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    __emitTabUpdated(1, { status: 'complete' });
    await flushMicrotasks();

    // Send SCHEDULING_PROGRESS — must NOT resolve the campaign (only COMPLETE/FAILED do).
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    __sendRuntimeMessage({
      type: 'SCHEDULING_PROGRESS',
      campaignId: campaign.campaignId,
      step: 'Uploading media',
    });
    await flushMicrotasks();

    expect(getSchedulingInProgress()).toBe(true);
    // A sibling SCHEDULE_COMPLETE for a different campaign must also be ignored.
    __sendRuntimeMessage({
      type: 'SCHEDULE_COMPLETE',
      campaignId: 'someone-else',
      scheduledAt: SCHEDULED_AT,
    });
    await flushMicrotasks();
    expect(getSchedulingInProgress()).toBe(true);
    logSpy.mockRestore();

    // Resolve the actual campaign to drain the cycle.
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(__tabCreateCalls).toHaveLength(1);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── breaker.recordSuccess recorded on success path (async after inner) ──
  it('resets the breaker failure counter after a successful schedule', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-closes-breaker', platform: 'facebook' });
    await poll.storeClaimedCampaign(campaign);

    const { setBreakerState, getBreakerState } = await reimportBreaker();
    // Pre-seed 2 failures (below threshold, breaker not yet open) so a real
    // schedule can still run. recordSuccess on the success path must then
    // clear the counter.
    await setBreakerState({
      openUntil: {},
      consecutiveFailures: { facebook: 2 },
      lastUpdatedAt: null,
    });

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const state = await getBreakerState();
    expect(state.openUntil.facebook).toBeUndefined();
    expect(state.consecutiveFailures.facebook).toBeUndefined();

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── breaker.recordFailure NOT recorded when reason === circuit_breaker_open ──
  it('does not double-count a breaker.open failure in the breaker state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));

    const { setBreakerState, getBreakerState } = await reimportBreaker();
    const future = new Date('2026-07-13T10:00:00.000Z').getTime() + BREAKER_OPEN_MS;
    await setBreakerState({
      openUntil: { instagram: future },
      consecutiveFailures: { instagram: 3 },
      lastUpdatedAt: null,
    });

    const { poll } = await reimportStorage();
    const campaign = makeCampaign({ campaignId: 'c-no-double', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules } = await reimportOrchestrator();
    await processPendingSchedules();

    // The inner Block @306 short-circuits the recordFailure call so the
    // breaker counter must NOT climb to 4.
    const state = await getBreakerState();
    expect(state.consecutiveFailures.instagram).toBe(3);

    vi.useRealTimers();
  });

  // ─── markScheduledOnServer: missing token → early return (line 326) ───
  it('proceeds with scheduling but warns when no auth token is set before marking scheduled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) });
    vi.stubGlobal('fetch', fetchMock);

    const { poll } = await reimportStorage();
    // NOTE: no auth.setToken — getToken() resolves undefined.
    const campaign = makeCampaign({ campaignId: 'c-no-token', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    // markScheduledOnServer short-circuits before reaching fetch — fetch must
    // never have been called.
    expect(fetchMock).not.toHaveBeenCalled();
    // The campaign was still removed from pendingSchedules locally.
    expect((await poll.get()).pendingSchedules).toEqual([]);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── markScheduledOnServer: !res.ok → early return (line 341) ──────────
  it('warns but does not throw when the scheduled-marker POST returns a non-OK status', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    // The first fetch attempt from markScheduledOnServer returns 500.
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-server-500', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Still removed from pendingSchedules (we don't keep it locally even on
    // server-side failure — stale lock scanner handles requeue).
    expect((await poll.get()).pendingSchedules).toEqual([]);
    // Success telemetry was still recorded (the schedule itself did succeed).
    const telemetry = await poll.getTelemetry();
    expect(telemetry.instagram?.lastSuccessAt).toBe(new Date('2026-07-13T10:00:00.000Z').getTime());

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── markScheduledOnServer: body.status !== 'success' (line 347) ───────
  it('warns when the server responds OK but with a non-success JSend envelope', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'error', message: 'Lock expired' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-body-error', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Campaign still removed from pendingSchedules and platform success still recorded.
    expect((await poll.get()).pendingSchedules).toEqual([]);
    expect((await poll.getTelemetry()).instagram?.lastSuccessAt).toBe(new Date('2026-07-13T10:00:00.000Z').getTime());

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── markScheduledOnServer: network error → outer catch-and-warn (Q9 fix (a)) ──
  //
  // Post-Q9 fix (a): `markScheduledOnServer` no longer swallows fetch rejections
  // internally. A rejected `await fetch(...)` propagates to the new marker-only
  // try/catch in `processPendingSchedules`'s loop body, which logs a single
  // `console.warn('[Litoral] markScheduledOnServer threw for campaign ...')` and
  // continues the cycle. The Error instance routes through the `error.message`
  // arm (not the primitive else arm — that's covered by the test below).
  it('swallows a network error from markScheduledOnServer without failing the cycle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-net-err', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { processPendingSchedules, getSchedulingInProgress } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getSchedulingInProgress()).toBe(false);
    expect((await poll.get()).pendingSchedules).toEqual([]);

    // The new outer catch logged the marker throw with the Q9 fix (a) warn prefix
    // and routed the Error through `error instanceof Error ? error.message : error`
    // (truthy arm). The campaign was already removed from pendingSchedules before
    // the marker awaited fetch — Q9 fix (a) explicit ordering contract.
    const markerWarn = warnSpy.mock.calls.find(call =>
      String(call[0] ?? '').includes('[Litoral] markScheduledOnServer threw for campaign c-net-err'),
    );
    expect(markerWarn, 'marker throw must reach the new outer catch arm').toBeDefined();
    expect(markerWarn![1]).toBe('network down');

    warnSpy.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── processPendingSchedules: catch on orchestrator error (line 129) ──
  it('catches a thrown scheduleOneCampaign error and continues processing the next campaign', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    // Two campaigns: c1 has an unsupported platform → scheduleOneCampaign throws
    // at getPlatformScheduleUrl('myspace'); c2 is well-formed and must still run.
    const c1: CampaignPayload = {
      campaignId: 'c-throw',
      restaurantId: 'r',
      platform: 'myspace' as CampaignPayload['platform'],
      assetUrl: 'https://r2.example/asset.png',
      caption: 'hi',
      scheduledTime: '2026-12-15T10:30:00.000Z',
      mediaType: 'image',
    };
    const c2 = makeCampaign({ campaignId: 'c-after-throw', platform: 'instagram' });
    await poll.storeClaimedCampaign(c1);
    await poll.storeClaimedCampaign(c2);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    // c1 throws synchronously inside scheduleOneCampaign at getPlatformScheduleUrl;
    // the catch arm @129 logs + continues, removeCampaign(c1) runs, then the 90s
    // inter-campaign delay must tick before c2's tab is created.
    await flushMicrotasks();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(90_000);
    await flushUntilTabCreates(1);
    completeCampaignViaMessage(c2.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(errSpy).toHaveBeenCalled(); // outer catch logged the throw
    expect(__tabCreateCalls).toHaveLength(1); // only c2 created a tab
    expect((await poll.get()).pendingSchedules).toEqual([]);
    errSpy.mockRestore();

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── parseReason helper branch coverage (snapshot via telemetry) ───────
  it('parseReason falls back to UNKNOWN when the failure reason is undefined', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));

    const { poll } = await reimportStorage();
    const campaign = makeCampaign({ campaignId: 'c-unknown', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    // Send SCHEDULE_FAILED with no reason body — message passes through as-is.
    // We simulate an empty reason by sending the literal empty string, since
    // parseReason('' | undefined) both fall into the !reason branch @62.
    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    __sendRuntimeMessage({
      type: 'SCHEDULE_FAILED',
      campaignId: campaign.campaignId,
      reason: '',
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const telemetry = await poll.getTelemetry();
    expect(telemetry.instagram?.lastErrorCode).toBe('UNKNOWN');
    expect(telemetry.instagram?.lastErrorReason).toBe('Unknown failure');

    vi.useRealTimers();
  });

  it('parseReason classifies a no-colon reason as PLATFORM with the full string as message', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));

    const { poll } = await reimportStorage();
    const campaign = makeCampaign({ campaignId: 'c-no-colon', platform: 'facebook' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    __sendRuntimeMessage({
      type: 'SCHEDULE_FAILED',
      campaignId: campaign.campaignId,
      reason: 'tab_load_failed_or_redirected',
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const telemetry = await poll.getTelemetry();
    expect(telemetry.facebook?.lastErrorCode).toBe('PLATFORM');
    expect(telemetry.facebook?.lastErrorReason).toBe('tab_load_failed_or_redirected');

    vi.useRealTimers();
  });

  it('parseReason rejects a lowercase code prefix and falls back to PLATFORM', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));

    const { poll } = await reimportStorage();
    const campaign = makeCampaign({ campaignId: 'c-lower', platform: 'tiktok' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    __sendRuntimeMessage({
      type: 'SCHEDULE_FAILED',
      campaignId: campaign.campaignId,
      reason: 'login_required: please re-auth',
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const telemetry = await poll.getTelemetry();
    expect(telemetry.tiktok?.lastErrorCode).toBe('PLATFORM');
    expect(telemetry.tiktok?.lastErrorReason).toBe('login_required: please re-auth');

    vi.useRealTimers();
  });

  // ─── waitForTabLoad: stale duplicate onUpdated ignored (line 378) ───────
  it('ignores a duplicate tab-complete event after waitForTabLoad has already resolved', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-dup-event', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    // First complete fires waitForTabLoad's resolve(true). The SECOND 'complete'
    // arrives before the orchestrator's sendMessage is awaited; the inner
    // `if (resolved) return;` arm @378 must early-out without re-resolving.
    __emitTabUpdated(1, { status: 'complete' });
    __emitTabUpdated(1, { status: 'complete' });
    await flushMicrotasks();

    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    // Only one tab created — the duplicate complete did not double-fire the
    // resolve(true) call (which would have short-circuited waitForTabLoad
    // erroneously and skipped sendMessage).
    expect(__tabCreateCalls).toHaveLength(1);
    // sendMessage still ran exactly once.
    expect(__tabMessages.filter(m => (m.msg as { type?: string }).type === 'START_SCHEDULING')).toHaveLength(1);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── getPlatformScheduleUrl: throws on unknown platform ────────────────
  it('throws inside scheduleOneCampaign for an unknown platform (caught by outer try/catch)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));

    const { poll } = await reimportStorage();
    // Place a campaign with an unsupported platform straight into storage.
    // The orchestrator will read it, attempt getPlatformScheduleUrl('myspace'),
    // throw, and the catch arm of processPendingSchedules must log + removeCampaign.
    const bad: CampaignPayload = {
      campaignId: 'c-bad-platform',
      restaurantId: 'r',
      platform: 'myspace' as CampaignPayload['platform'],
      assetUrl: 'https://r2.example/asset.png',
      caption: 'hi',
      scheduledTime: '2026-12-15T10:30:00.000Z',
      mediaType: 'image',
    };
    await poll.storeClaimedCampaign(bad);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { processPendingSchedules } = await reimportOrchestrator();
    await processPendingSchedules();

    expect(errSpy).toHaveBeenCalled();
    expect(__tabCreateCalls).toHaveLength(0);
    // Caught → removed from queue (stale lock scanner requeues server-side).
    expect((await poll.get()).pendingSchedules).toEqual([]);
    errSpy.mockRestore();

    vi.useRealTimers();
  });

  // ─── chrome.tabs.onRemoved listener: drops the tab tracking entry ─────
  it('clears the active scheduling tab entry when chrome.tabs.onRemoved fires for it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-onremoved', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    // Satisfy waitForTabLoad first so the tab-loaded timeout cannot fire and
    // the only remaining pending timer is the 90s scheduling timeout.
    __emitTabUpdated(1, { status: 'complete' });
    await flushMicrotasks();

    // Simulate the user closing the tab mid-scheduling. The onRemoved listener
    // logs and removes the entry from activeSchedulingTabs; it must NOT resolve
    // the still-pending scheduleOneCampaign (that waits for the 90s timeout).
    __emitTabRemoved(1);
    await flushMicrotasks();

    // No SCHEDULE_COMPLETE/FAILED will arrive — only the 90s global timeout
    // resolves the campaign.
    await vi.advanceTimersByTimeAsync(90_000);
    await flushMicrotasks();
    await promise;

    const telemetry = await poll.getTelemetry();
    expect(telemetry.instagram?.lastErrorReason).toBe('timeout');

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── updateBadge: clears badge text when queue drains ─────────────────
  it('clears the badge when no campaigns remain after a cycle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-badge', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(__badge.text).toBe('');

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── parseReason: empty tail falls back to the full reason string (L68) ──
  it('parseReason falls back to the original reason when the tail is empty after trimming', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));

    const { poll } = await reimportStorage();
    const campaign = makeCampaign({ campaignId: 'c-empty-tail', platform: 'facebook' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    // reason has the SCREAMING_SNAKE code followed by ':' + only whitespace.
    // parseReason returns the head as `code` and `tail || reason` → full reason.
    __sendRuntimeMessage({
      type: 'SCHEDULE_FAILED',
      campaignId: campaign.campaignId,
      reason: 'LOGIN_REQUIRED:   ',
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const telemetry = await poll.getTelemetry();
    expect(telemetry.facebook?.lastErrorCode).toBe('LOGIN_REQUIRED');
    expect(telemetry.facebook?.lastErrorReason).toBe('LOGIN_REQUIRED:   ');

    vi.useRealTimers();
  });

  // ─── markScheduledOnServer: body without `message` → 'unknown error' (L350)
  it('warns "unknown error" when the server rejects a schedule marker without a message field', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'error' }), // no `message` field
    });
    vi.stubGlobal('fetch', fetchMock);

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-no-msg', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    // Find the warn call that begins with the campaignId — the catch-all one
    // logs "Server rejected schedule marker for campaign c-no-msg:" followed by
    // the body.message ?? 'unknown error' fallback.
    const rejectedCall = warnSpy.mock.calls.find(call =>
      String(call[0] ?? '').includes('Server rejected schedule marker for campaign c-no-msg'),
    );
    expect(rejectedCall).toBeDefined();
    expect(rejectedCall![1]).toBe('unknown error');
    warnSpy.mockRestore();

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── markScheduledOnServer: non-Error fetch rejection (NEW marker-only catch else arm)
  //
  // Post-Q9 fix (a): with the internal swallow removed from `markScheduledOnServer`, a
  // non-Error primitive rejection (e.g. a string) propagates to the new marker-only
  // try/catch in the orchestrator loop body. The `error instanceof Error ? error.message
  // : error` else arm of THAT new catch arm logs the primitive itself — this is the
  // coverable branch the spec's `c8 ignore` fence around the else arm refers to (it gets
  // covered by THIS test, hence the ignore is only around the unreachable defensive
  // primitive-throw-fallback comment, not the whole else arm). Verifies the new wrapper's
  // diagnostic line is the Q9 fix (a) marker prefix (not the legacy "Network error
  // marking campaign..." message that lived inside `markScheduledOnServer`'s removed
  // internal catch).
  it('logs a non-Error rejection reason from markScheduledOnServer without throwing (Q9 fix (a) marker-only catch else arm)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    // Reject with a primitive string — production's catch arm uses
    // `error instanceof Error ? error.message : error`, taking the else branch.
    const fetchMock = vi.fn().mockRejectedValue('connection reset');
    vi.stubGlobal('fetch', fetchMock);

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-string-rej', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    // The legacy `console.error('Network error marking campaign ...')` log lived
    // inside `markScheduledOnServer`'s removed internal catch. Post-Q9 fix (a),
    // the marker throw routes to the new outer wrapper which logs the Q9 prefix
    // via `console.warn` instead. Search BOTH spies to be explicit about which
    // surface the log landed on.
    const markerWarn = warnSpy.mock.calls.find(call =>
      String(call[0] ?? '').includes('[Litoral] markScheduledOnServer threw for campaign c-string-rej'),
    );
    expect(markerWarn, 'non-Error rejection must reach the new marker-only catch arm').toBeDefined();
    // The else arm produces the primitive itself, not error.message.
    expect(markerWarn![1]).toBe('connection reset');
    warnSpy.mockRestore();

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── waitForTabLoad: ignores onUpdated for an unrelated tab id (L377) ──
  it('ignores tab-complete events for tabs unrelated to the active scheduling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) }));

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-wrong-tab', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules, getSchedulingInProgress } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    // Emit complete for a stray tab id that no waitForTabLoad registered for.
    // The orchestrator's listener should early-return at the
    // `_tabId !== tabId` arm without resolving the active scheduling.
    __emitTabUpdated(999, { status: 'complete' });
    await flushMicrotasks();
    expect(getSchedulingInProgress()).toBe(true);

    // Now emit complete for the real tab — should resolve and finalize.
    __emitTabUpdated(1, { status: 'complete' });
    await flushMicrotasks();
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(__tabCreateCalls).toHaveLength(1);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── Phase 2.4 E1: 401 from markScheduledOnServer is treated like a generic !ok failure ──
  //
  // The orchestrator's `markScheduledOnServer` (lines 338–375) does NOT branch
  // on 401 specifically — the only fork is `!res.ok` (line 355) followed by
  // `body.status === 'error'` (line 361). A 401 hits the `!res.ok` arm
  // identically to a 500: log `console.error`, return. The schedule is still
  // counted as success *locally* — success telemetry is recorded and the
  // campaign is removed from pendingSchedules (lines 152/160 run after
  // markScheduledOnServer resolves via its early `return`). The 401 detection
  // + token-clear path lives in `index.ts`'s fetchQueue/claimCampaign handlers,
  // NOT here. This test LOCKS IN that contract for the marker surface so a
  // future refactor that adds 401 handling to the orchestrator will surface as
  // a failing test (a deliberate 2.4 changelog entry).
  it('E1: treats a 401 from markScheduledOnServer like a non-OK failure — logs, returns, still records success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    // mockFetchStatus(401, ...) derives ok=false from the 2xx range, so production
    // takes the `!res.ok` arm at line 355 BEFORE awaiting res.json(). The JSend
    // body is unreachable on this path yet provided here for completeness.
    const fetchMock = vi.fn().mockResolvedValue(mockFetchStatus(401, { status: 'error', message: 'Unauthorized' }));
    vi.stubGlobal('fetch', fetchMock);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-401-marker', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules, getSchedulingInProgress } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    // The marker POST hit the server exactly once at /queue/scheduled with POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    assertFetchedUrl(fetchMock, '/queue/scheduled', 'POST');

    // Contract: 401 hits the `!res.ok` arm — console.error logs the status code.
    const markerErr = errSpy.mock.calls.find(call =>
      String(call[0] ?? '').includes('Failed to mark campaign c-401-marker as scheduled on server: 401'),
    );
    expect(markerErr, '401 should reach the !res.ok arm and log the status code').toBeDefined();

    // Local success was still recorded (the schedule itself succeeded; the
    // marker is best-effort w.r.t. local telemetry).
    expect(getSchedulingInProgress()).toBe(false);
    expect(__tabCreateCalls).toHaveLength(1);
    expect((await poll.get()).pendingSchedules).toEqual([]);

    const telemetry = await poll.getTelemetry();
    expect(telemetry.instagram?.lastSuccessAt).toBe(new Date('2026-07-13T10:00:00.000Z').getTime());
    expect(telemetry.instagram?.lastErrorCode).toBeNull();

    // The orchestrator does NOT touch the auth token on 401 — that's index.ts's
    // responsibility on the fetchQueue/claimCampaign paths, not the marker's.
    expect(await auth.getToken()).toBe('test-token');

    errSpy.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── Phase 2.4 E2 (Q9 fix (a)): hanging marker fetch no longer blocks the cycle ─
  //
  // BEFORE Q9 fix (a): `scheduleOneCampaign` clears the 90-second
  // `SCHEDULING_TIMEOUT_MS` timer the moment SCHEDULE_COMPLETE arrives
  // (the `done()` callback runs `clearTimeout(timeout)` at line 225), and
  // `processPendingSchedules` awaited `markScheduledOnServer` BEFORE
  // `removeCampaign` and `recordPlatformSuccess`. A never-resolving marker
  // fetch therefore hung the entire scheduling cycle indefinitely — the 90s
  // global timeout could not rescue it (already cleared), `removeCampaign`
  // never ran (campaign stayed pending), and `recordPlatformSuccess` never
  // ran (no success telemetry).
  //
  // AFTER Q9 fix (a) (2026-07-18, Phase 2.4): the `await markScheduledOnServer`
  // call has been moved AFTER `removeCampaign` and the per-platform telemetry
  // updates, and wrapped in its own try/catch so a future marker throw cannot
  // cascade as an orchestrator-level error. A never-resolving marker fetch
  // therefore no longer blocks local-state convergence: the campaign is
  // removed from pendingSchedules, the success telemetry is recorded, and
  // the cycle's promise resolves (it does NOT wait for the marker promise).
  // The marker promise stays pending in the background; the stale lock
  // scanner auto-reverts the server-side campaign lock if the marker POST
  // truly never landed.
  //
  // This pins the NEW contract introduced by Q9 fix (a). The previous
  // behavior (hang blocks the cycle) is intentionally no longer enforced.
  it('E2 (Q9 fix (a)): a hanging marker fetch no longer blocks the cycle — local state converges (campaign removed, success telemetry recorded) while the marker call stays pending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    const fetchMock = mockFetchHang();
    vi.stubGlobal('fetch', fetchMock);

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-hang-marker', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules, getSchedulingInProgress } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    // Drive SCHEDULE_COMPLETE — done() resolves inner and clears the 90s timer.
    // Under the Q9 fix (a), `removeCampaign` + `recordPlatformSuccess` now run
    // BEFORE `await markScheduledOnServer(...)`, so the cycle's promise resolves
    // even though the marker fetch is still pending.
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks(40);

    // Flush past any microtask queue; the marker fetch hangs but the cycle
    // no longer awaits it before local-state convergence.
    await vi.advanceTimersByTimeAsync(120_000);
    await flushMicrotasks(40);

    // The marker fetch was initiated exactly once and is still hanging.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    assertFetchedUrl(fetchMock, '/queue/scheduled', 'POST');

    // KEY Q9 fix (a) assertions — local state converged despite the hang.
    // The campaign is removed from pendingSchedules (not 1 — 0).
    expect((await poll.get()).pendingSchedules).toEqual([]);

    // Success telemetry was recorded (recordPlatformSuccess ran BEFORE the marker).
    const telemetry = await poll.getTelemetry();
    expect(telemetry.instagram?.lastSuccessAt).toBe(new Date('2026-07-13T10:00:00.000Z').getTime());
    expect(telemetry.instagram?.lastErrorCode).toBeNull();

    // The cycle's promise RESOLVES despite the still-pending marker fetch.
    // This is the central behavior change from Q9 fix (a). Drain the cycle
    // and confirm `isSchedulingInProgress` dropped back to false.
    await promise;
    expect(getSchedulingInProgress()).toBe(false);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── Phase 2.4 E3 (Q9 fix (a)): TypeError('Failed to fetch') reaches the Error arm ─
  //
  // The existing rejection test above covers `new Error('network down')`.
  // Chrome's ACTUAL offline sentinel is `TypeError('Failed to fetch')` — the
  // browser's fetch implementation throws this specific TypeError on a network
  // outage (DOMException-safe, see fetch spec). Post-Q9 fix (a): the rejection
  // propagates through `markScheduledOnServer` (whose internal swallow was removed)
  // and is caught by the new marker-only try/catch in `processPendingSchedules`.
  // Because TypeError extends Error, it routes through the new catch's
  // `error instanceof Error ? error.message : error` (truthy arm — NOT the
  // primitive else arm covered by the `'connection reset'` test above). The
  // marker log line therefore reports the message string `'Failed to fetch'`,
  // not the TypeError object. This pins the offline-sentinel contract for the
  // 2.4 changelog (revised Q9 fix (a) variant): a browser-side outage is
  // observable end-to-end as a `console.warn('[Litoral] markScheduledOnServer
  // threw for campaign ...', 'Failed to fetch')` rather than the legacy
  // `console.error('Network error marking campaign ...', 'Failed to fetch')`.
  it('E3 (Q9 fix (a)): a TypeError("Failed to fetch") rejection reaches the new marker-only catch Error arm and logs error.message', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    const fetchMock = mockFetchReject(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-typeerr', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

    const { processPendingSchedules, getSchedulingInProgress } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    // The fetch was called once and rejected with TypeError.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    assertFetchedUrl(fetchMock, '/queue/scheduled', 'POST');

    // The new marker-only catch routed through `error instanceof Error ? error.message : error`.
    // TypeError extends Error → truthy arm → logs `error.message` (the string)
    // rather than the TypeError object itself.
    const markerWarn = warnSpy.mock.calls.find(call =>
      String(call[0] ?? '').includes('[Litoral] markScheduledOnServer threw for campaign c-typeerr'),
    );
    expect(markerWarn, 'TypeError rejection must reach the new marker-only catch arm').toBeDefined();
    expect(markerWarn![1]).toBe('Failed to fetch');
    // Negative assertion: must NOT be the primitive-else output (the TypeError
    // object) — that arm would log the object, not `'Failed to fetch'`.
    expect(markerWarn![1]).not.toBeInstanceOf(TypeError);

    // Cycle degrades gracefully: success telemetry was recorded BEFORE the marker
    // awaited the fetch (Q9 fix (a) explicit ordering), so the campaign is removed
    // from pendingSchedules.
    expect(getSchedulingInProgress()).toBe(false);
    expect((await poll.get()).pendingSchedules).toEqual([]);
    const telemetry = await poll.getTelemetry();
    expect(telemetry.instagram?.lastSuccessAt).toBe(new Date('2026-07-13T10:00:00.000Z').getTime());
    expect(telemetry.instagram?.lastErrorCode).toBeNull();

    // The orchestrator does not clear the token on a TypeError — that's index.ts's
    // job on 401 paths, and the marker surface deliberately doesn't touch auth.
    expect(await auth.getToken()).toBe('test-token');

    warnSpy.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── Q9 fix (a): marker throw is caught by the marker-only try/catch ─
  //
  // Composite test pinning the NEW failure mode the Q9 fix (a) makes possible.
  // Two campaigns in the queue: the first completes successfully but its
  // marker-fetch throws (e.g. a TypeError from a malformed server response
  // mid-flight — different from a plain fetch-rejection-only scenario).
  // Post-Q9 fix (a), the new marker-only try/catch in `processPendingSchedules`'s
  // loop body swallows the throw, logs a single
  // `console.warn('[Litoral] markScheduledOnServer threw for campaign ...')`,
  // and the cycle CONTINUES to the next campaign (the 90s inter-campaign delay
  // fires and the SECOND campaign is scheduled cleanly). This pins:
  //   (a) removeCampaign(c1) was called (campaign removed from local storage)
  //   (b) recordPlatformSuccess(c1) was called (success telemetry converged
  //       BEFORE the marker awaited fetch — Q9 fix (a) explicit ordering)
  //   (c) console.warn called with the Q9 fix (a) marker prefix
  //   (d) cycle continues to the next campaign (c2) — runs to completion
  it('Q9 fix (a): a thrown marker fetch is caught by the marker-only try/catch — local state converged, warning logged, cycle continues to the next campaign', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    // First fetch (c1's marker) rejects with a TypeError — represents a network
    // outage mid-flight. Second fetch (c2's marker) succeeds.
    let fetchCall = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      fetchCall += 1;
      if (fetchCall === 1) return Promise.reject(new TypeError('throw-marker-c1'));
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'success' }) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const c1 = makeCampaign({ campaignId: 'c-throw-marker-1', platform: 'instagram' });
    const c2 = makeCampaign({ campaignId: 'c-throw-marker-2', platform: 'facebook' });
    await poll.storeClaimedCampaign(c1);
    await poll.storeClaimedCampaign(c2);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { processPendingSchedules, getSchedulingInProgress } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    // First campaign: complete the schedule; the marker then throws a TypeError
    // which the new marker-only try/catch swallows.
    await flushUntilTabCreates(1);
    completeCampaignViaMessage(c1.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    // Advance through the 90s inter-campaign delay → second campaign's tab opens.
    await vi.advanceTimersByTimeAsync(90_000);
    await flushUntilTabCreates(2);
    completeCampaignViaMessage(c2.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    // (a) Both campaigns removed from pendingSchedules (cycle progressed past c1
    // despite the marker throw — Q9 fix (a) core behavior; previously the cycle
    // would have hung and c2 would never have been touched).
    expect((await poll.get()).pendingSchedules).toEqual([]);

    // (b) Success telemetry was recorded for BOTH campaigns (the marker throw on
    // c1 did not gate recordPlatformSuccess, since telemetry now runs BEFORE the
    // marker await per Q9 fix (a)). The `lastSuccessAt` timestamps use
    // `Date.now()` at the point of `recordPlatformSuccess`; c1's ran at the
    // base setSystemTime (10:00:00) while c2's ran AFTER the 90s inter-campaign
    // delay was advanced (10:01:30) — so the two timestamps differ by exactly
    // 90_000ms.
    const telemetry = await poll.getTelemetry();
    expect(telemetry.instagram?.lastSuccessAt).toBe(new Date('2026-07-13T10:00:00.000Z').getTime());
    expect(telemetry.instagram?.lastErrorCode).toBeNull();
    expect(telemetry.facebook?.lastSuccessAt).toBe(new Date('2026-07-13T10:01:30.000Z').getTime());
    expect(telemetry.facebook?.lastErrorCode).toBeNull();

    // (c) The marker throw for c1 was logged via the new Q9 fix (a) marker-only
    // catch's `console.warn` with the exact prefix specified by the fix.
    const c1Warn = warnSpy.mock.calls.find(call =>
      String(call[0] ?? '').includes('[Litoral] markScheduledOnServer threw for campaign c-throw-marker-1'),
    );
    expect(c1Warn, 'Q9 fix (a) marker-only catch must log the throw with its prefix').toBeDefined();
    expect(c1Warn![1]).toBe('throw-marker-c1');
    // No equivalent warning for c2 — its marker call succeeded, so the new catch
    // arm never fired for the second campaign.
    const c2Warn = warnSpy.mock.calls.find(call =>
      String(call[0] ?? '').includes('[Litoral] markScheduledOnServer threw for campaign c-throw-marker-2'),
    );
    expect(c2Warn).toBeUndefined();

    // (d) The cycle completed: `isSchedulingInProgress` is false, and both campaigns'
    // tabs were created during the cycle (proving c2 ran after c1's marker threw).
    expect(getSchedulingInProgress()).toBe(false);
    expect(__tabCreateCalls).toHaveLength(2);

    // Both fetch calls happened (one per marker), confirming c1's marker attempt
    // was initiated and c2's marker attempt completed (res.ok path).
    expect(fetchMock).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
