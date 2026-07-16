/**
 * Fake-timer flush helper for content-script scheduling tests.
 *
 * The platform content scripts interleave `delay(ms)` waits (500ms–1000ms
 * between DOM steps) with `waitForElement` / `waitForOutcome` poll loops
 * (500ms interval, up to 30s). Real timers make the suite seconds-slow and
 * introduce flake. With `vi.useFakeTimers()`, `setTimeout` and `Date.now()`
 * are virtual — advancing them flushes every pending delay and poll in
 * constant time, driving the scheduler to completion deterministically.
 *
 * Usage:
 *   const flush = useFakeTimers();
 *   buildFacebookFixture({ outcome: 'success' });
 *   __dispatchStartScheduling(campaign);
 *   await flush(35_000); // past all delays + the 30s confirmation poll
 */
import { vi } from 'vitest';

/**
 * Activate fake timers and return an async flush function that advances the
 * virtual clock by `ms` milliseconds, awaiting any microtasks / promise
 * callbacks that fire along the way.
 *
 * `vi.advanceTimersByTimeAsync` (vs. the sync variant) is required because the
 * scheduler is `async` and its continuations must run between timer ticks.
 */
export const useFakeTimers = (): ((ms: number) => Promise<void>) => {
  vi.useFakeTimers();
  return async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };
};
