import { __resetChromeShim } from './setup';
import {
  BREAKER_OPEN_DURATION_MS,
  BREAKER_THRESHOLD,
  CircuitBreaker,
  getBreakerState,
  setBreakerState,
} from '../circuit-breaker';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    __resetChromeShim();
  });

  it('isOpen returns false on a fresh breaker', async () => {
    const breaker = new CircuitBreaker();
    expect(await breaker.isOpen('instagram')).toBe(false);
    expect(await breaker.isOpen('facebook')).toBe(false);
  });

  it(`isOpen stays false until BREAKER_THRESHOLD (${BREAKER_THRESHOLD}) consecutive failures`, async () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i++) {
      await breaker.recordFailure('instagram');
    }
    expect(await breaker.isOpen('instagram')).toBe(false);

    const state = await getBreakerState();
    expect(state.consecutiveFailures.instagram).toBe(BREAKER_THRESHOLD - 1);
    expect(state.openUntil.instagram).toBeUndefined();
  });

  it('opens the breaker once the threshold is reached', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const breaker = new CircuitBreaker();

    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
      await breaker.recordFailure('instagram');
    }

    expect(await breaker.isOpen('instagram')).toBe(true);

    const state = await getBreakerState();
    expect(state.consecutiveFailures.instagram).toBe(BREAKER_THRESHOLD);
    expect(state.openUntil.instagram).toBe(100_000 + BREAKER_OPEN_DURATION_MS);
    nowSpy.mockRestore();
  });

  it('recordSuccess closes the breaker and resets the failure count', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const breaker = new CircuitBreaker();

    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
      await breaker.recordFailure('instagram');
    }
    expect(await breaker.isOpen('instagram')).toBe(true);

    await breaker.recordSuccess('instagram');

    expect(await breaker.isOpen('instagram')).toBe(false);
    const state = await getBreakerState();
    expect(state.consecutiveFailures.instagram).toBeUndefined();
    expect(state.openUntil.instagram).toBeUndefined();
    nowSpy.mockRestore();
  });

  it('auto-closes a stale open window on the next isOpen read', async () => {
    // An open window that expired 1s ago.
    await setBreakerState({
      openUntil: { instagram: 100_000 - 1_000 },
      consecutiveFailures: { instagram: BREAKER_THRESHOLD },
      lastUpdatedAt: null,
    });

    // Date.now() has advanced past openUntil — auto-recovery should fire.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const breaker = new CircuitBreaker();

    expect(await breaker.isOpen('instagram')).toBe(false);

    // Stale entry must be removed from storage (no lingering block).
    const state = await getBreakerState();
    expect(state.openUntil.instagram).toBeUndefined();
    expect(state.openUntil).toEqual({});
    // The failure counter is NOT wiped by auto-recovery — only recordSuccess/reset do that.
    expect(state.consecutiveFailures.instagram).toBe(BREAKER_THRESHOLD);
    nowSpy.mockRestore();
  });

  it('reset platform wipes just that platform; resetAll wipes everything', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const breaker = new CircuitBreaker();

    await breaker.recordFailure('instagram');
    await breaker.recordFailure('facebook');
    expect((await getBreakerState()).consecutiveFailures).toEqual({ instagram: 1, facebook: 1 });

    await breaker.reset('instagram');
    const afterOne = await getBreakerState();
    expect(afterOne.consecutiveFailures.instagram).toBeUndefined();
    expect(afterOne.consecutiveFailures.facebook).toBe(1);

    await breaker.resetAll();
    const afterAll = await getBreakerState();
    expect(afterAll.openUntil).toEqual({});
    expect(afterAll.consecutiveFailures).toEqual({});
    nowSpy.mockRestore();
  });

  it('exposes BREAKER_THRESHOLD and BREAKER_OPEN_DURATION_MS constants', () => {
    expect(BREAKER_THRESHOLD).toBe(3);
    expect(BREAKER_OPEN_DURATION_MS).toBe(15 * 60 * 1000);
  });

  // ─── reset() no-op branch (circuit-breaker.ts:207) ───────────────────
  it('reset() is a no-op when the platform has no recorded failures or open window', async () => {
    // Seed state for an UNRELATED platform so the storage key exists and has
    // data — but the platform we reset must have nothing recorded. Otherwise
    // the `setBreakerState` would always write lastUpdatedAt back.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const breaker = new CircuitBreaker();
    await breaker.recordFailure('facebook');
    const before = await getBreakerState();
    expect(before.lastUpdatedAt).toBeDefined();

    // reset(tiktok) when tiktok has no entries — must NOT mutate lastUpdatedAt.
    await breaker.reset('tiktok');
    const after = await getBreakerState();
    expect(after.openUntil.tiktok).toBeUndefined();
    expect(after.consecutiveFailures.tiktok).toBeUndefined();
    // No write should have been issued — lastUpdatedAt unchanged.
    expect(after.lastUpdatedAt).toBe(before.lastUpdatedAt);

    nowSpy.mockRestore();
  });

  // ─── recordSuccess() no-op branch (circuit-breaker.ts:167) ───────────
  it('recordSuccess is a no-op when the platform has nothing recorded (no lastUpdatedAt write)', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const breaker = new CircuitBreaker();

    // Fresh breaker — no entries for instagram.
    await breaker.recordSuccess('instagram');

    const state = await getBreakerState();
    expect(state.openUntil).toEqual({});
    expect(state.consecutiveFailures).toEqual({});
    // No write happened → lastUpdatedAt stays null on the never-written state.
    expect(state.lastUpdatedAt).toBeNull();

    nowSpy.mockRestore();
  });
});
