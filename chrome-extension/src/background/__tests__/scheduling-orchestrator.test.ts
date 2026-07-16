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

  // ─── markScheduledOnServer: network error → catch-and-warn (line 353) ──
  it('swallows a network error from markScheduledOnServer without failing the cycle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const campaign = makeCampaign({ campaignId: 'c-net-err', platform: 'instagram' });
    await poll.storeClaimedCampaign(campaign);

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

  // ─── markScheduledOnServer: non-Error fetch rejection (L356 else arm) ──
  it('logs a non-Error rejection reason from markScheduledOnServer without throwing', async () => {
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

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { processPendingSchedules } = await reimportOrchestrator();
    const promise = processPendingSchedules();

    await flushUntilTabCreates(1);
    completeCampaignViaMessage(campaign.campaignId);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const netErrCall = errSpy.mock.calls.find(call =>
      String(call[0] ?? '').includes('Network error marking campaign c-string-rej as scheduled:'),
    );
    expect(netErrCall).toBeDefined();
    // The else arm produces the primitive itself, not error.message.
    expect(netErrCall![1]).toBe('connection reset');
    errSpy.mockRestore();

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
});
