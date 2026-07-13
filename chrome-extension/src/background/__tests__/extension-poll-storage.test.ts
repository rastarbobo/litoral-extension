import { __resetChromeShim } from './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Per-test isolation: `createStorage` (packages/storage/lib/base/base.ts) keeps
// an internal `cache` variable at module scope. Once the module is imported, a
// naked `__resetChromeShim()` (which only clears the shim's storageMap) would
// leave the cache holding stale values; the next `set` would write the stale
// snapshot back into the freshly-cleared storageMap.
//
// Strategy: reset BOTH the shim AND the vitest module cache in `beforeEach`,
// then re-import `extensionPollStorage` fresh inside each test via
// `await import('@extension/storage')`. The freshly-loaded module's async init
// (`get().then(cache => …)`) reads from the now-empty shim and seeds the cache
// with the declared `initialState`. Each test thus begins from a blank slate.
const reimportStorage = async () => {
  const mod = await import('@extension/storage');
  return mod.extensionPollStorage;
};

const clearShimStorage = () => {
  // Drop the storage key from chrome storage. Same as `chrome.storage.local.clear()`
  // but scoped so it doesn't disturb other shim state that might be inspected.
  (
    globalThis as { chrome?: { storage: { local: { clear: (cb?: () => void) => Promise<void> } } } }
  ).chrome!.storage.local.clear();
};

describe('extensionPollStorage', () => {
  beforeEach(() => {
    __resetChromeShim();
    vi.resetModules();
    clearShimStorage();
  });

  it('returns the initial state on a fresh read', async () => {
    const storage = await reimportStorage();
    const state = await storage.get();
    expect(state).toMatchObject({
      pendingSchedules: [],
      consecutiveFailures: 0,
      lastPollTime: null,
      lastPollError: null,
      pollFailures: [],
      pollBackoffMinutes: null,
    });
    expect(state.telemetry).toMatchObject({
      instagram: {
        lastSuccessAt: null,
        lastFailureAt: null,
        lastErrorCode: null,
        lastErrorReason: null,
        consecutiveFailures: 0,
      },
    });
  });

  it('recordPlatformSuccess sets lastSuccessAt and clears error fields', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const storage = await reimportStorage();

    // Seed an error so we can verify it gets cleared.
    await storage.recordPlatformFailure('instagram', 'TEXT_SET_FAILED', 'caption textarea');

    await storage.recordPlatformSuccess('instagram');

    const telemetry = await storage.getTelemetry();
    expect(telemetry.instagram?.lastSuccessAt).toBe(1_700_000_000_000);
    expect(telemetry.instagram?.lastErrorCode).toBeNull();
    expect(telemetry.instagram?.lastErrorReason).toBeNull();
    expect(telemetry.instagram?.consecutiveFailures).toBe(0);
    vi.mocked(Date.now).mockRestore();
  });

  it('recordPlatformFailure bumps consecutiveFailures and stores structured code/reason', async () => {
    const DateNow = vi.spyOn(Date, 'now');
    DateNow.mockReturnValue(1_700_000_000_000);
    const storage = await reimportStorage();

    await storage.recordPlatformFailure('instagram', 'TEXT_SET_FAILED', 'caption textarea');
    let telemetry = await storage.getTelemetry();
    expect(telemetry.instagram?.consecutiveFailures).toBe(1);
    expect(telemetry.instagram?.lastErrorCode).toBe('TEXT_SET_FAILED');
    expect(telemetry.instagram?.lastErrorReason).toBe('caption textarea');
    expect(telemetry.instagram?.lastFailureAt).toBe(1_700_000_000_000);

    // Second failure.
    DateNow.mockReturnValue(1_700_000_000_001);
    await storage.recordPlatformFailure('instagram', 'UPLOAD_FAILED', 'file input');
    telemetry = await storage.getTelemetry();
    expect(telemetry.instagram?.consecutiveFailures).toBe(2);
    expect(telemetry.instagram?.lastErrorCode).toBe('UPLOAD_FAILED');
    expect(telemetry.instagram?.lastErrorReason).toBe('file input');
    DateNow.mockRestore();
  });

  it('getTelemetry returns the full telemetry map', async () => {
    const storage = await reimportStorage();
    await storage.recordPlatformSuccess('facebook');
    const telemetry = await storage.getTelemetry();
    expect(telemetry.facebook).toBeDefined();
    expect(telemetry.facebook?.lastSuccessAt).toBeGreaterThan(0);
    // Other platforms should still be at their zeroed defaults.
    expect(telemetry.instagram?.lastSuccessAt).toBeNull();
  });

  it('setPollBackoff then getPollBackoff round-trips; null clears', async () => {
    const storage = await reimportStorage();

    expect(await storage.getPollBackoff()).toBeNull();

    await storage.setPollBackoff(5);
    expect(await storage.getPollBackoff()).toBe(5);

    await storage.setPollBackoff(null);
    expect(await storage.getPollBackoff()).toBeNull();
  });

  it('clearAllTelemetry zeroes telemetry AND clears pollBackoff; preserves pollFailures', async () => {
    const DateNow = vi.spyOn(Date, 'now');
    DateNow.mockReturnValue(1_700_000_000_000);
    const storage = await reimportStorage();

    // Seed telemetry + backoff + poll-failure log + pending campaign.
    await storage.recordPlatformFailure('instagram', 'TEXT_SET_FAILED', 'caption textarea');
    await storage.setPollBackoff(5);
    await storage.recordFailure('oh no');

    let state = await storage.get();
    expect(state.telemetry.instagram?.consecutiveFailures).toBe(1);
    expect(state.pollBackoffMinutes).toBe(5);
    expect(state.pollFailures).toHaveLength(1);
    expect(state.pollFailures[0]?.message).toBe('oh no');
    expect(state.consecutiveFailures).toBe(1);

    await storage.clearAllTelemetry();

    state = await storage.get();
    expect(state.telemetry.instagram).toMatchObject({
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorCode: null,
      lastErrorReason: null,
      consecutiveFailures: 0,
    });
    expect(state.pollBackoffMinutes).toBeNull();
    // pollFailures + poll counter must be preserved (clearAllTelemetry only
    // resets per-platform telemetry and the backoff pointer).
    expect(state.pollFailures).toHaveLength(1);
    expect(state.pollFailures[0]?.message).toBe('oh no');
    expect(state.consecutiveFailures).toBe(1);
    DateNow.mockRestore();
  });

  it('round-trips a full state payload through the shim storage map', async () => {
    const DateNow = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const storage = await reimportStorage();

    const campaign = {
      campaignId: 'c-rt-1',
      restaurantId: 'r-rt',
      platform: 'facebook' as const,
      assetUrl: 'https://r2.example/asset.png',
      caption: 'caption rt',
      scheduledTime: '2026-12-15T10:30:00.000Z',
      mediaType: 'image' as const,
    };
    await storage.storeClaimedCampaign(campaign);
    await storage.recordFailure('poll exploded');
    await storage.markPollSuccess();
    await storage.recordPlatformSuccess('tiktok');
    await storage.recordPlatformFailure('gbp', 'TEXT_SET_FAILED', 'textarea');
    await storage.setPollBackoff(2);

    const read = await storage.get();
    expect(read.pendingSchedules).toEqual([campaign]);
    expect(read.consecutiveFailures).toBe(1);
    expect(read.lastPollError).toBe('poll exploded');
    expect(read.lastPollTime).toBe(1_700_000_000_000);
    expect(read.pollFailures).toHaveLength(1);
    expect(read.telemetry.tiktok?.lastSuccessAt).toBe(1_700_000_000_000);
    expect(read.telemetry.gbp?.lastErrorCode).toBe('TEXT_SET_FAILED');
    expect(read.telemetry.gbp?.lastErrorReason).toBe('textarea');
    expect(read.pollBackoffMinutes).toBe(2);

    // Direct peek into the shim map: confirm the storage key holds the same payload.
    const peek = (
      globalThis as {
        chrome?: {
          storage: {
            local: { get: (keys: string | string[]) => Promise<Record<string, unknown>> };
          };
        };
      }
    ).chrome!.storage.local.get(['litoral-poll-storage-key']);
    const raw = (await peek)['litoral-poll-storage-key'] as Record<string, unknown> | undefined;
    expect(raw).toBeDefined();
    expect(raw).toMatchObject({
      consecutiveFailures: 1,
      pollBackoffMinutes: 2,
      lastPollError: 'poll exploded',
    });
    DateNow.mockRestore();
  });

  it('removeCampaign drops just one entry from pendingSchedules', async () => {
    const storage = await reimportStorage();
    const a = {
      campaignId: 'c-rm-1',
      restaurantId: 'r-rm',
      platform: 'instagram' as const,
      assetUrl: 'https://e',
      caption: 'a',
      scheduledTime: '2026-12-15T10:30:00.000Z',
      mediaType: 'image' as const,
    };
    const b = { ...a, campaignId: 'c-rm-2' };
    await storage.storeClaimedCampaign(a);
    await storage.storeClaimedCampaign(b);

    await storage.removeCampaign('c-rm-1');

    const state = await storage.get();
    expect(state.pendingSchedules).toEqual([b]);
  });
});
