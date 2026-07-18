/**
 * Phase 2.4 Error Injection Tests — Background service-worker poll/claim/auth
 * pipeline (`chrome-extension/src/background/index.ts`).
 *
 * This is the centerpiece of ROADMAP Phase 2.4: the first-ever unit-test
 * coverage for the poll/claim/auth/backoff/notification pipeline that
 * orchestrates the Litoral chrome-extension's queue loop. `index.ts` had ZERO
 * unit tests prior to this file.
 *
 * Isolation strategy
 * ------------------
 * `index.ts` installs its `chrome.runtime.*` and `chrome.alarms.onAlarm`
 * listeners at module top level (side effect of import) and keeps a
 * module-scoped `popupBreaker = new CircuitBreaker()`. To get a pristine
 * pipeline per test we:
 *  - call `__resetChromeShim()` to wipe the in-memory chrome shim,
 *  - stub the missing `chrome.runtime.onInstalled` / `onStartup` lifecycle
 *    hooks (the shim only models the message + alarm channels) so `index.ts`
 *    can register its remaining listeners without crashing,
 *  - `vi.resetModules()` + fresh `await import('../index')` per test so
 *    `popupBreaker` and every top-level `const` is re-instantiated,
 *  - `vi.unstubAllGlobals()` in `afterEach` to drop the per-test `fetch`
 *    mocks installed via `installFetchSequence` / `vi.stubGlobal('fetch', ...)`,
 *  - silence `console.log/warn/error` per test (production logs liberally).
 *
 * Scheduling orchestrator is NEVER actually run from these tests: we stub
 * `../scheduling-orchestrator` with a `processPendingSchedules` mock BEFORE
 * importing `index.ts` so the poll loop never drags the real scheduler in.
 * That keeps each test focused on just the poll/claim/backoff surface.
 */

import {
  installFetchSequence,
  mockFetchHang,
  mockFetchJson,
  mockFetchReject,
  mockFetchStatus,
  assertFetchedUrl,
} from './fetch-harness';
import { __resetChromeShim, __emitAlarm, __badge, __notifications, __sentMessages, __registeredScripts } from './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampaignPayload, PollStatusPayload, PopupMessage, PlatformCode } from '@extension/shared';

// ─── Helpers ─────────────────────────────────────────────

const flushMicrotasks = async (iterations = 30) => {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
};

// Drain BOTH pending Promise microtasks AND any fake-timer-driven macrotasks
// (e.g. chrome.alarms.create scheduling). The poll loop chains several awaits
// (fetch → handlePollSuccess → markPollSuccess / setPollBackoff /
// reschedulePollAlarm / createPollAlarm) each of which is a separate Promise
// tick; advancing fake timers also flushes microtasks queued by those timer
// callbacks. Mirrors the pattern used in scheduling-orchestrator.test.ts.
const flushAsync = async (iterations = 8) => {
  for (let i = 0; i < iterations; i++) {
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
  }
};

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

const NO_OP = () => {};

const reimportStorage = async () => {
  const mod = await import('@extension/storage');
  return { poll: mod.extensionPollStorage, auth: mod.extensionAuthStorage };
};

const reimportBreaker = async () => {
  const mod = await import('../circuit-breaker');
  return { setBreakerState: mod.setBreakerState, getBreakerState: mod.getBreakerState };
};

const installLifecycleStubs = () => {
  (chrome.runtime as unknown as { onInstalled: unknown }).onInstalled = { addListener: vi.fn(NO_OP) };
  (chrome.runtime as unknown as { onStartup: unknown }).onStartup = { addListener: vi.fn(NO_OP) };
};

const installOrchestratorMock = () => {
  const processPendingSchedules = vi.fn(async () => {});
  vi.doMock('../scheduling-orchestrator', () => ({
    processPendingSchedules,
    getSchedulingInProgress: () => false,
  }));
  return { processPendingSchedules };
};

type OnMessageHandler = (msg: PopupMessage, sender: unknown, sendResponse: (resp: unknown) => void) => boolean;

const captureOnMessageListener = async (importIndex: () => Promise<unknown>) => {
  let captured: OnMessageHandler | null = null;
  const addSpy = vi.spyOn(chrome.runtime.onMessage, 'addListener');
  // The shim's onMessage.addListener accepts any listener shape; `@types/chrome`
  // declares the chrome.Event callback signature with `chrome.runtime.MessageSender`,
  // which is stricter than the test needs. Assigning the implementation through
  // an untyped const avoids the stricter-parameter variance check.
  const captor = (fn: OnMessageHandler): void => {
    captured = fn;
  };
  addSpy.mockImplementation(captor as never);
  await importIndex();
  addSpy.mockRestore();
  if (!captured) throw new Error('onMessage listener was never registered');
  return captured;
};

/**
 * Read the alarm stored in the shim and narrow to the shape the shim actually
 * preserves (the in-memory record keeps `delayInMinutes` even though
 * `@types/chrome`'s public `Alarm` interface omits it — Chrome's real API
 * normalizes one-shot alarms to `scheduledTime`, but the shim does not).
 * Tests assert on whichever field the production call used.
 */
const getAlarm = async (
  name: string,
): Promise<
  | {
      name: string;
      scheduledTime?: number;
      periodInMinutes?: number;
      delayInMinutes?: number;
    }
  | undefined
> =>
  chrome.alarms.get(name) as Promise<
    typeof undefined | { name: string; scheduledTime?: number; periodInMinutes?: number; delayInMinutes?: number }
  >;

const dispatchMessage = (
  listener: (msg: PopupMessage, sender: unknown, sendResponse: (resp: unknown) => void) => boolean,
  msg: PopupMessage,
): { sendResponse: ReturnType<typeof vi.fn> } => {
  const sendResponse = vi.fn();
  listener(msg, {}, sendResponse);
  return { sendResponse };
};

const EPOCH = new Date('2026-07-17T10:00:00.000Z');

// ─── Per-test isolation ─────────────────────────────────

beforeEach(async () => {
  __resetChromeShim();
  installLifecycleStubs();
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(NO_OP);
  vi.spyOn(console, 'warn').mockImplementation(NO_OP);
  vi.spyOn(console, 'error').mockImplementation(NO_OP);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// describe: pollForCampaigns — API failure injection
// ─────────────────────────────────────────────────────────────────────────

describe('pollForCampaigns — API failure injection', () => {
  // T1 — A 500 from /queue lands in the non-401 error arm: first failure
  // applies the 1-minute backoff step, sets the alarm's delayInMinutes, and
  // neither broadcasts AUTH_REQUIRED nor shows a notification. No badge is
  // touched (remaining the empty default) since the failure path skips
  // updateBadgeFromStorage until the 6-failure threshold.
  it('T1: 500 from /queue → handlePollError(false), backoff step 1, no notification, no AUTH_REQUIRED', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const fetchMock = installFetchSequence([mockFetchStatus(500)]);
    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    installOrchestratorMock();

    await import('../index');
    __emitAlarm({ name: 'campaign-queue-poll' });
    await flushMicrotasks();

    assertFetchedUrl(fetchMock, '/api/extension/queue', 'GET');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(__notifications.size).toBe(0);
    expect(__sentMessages.some(m => (m as { type?: string } | null)?.type === 'AUTH_REQUIRED')).toBe(false);
    expect(__badge.text).toBe('');

    const state = await poll.get();
    expect(state.consecutiveFailures).toBe(1);
    expect(state.lastPollError).toBe('Server error: 500');
    expect(state.pollFailures).toHaveLength(1);

    expect(await poll.getPollBackoff()).toBe(1);

    const alarm = await getAlarm('campaign-queue-poll');
    expect(alarm?.delayInMinutes).toBe(1);
  });

  // T2 — 401 from /queue routes through isApiUnauthorized=true: token cleared,
  // 🔑 badge set, AUTH_REQUIRED broadcast. No backoff cadence is applied (the
  // unauthorized guard skips the step table entirely) and no notification fires.
  it('T2: 401 from /queue → clearToken, 🔑 badge, AUTH_REQUIRED broadcast, no backoff, no notification', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    installFetchSequence([mockFetchStatus(401)]);
    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    installOrchestratorMock();

    await import('../index');
    __emitAlarm({ name: 'campaign-queue-poll' });
    await flushMicrotasks();

    expect(await auth.hasToken()).toBe(false);
    expect(__badge.text).toBe('🔑');
    expect(__badge.color).toBe('#9e3d00');
    expect(__sentMessages.some(m => (m as { type?: string } | null)?.type === 'AUTH_REQUIRED')).toBe(true);
    expect(__notifications.size).toBe(0);
    expect(await poll.getPollBackoff()).toBeNull();

    const alarm = await getAlarm('campaign-queue-poll');
    expect(alarm).toBeUndefined();

    const state = await poll.get();
    expect(state.consecutiveFailures).toBe(1);
  });

  // T3 — Offline simulates a `TypeError('Failed to fetch')` rejection. The
  // outer try/catch in pollForCampaigns converts it to handlePollError(false)
  // so the non-401 backoff applies. No AUTH_REQUIRED, no notification, token
  // must survive (we didn't clear it).
  it('T3: offline — fetch rejects with TypeError("Failed to fetch") → non-401 backoff, no AUTH_REQUIRED, no notification', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    vi.stubGlobal('fetch', mockFetchReject(new TypeError('Failed to fetch')));
    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    installOrchestratorMock();

    await import('../index');
    __emitAlarm({ name: 'campaign-queue-poll' });
    await flushMicrotasks();

    const state = await poll.get();
    expect(state.lastPollError).toBe('Failed to fetch');
    expect(state.consecutiveFailures).toBe(1);
    expect(await poll.getPollBackoff()).toBe(1);

    expect(__sentMessages.some(m => (m as { type?: string } | null)?.type === 'AUTH_REQUIRED')).toBe(false);
    expect(__notifications.size).toBe(0);

    expect(await auth.hasToken()).toBe(true);
  });

  // T4 — Successful /queue response with two campaigns, but the FIRST claim
  // returns 401. The loop bails out immediately (abort on 401) and never
  // attempts the second claim — only ONE claim fetch is observed, token is
  // cleared, AUTH_REQUIRED fires, nothing is stored into pendingSchedules.
  it('T4: queue ok → first claim returns 401 → aborts rest, clearToken, AUTH_REQUIRED', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const c1 = makeCampaign({ campaignId: 'c-claim-401-1', platform: 'instagram' });
    const c2 = makeCampaign({ campaignId: 'c-claim-401-2', platform: 'facebook' });
    const fetchMock = installFetchSequence([
      mockFetchJson({ status: 'success', data: { campaigns: [c1, c2] } }),
      mockFetchStatus(401),
    ]);
    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    installOrchestratorMock();

    await import('../index');
    __emitAlarm({ name: 'campaign-queue-poll' });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    assertFetchedUrl(fetchMock, '/api/extension/queue/claim', 'POST');

    expect((await poll.get()).pendingSchedules).toHaveLength(0);
    expect(await auth.hasToken()).toBe(false);
    expect(__sentMessages.some(m => (m as { type?: string } | null)?.type === 'AUTH_REQUIRED')).toBe(true);
  });

  // T5 — Non-401 claim failure (500) does NOT abort the batch: CLAIM C1's 500
  // is logged-and-skipped, then CLAIM C2 succeeds and stores the campaign.
  // Token stays, no AUTH_REQUIRED, and processPendingSchedules is invoked
  // (asserted via the orchestrator mock). Two claim calls happened.
  it('T5: queue ok → claim returns 500 (non-401) → continue to next campaign, no AUTH_REQUIRED', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const c1 = makeCampaign({ campaignId: 'c-claim-500', platform: 'instagram' });
    const c2 = makeCampaign({ campaignId: 'c-claim-ok', platform: 'facebook' });
    const fetchMock = installFetchSequence([
      mockFetchJson({ status: 'success', data: { campaigns: [c1, c2] } }),
      mockFetchStatus(500),
      mockFetchJson({ status: 'success', data: { claimed: true } }),
    ]);
    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const { processPendingSchedules } = installOrchestratorMock();

    await import('../index');
    __emitAlarm({ name: 'campaign-queue-poll' });
    await flushAsync();

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const pending = (await poll.get()).pendingSchedules;
    expect(pending.map(c => c.campaignId)).toEqual([c2.campaignId]);

    expect(await auth.hasToken()).toBe(true);
    expect(__sentMessages.some(m => (m as { type?: string } | null)?.type === 'AUTH_REQUIRED')).toBe(false);
    expect(processPendingSchedules).toHaveBeenCalledTimes(1);
  });

  // T6 — A claim that returns JSend success with claimed:false is idempotent:
  // storage is NOT touched, pendingSchedules stays empty. The orchestrator
  // still gets driven (success path still calls processPendingSchedules
  // regardless of how many campaigns were actually claimed).
  it('T6: queue ok → claim returns claimed:false → idempotent path, NOT stored', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const c1 = makeCampaign({ campaignId: 'c-claim-false', platform: 'instagram' });
    const fetchMock = installFetchSequence([
      mockFetchJson({ status: 'success', data: { campaigns: [c1] } }),
      mockFetchJson({ status: 'success', data: { claimed: false } }),
    ]);
    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    const { processPendingSchedules } = installOrchestratorMock();

    await import('../index');
    __emitAlarm({ name: 'campaign-queue-poll' });
    await flushAsync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await poll.get()).pendingSchedules).toHaveLength(0);
    expect(processPendingSchedules).toHaveBeenCalledTimes(1);
    expect(await auth.hasToken()).toBe(true);
  });

  // T7 — Happy-path empty queue triggers handlePollSuccess: markPollSuccess
  // timestamps lastPollTime, setPollBackoff(null) erases any prior backoff,
  // resetFailureCount zeroes the counter and lastPollError, badge resets to
  // blank, and the alarm is rescheduled at the default 20-minute period.
  it('T7: empty queue success → markPollSuccess, setPollBackoff(null), resetFailureCount, badge cleared, alarm period=20', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');

    const fetchMock = installFetchSequence([mockFetchJson({ status: 'success', data: { campaigns: [] } })]);
    installOrchestratorMock();

    await poll.recordFailure('prev error');
    expect((await poll.get()).consecutiveFailures).toBe(1);

    await import('../index');
    __emitAlarm({ name: 'campaign-queue-poll' });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await poll.getPollBackoff()).toBeNull();
    const state = await poll.get();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastPollError).toBeNull();
    expect(state.lastPollTime).not.toBeNull();
    expect(__badge.text).toBe('');

    const alarm = await getAlarm('campaign-queue-poll');
    expect(alarm?.delayInMinutes).toBe(20);
    expect(alarm?.periodInMinutes).toBeUndefined();
  });

  // T8 — Backoff cadence table [1, 2, 5] saturated at 5. Three successive
  // 500s escalate the delayInMinutes 1 → 2 → 5; the fourth failure stays at 5.
  it('T8: backoff cadence over 4 consecutive failures → steps 1 → 2 → 5 → 5 (capped), alarm re-armed each time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const fetchMock = installFetchSequence([
      mockFetchStatus(500),
      mockFetchStatus(500),
      mockFetchStatus(500),
      mockFetchStatus(500),
    ]);
    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    installOrchestratorMock();

    await import('../index');

    const expectBackoff = async (minutes: number) => {
      __emitAlarm({ name: 'campaign-queue-poll' });
      await flushMicrotasks();
      expect(await poll.getPollBackoff()).toBe(minutes);
      const alarm = await getAlarm('campaign-queue-poll');
      expect(alarm?.delayInMinutes).toBe(minutes);
      expect(alarm?.periodInMinutes).toBeUndefined();
    };

    await expectBackoff(1);
    await expectBackoff(2);
    await expectBackoff(5);
    await expectBackoff(5);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((await poll.get()).consecutiveFailures).toBe(4);
  });

  // T9 — 6 failures trigger the red `!` badge and the connection-error basic
  // notification with the locked iconUrl / title / message body. Backoff
  // cadence caps at 5.
  it('T9: 6 consecutive failures → red ! badge + litoral-connection-error notification + backoff=5', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const fetchMock = installFetchSequence(Array.from({ length: 6 }, () => mockFetchStatus(500)));
    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    installOrchestratorMock();

    await import('../index');
    for (let i = 0; i < 6; i++) {
      __emitAlarm({ name: 'campaign-queue-poll' });
      await flushMicrotasks();
    }

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(__badge.text).toBe('!');
    expect(__badge.color).toBe('#ba1a1a');
    expect(__notifications.has('litoral-connection-error')).toBe(true);
    const notif = __notifications.get('litoral-connection-error') as {
      type: string;
      iconUrl: string;
      title: string;
      message: string;
    };
    expect(notif.type).toBe('basic');
    expect(notif.iconUrl).toContain('icon-128.png');
    expect(notif.title).toBe('Litoral: Connection Issue');
    expect(notif.message).toContain('Unable to reach server');

    expect(await poll.getPollBackoff()).toBe(5);
    expect((await poll.get()).consecutiveFailures).toBe(6);
  });

  // T10 — The 7th failure is also a "max failures reached" cycle, but the
  // shim's notification map is keyed by a constant id, so the same entry is
  // overwritten — exactly one notification remains. The failure counter keeps
  // climbing (no idempotency on the count) and the backoff cap of 5 holds.
  it('T10: 7th failure → notification idempotent (one entry), backoff=5, counter=7', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const fetchMock = installFetchSequence(Array.from({ length: 7 }, () => mockFetchStatus(500)));
    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    installOrchestratorMock();

    await import('../index');
    for (let i = 0; i < 7; i++) {
      __emitAlarm({ name: 'campaign-queue-poll' });
      await flushMicrotasks();
    }

    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(__notifications.size).toBe(1);
    expect(__notifications.has('litoral-connection-error')).toBe(true);
    expect(await poll.getPollBackoff()).toBe(5);
    expect((await poll.get()).consecutiveFailures).toBe(7);
  });

  // T11 — Backoff recovery: after three failures (backoff=5), one successful
  // empty-queue poll zeroes the counter, clears backoff to null, clears the
  // badge, and re-arms the alarm at the default 20m period.
  it('T11: recovery — 3 failures then success → counter=0, backoff=null, badge cleared, alarm period=20', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const fetchMock = installFetchSequence([
      mockFetchStatus(500),
      mockFetchStatus(500),
      mockFetchStatus(500),
      mockFetchJson({ status: 'success', data: { campaigns: [] } }),
    ]);
    const { poll, auth } = await reimportStorage();
    await auth.setToken('test-token');
    installOrchestratorMock();

    await import('../index');

    for (let i = 0; i < 3; i++) {
      __emitAlarm({ name: 'campaign-queue-poll' });
      await flushMicrotasks();
    }
    expect(await poll.getPollBackoff()).toBe(5);

    __emitAlarm({ name: 'campaign-queue-poll' });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const state = await poll.get();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastPollError).toBeNull();
    expect(await poll.getPollBackoff()).toBeNull();
    expect(__badge.text).toBe('');

    const alarm = await getAlarm('campaign-queue-poll');
    expect(alarm?.delayInMinutes).toBe(20);
    expect(alarm?.periodInMinutes).toBeUndefined();
  });

  // T12 — The alarm listener guards on `alarm.name === POLL_ALARM_NAME`.
  // Anything else must short-circuit without touching fetch.
  it('T12: non-poll alarm ignored → fetch never called', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const fetchMock = mockFetchHang();
    vi.stubGlobal('fetch', fetchMock);
    const { auth } = await reimportStorage();
    await auth.setToken('test-token');
    installOrchestratorMock();

    await import('../index');
    __emitAlarm({ name: 'wrong-name' });
    await flushMicrotasks();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// describe: checkAuthAndPoll — no-token path
// ─────────────────────────────────────────────────────────────────────────

describe('checkAuthAndPoll — no-token path', () => {
  // T13 — With no auth token stored, the alarm handler delegates to
  // checkAuthAndPoll which short-circuits through setBadgeAuthRequired. The
  // 🔑 badge goes orange and fetch is NEVER touched (the queue endpoint is
  // gated behind the token check).
  it('T13: no token → setBadgeAuthRequired short-circuits, fetch never called, no poll telemetry touched', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const fetchMock = mockFetchHang();
    vi.stubGlobal('fetch', fetchMock);
    const { poll } = await reimportStorage();
    installOrchestratorMock();

    await import('../index');
    __emitAlarm({ name: 'campaign-queue-poll' });
    await flushMicrotasks();

    expect(__badge.text).toBe('🔑');
    expect(__badge.color).toBe('#9e3d00');
    expect(fetchMock).not.toHaveBeenCalled();
    const state = await poll.get();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastPollError).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// describe: popup message handler
// ─────────────────────────────────────────────────────────────────────────

describe('popup message handler', () => {
  // T14 — GET_STATE packages the PollStatusPayload with per-platform status
  // derivation. Priority: breaker_open > error > ok > idle. Pre-seed:
  //  - instagram failure ('error'),
  //  - tiktok success ('ok'),
  //  - facebook breaker-open window ('breaker_open'),
  //  - gbp untouched ('idle').
  it('T14: GET_STATE → POLL_STATUS with per-platform status (breaker_open > error > ok > idle)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const fetchMock = installFetchSequence([mockFetchJson({ status: 'success', data: { campaigns: [] } })]);
    const { poll } = await reimportStorage();
    installOrchestratorMock();

    // Idle baseline: request GET_STATE first with no telemetry at all.
    const listener = await captureOnMessageListener(async () => {
      await import('../index');
    });

    const baseReply = dispatchMessage(listener, { type: 'GET_STATE' });
    await flushMicrotasks();

    expect(baseReply.sendResponse).toHaveBeenCalledTimes(1);
    const basePayload = baseReply.sendResponse.mock.calls[0]![0] as {
      type: string;
      data: PollStatusPayload;
    };
    expect(basePayload.type).toBe('POLL_STATUS');
    expect(basePayload.data.pendingCount).toBe(0);
    expect(basePayload.data.isAuthenticated).toBe(false);
    expect(basePayload.data.pollBackoffMinutes).toBeNull();
    expect(basePayload.data.consecutiveFailures).toBe(0);
    expect(basePayload.data.platforms).toHaveLength(4);
    expect(basePayload.data.platforms.every(p => p.status === 'idle')).toBe(true);

    // Seeded variation: drive per-platform status derivation.
    const now = EPOCH.getTime();
    await poll.recordPlatformFailure('instagram', 'PLATFORM', 'timeout');
    await poll.recordPlatformSuccess('tiktok');
    const { setBreakerState } = await reimportBreaker();
    await setBreakerState({
      openUntil: { facebook: now + 60_000 } as Record<PlatformCode, number | null>,
      consecutiveFailures: { facebook: 4 } as Record<PlatformCode, number>,
      lastUpdatedAt: now,
    });

    const seededReply = dispatchMessage(listener, { type: 'GET_STATE' });
    await flushMicrotasks();

    const seeded = (
      seededReply.sendResponse.mock.calls[0]![0] as {
        type: string;
        data: PollStatusPayload;
      }
    ).data;
    const byCode = (code: PlatformCode) => seeded.platforms.find(p => p.code === code)!;
    expect(byCode('facebook').status).toBe('breaker_open');
    expect(byCode('instagram').status).toBe('error');
    expect(byCode('tiktok').status).toBe('ok');
    expect(byCode('gbp').status).toBe('idle');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // T15 — CONNECT stores the token synchronously (await setToken) before the
  // sendResponse fires, then kicks off a non-blocking checkAuthAndPoll that
  // reaches /queue. With an empty-queue fetch mock pre-installed, lastPollTime
  // gets stamped immediately and the response is {success:true}.
  it('T15: CONNECT stores token then triggers a background poll (no-token → success path)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const fetchMock = installFetchSequence([mockFetchJson({ status: 'success', data: { campaigns: [] } })]);
    const { poll, auth } = await reimportStorage();
    installOrchestratorMock();

    const listener = await captureOnMessageListener(async () => {
      await import('../index');
    });

    expect(await auth.hasToken()).toBe(false);

    const { sendResponse } = dispatchMessage(listener, { type: 'CONNECT', token: 'fresh-token' });
    await flushMicrotasks();

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect((sendResponse.mock.calls[0]![0] as { success: boolean }).success).toBe(true);

    expect(await auth.hasToken()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    assertFetchedUrl(fetchMock, '/api/extension/queue', 'GET');
    expect((await poll.get()).lastPollTime).not.toBeNull();
  });

  // T16 — RETRY_NOW clears any existing poll alarm, runs checkAuthAndPoll
  // immediately, then unconditionally recreates the alarm at the default
  // cadence (the safety-net createPollAlarm runs even if the no-token branch
  // skipped the success-side recreate). With a token + empty-queue fetch
  // mock, the poll succeeds, handlePollSuccess reschedules the alarm with
  // delayInMinutes=20 (one-shot), and the safety-net createPollAlarm is a
  // no-op because the alarm already exists.
  it('T16: RETRY_NOW clears the alarm, polls once, recreates the alarm at default cadence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const fetchMock = installFetchSequence([mockFetchJson({ status: 'success', data: { campaigns: [] } })]);
    const { auth } = await reimportStorage();
    await auth.setToken('test-token');
    installOrchestratorMock();

    const listener = await captureOnMessageListener(async () => {
      await import('../index');
    });

    // Pre-create the alarm so RETRY_NOW's chrome.alarms.clear has something to clear.
    await chrome.alarms.create('campaign-queue-poll', { periodInMinutes: 20 });
    const clearSpy = vi.spyOn(chrome.alarms, 'clear');

    expect(clearSpy).not.toHaveBeenCalled();

    const { sendResponse } = dispatchMessage(listener, { type: 'RETRY_NOW' });
    // The handler wraps work in an async IIFE; flush both microtasks and any
    // fake-timer macrotasks to settle chrome.alarms.clear, checkAuthAndPoll
    // (incl. fetch), reschedulePollAlarm, and the createPollAlarm safety net.
    await flushAsync(10);

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect((sendResponse.mock.calls[0]![0] as { success: boolean }).success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // handlePollSuccess recreates the alarm with delayInMinutes=20; the
    // createPollAlarm safety-net no-ops because the alarm already exists.
    const alarm = await getAlarm('campaign-queue-poll');
    expect(alarm?.delayInMinutes).toBe(20);

    expect(clearSpy).toHaveBeenCalledWith('campaign-queue-poll');
  });

  // T17 — CLEAR_ERRORS resets per-platform telemetry + the poll-level failure
  // counter / last error message, bulk-resets every circuit breaker via the
  // module-private `popupBreaker.resetAll()`, and recomputes the badge from
  // storage (pendingCount=0 → empty badge).
  it('T17: CLEAR_ERRORS → resets telemetry, failure counter, breaker.resetAll, badge from storage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const fetchMock = installFetchSequence([mockFetchJson({ status: 'success', data: { campaigns: [] } })]);
    const { poll } = await reimportStorage();
    const { setBreakerState, getBreakerState } = await reimportBreaker();
    installOrchestratorMock();

    const listener = await captureOnMessageListener(async () => {
      await import('../index');
    });

    // Pre-seed dirty state across all surfaces.
    await poll.recordFailure('prev error A');
    await poll.recordFailure('prev error B');
    await poll.recordPlatformFailure('instagram', 'PLATFORM', 'timeout');
    await poll.recordPlatformFailure('facebook', 'PLATFORM', 'oops');
    await setBreakerState({
      openUntil: { tiktok: EPOCH.getTime() + 60_000 } as Record<PlatformCode, number | null>,
      consecutiveFailures: { tiktok: 5 } as Record<PlatformCode, number>,
      lastUpdatedAt: EPOCH.getTime(),
    });

    expect((await poll.get()).consecutiveFailures).toBe(2);
    expect((await poll.getTelemetry()).instagram?.consecutiveFailures).toBe(1);

    const { sendResponse } = dispatchMessage(listener, { type: 'CLEAR_ERRORS' });
    await flushMicrotasks();

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect((sendResponse.mock.calls[0]![0] as { success: boolean }).success).toBe(true);

    const state = await poll.get();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastPollError).toBeNull();

    const telemetry = await poll.getTelemetry();
    for (const code of ['instagram', 'facebook', 'tiktok', 'gbp'] as PlatformCode[]) {
      expect(telemetry[code]?.consecutiveFailures ?? 0).toBe(0);
      expect(telemetry[code]?.lastErrorCode ?? null).toBeNull();
      expect(telemetry[code]?.lastErrorReason ?? null).toBeNull();
    }
    expect(await poll.getPollBackoff()).toBeNull();

    const breaker = await getBreakerState();
    expect(Object.keys(breaker.openUntil)).toHaveLength(0);
    expect(Object.keys(breaker.consecutiveFailures)).toHaveLength(0);

    expect(__badge.text).toBe('');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// describe: registerContentScripts
// ─────────────────────────────────────────────────────────────────────────

describe('registerContentScripts', () => {
  // T18 — The onInstalled handler registers 4 platform content scripts via
  // chrome.scripting.registerContentScripts. Capture the onInstalled
  // listener from the placeholder stub we install in beforeEach, then invoke
  // it manually (the shim never fires onInstalled itself).
  it('T18: registers 4 platform content scripts on install', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const fetchMock = installFetchSequence([mockFetchJson({ status: 'success', data: { campaigns: [] } })]);
    // Replace the placeholder addListener with a captor so we can invoke the
    // handler directly. installLifecycleStubs (in beforeEach) already set
    // onInstalled = { addListener: vi.fn(NO_OP) }.
    const onInstalledAdd = (
      chrome.runtime as unknown as {
        onInstalled: { addListener: ReturnType<typeof vi.fn> };
      }
    ).onInstalled.addListener;
    let onInstalledHandler: (() => Promise<void>) | null = null;
    onInstalledAdd.mockImplementation((fn: () => Promise<void>) => {
      onInstalledHandler = fn;
    });

    const { auth } = await reimportStorage();
    await auth.setToken('test-token');
    installOrchestratorMock();

    await import('../index');
    expect(onInstalledHandler).not.toBeNull();
    await onInstalledHandler!();

    expect(__registeredScripts).toHaveLength(4);
    const ids = (__registeredScripts as Array<{ id: string }>).map(s => s.id);
    expect(ids).toEqual([
      'litoral-instagram-scheduler',
      'litoral-facebook-scheduler',
      'litoral-tiktok-scheduler',
      'litoral-gbp-scheduler',
    ]);

    // onInstalled also auto-drives a poll → token set → fetch called once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // T19 — When registerContentScripts is called a second time after a prior
  // registration, Chrome throws an Error whose message contains 'Duplicate'.
  // index.ts swallows it and logs 'already registered' (console.log arm).
  it('T19: registerContentScripts swallows a "Duplicate script ID" error and logs already-registered', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);

    const { auth } = await reimportStorage();
    await auth.setToken('test-token');
    installOrchestratorMock();

    // Replace the placeholder addListener with a captor.
    const onInstalledAdd = (
      chrome.runtime as unknown as {
        onInstalled: { addListener: ReturnType<typeof vi.fn> };
      }
    ).onInstalled.addListener;
    let onInstalledHandler: (() => Promise<void>) | null = null;
    onInstalledAdd.mockImplementation((fn: () => Promise<void>) => {
      onInstalledHandler = fn;
    });

    // Make registerContentScripts reject with Chrome's Duplicate-script error.
    const registerSpy = vi
      .spyOn(chrome.scripting, 'registerContentScripts')
      .mockRejectedValueOnce(new Error('Duplicate script ID.'));

    // Re-grab the log spy that beforeEach installed — we want to assert the
    // 'already registered' message landed. Use a fresh capture to be precise.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(NO_OP);

    await import('../index');
    expect(onInstalledHandler).not.toBeNull();
    await onInstalledHandler!();

    expect(registerSpy).toHaveBeenCalledTimes(1);
    const alreadyLogged = logSpy.mock.calls.some(call => String(call[0] ?? '').includes('already registered'));
    expect(alreadyLogged).toBe(true);
    expect(__registeredScripts).toHaveLength(0);
  });
});
