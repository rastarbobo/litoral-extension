import type { PlatformCode } from '@extension/shared';

/**
 * Per-platform CircuitBreaker for the Litoral scheduling pipeline.
 *
 * Tracks consecutive scheduling failures per platform and short-circuits future
 * attempts (across service-worker restarts) by opening the breaker.
 *
 * Rules:
 * - OPENed after BREAKER_THRESHOLD consecutive failures per platform.
 * - Stays OPEN for BREAKER_OPEN_DURATION_MS (15 minutes).
 * - The breaker AUTO-RECOVERS on read: when `Date.now() >= openUntil[platform]`,
 *   `isOpen` returns false and the stale entry is cleared so storage does not
 *   accumulate stale blocks. Auto-close happens lazily on the next `isOpen` call.
 * - `recordSuccess` closes the breaker (if currently open) and resets the
 *   consecutive-failure counter for the platform.
 * - `reset`/`resetAll` are bulk-erase operations used by CLEAR_ERRORS in the
 *   popup and admin tooling; they clear both `openUntil` and `consecutiveFailures`.
 *
 * Persistence: state lives under BREAKER_STORAGE_KEY in `chrome.storage.local`
 * so it survives service-worker restarts. There are no in-memory caches that
 * drift from disk; every public method reads fresh state from storage.
 *
 * Reads tolerate partial payloads so older schemas roll forward without
 * throwing. Writes preserve the `lastUpdatedAt` field for diagnostics.
 */

const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_DURATION_MS = 15 * 60 * 1000;
const BREAKER_STORAGE_KEY = 'litoral-circuit-breaker';

interface BreakerState {
  /** Per-platform open-until unix ms. null = not open. */
  openUntil: Record<string, number | null>;
  /** All-platform consecutive-failure counters (independent of open state). */
  consecutiveFailures: Record<string, number>;
  /** Unix ms of last state update, mainly for diagnostics. */
  lastUpdatedAt: number | null;
}

const READ_CHROME_STORAGE = (key: string): Promise<Record<string, unknown>> =>
  new Promise(resolve => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      resolve({});
      return;
    }
    chrome.storage.local.get([key], items => {
      if (typeof chrome.runtime?.lastError !== 'undefined' && chrome.runtime.lastError) {
        // Malformed payload — fall through and treat as empty state.
      }
      const value = items?.[key];
      resolve(typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
    });
  });

const WRITE_CHROME_STORAGE = (key: string, value: unknown): Promise<void> =>
  new Promise(resolve => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      resolve();
      return;
    }
    chrome.storage.local.set({ [key]: value }, () => resolve());
  });

const EMPTY_STATE: BreakerState = {
  openUntil: {},
  consecutiveFailures: {},
  lastUpdatedAt: null,
};

const getBreakerState = async (): Promise<BreakerState> => {
  const stored = await READ_CHROME_STORAGE(BREAKER_STORAGE_KEY);
  // Defensive: tolerate partial payloads from older versions.
  return {
    openUntil:
      typeof stored.openUntil === 'object' && stored.openUntil !== null
        ? (stored.openUntil as Record<string, number | null>)
        : {},
    consecutiveFailures:
      typeof stored.consecutiveFailures === 'object' && stored.consecutiveFailures !== null
        ? (stored.consecutiveFailures as Record<string, number>)
        : {},
    lastUpdatedAt: typeof stored.lastUpdatedAt === 'number' ? stored.lastUpdatedAt : null,
  };
};

const setBreakerState = async (state: BreakerState): Promise<void> => {
  await WRITE_CHROME_STORAGE(BREAKER_STORAGE_KEY, {
    ...state,
    lastUpdatedAt: Date.now(),
  });
};

const removePlatformFromState = (state: BreakerState, platform: string): BreakerState => {
  const nextOpenUntil = { ...state.openUntil };
  delete nextOpenUntil[platform];
  const nextFailures = { ...state.consecutiveFailures };
  delete nextFailures[platform];
  return {
    ...state,
    openUntil: nextOpenUntil,
    consecutiveFailures: nextFailures,
  };
};

/**
 * Used by `isOpen` to auto-close a stale open window: drops only the
 * `openUntil[platform]` entry so the open block stops being observed. The
 * consecutive-failure counter is intentionally PRESERVED — only explicit
 * recovery (`recordSuccess` / `reset`) clears it. Wiping it on auto-close
 * would silently reset failures-to-reopen to 0 after every 15-min window,
 * making a recurring platform failure never accumulate past one cycle.
 */
const clearOpenUntilForPlatform = (state: BreakerState, platform: string): BreakerState => {
  const nextOpenUntil = { ...state.openUntil };
  delete nextOpenUntil[platform];
  return {
    ...state,
    openUntil: nextOpenUntil,
  };
};

/**
 * Per-platform circuit breaker.
 *
 * Each platform maintains independent failure counts and open windows. The
 * breaker instance reads and writes through `chrome.storage.local` so state is
 * shared across all service-worker instances and survives restarts.
 */
class CircuitBreaker {
  /**
   * Returns true if the breaker is currently OPEN for the given platform.
   *
   * Open means scheduling should be skipped; the orchestrator should mark the
   * campaign as failed-on-server with reason `circuit_breaker_open` so the lock
   * scanner requeues it.
   *
   * Auto-recovery: if the open window has expired (Date.now() >= openUntil),
   * this returns false AND clears the stale entry so subsequent reads cannot
   * observe expired blocks. The next read is therefore authoritative and the
   * stale entry never lingers in storage.
   */
  async isOpen(platform: PlatformCode): Promise<boolean> {
    const state = await getBreakerState();
    const openUntil = state.openUntil[platform];
    if (openUntil === undefined || openUntil === null) {
      return false;
    }
    if (Date.now() < openUntil) {
      return true;
    }
    // Auto-close stale entry. We already hold the latest state we observed;
    // strip just this platform's stale `openUntil` key — preserving the
    // consecutive-failure counter (see clearOpenUntilForPlatform for why).
    await setBreakerState(clearOpenUntilForPlatform(state, platform));
    return false;
  }

  /**
   * Record a successful scheduling run. Closes the breaker if open. Resets the
   * consecutive-failure counter for the platform.
   */
  async recordSuccess(platform: PlatformCode): Promise<void> {
    const state = await getBreakerState();
    // Skip writes when the platform has nothing recorded — avoids bumping
    // `lastUpdatedAt` needlessly on hot success paths.
    if (state.openUntil[platform] === undefined && state.consecutiveFailures[platform] === undefined) {
      return;
    }
    await setBreakerState(removePlatformFromState(state, platform));
  }

  /**
   * Record a failure. Bumps consecutiveFailures and opens the breaker once the
   * threshold is reached. Opens the breaker even when the failure counter was
   * previously zero (first failure of a fresh window does not extend the
   * existing open interval — a new window starts when crossing the threshold).
   */
  async recordFailure(platform: PlatformCode): Promise<void> {
    const state = await getBreakerState();
    const previous = state.consecutiveFailures[platform] ?? 0;
    const nextCount = previous + 1;

    const nextFailures = {
      ...state.consecutiveFailures,
      [platform]: nextCount,
    };

    if (nextCount >= BREAKER_THRESHOLD) {
      const nextOpenUntil = {
        ...state.openUntil,
        [platform]: Date.now() + BREAKER_OPEN_DURATION_MS,
      };
      await setBreakerState({ ...state, consecutiveFailures: nextFailures, openUntil: nextOpenUntil });
      return;
    }

    await setBreakerState({ ...state, consecutiveFailures: nextFailures });
  }

  /**
   * Used by CLEAR_ERRORS popup action to close the breaker and reset the
   * counter for a single platform. No-op if nothing is recorded.
   */
  async reset(platform: PlatformCode): Promise<void> {
    const state = await getBreakerState();
    if (state.openUntil[platform] === undefined && state.consecutiveFailures[platform] === undefined) {
      return;
    }
    await setBreakerState(removePlatformFromState(state, platform));
  }

  /** Bulk-reset for admin tooling or factory-clear flows. */
  async resetAll(): Promise<void> {
    await setBreakerState({
      ...EMPTY_STATE,
      lastUpdatedAt: Date.now(),
    });
  }
}

export type { BreakerState };
export {
  BREAKER_THRESHOLD,
  BREAKER_OPEN_DURATION_MS,
  BREAKER_STORAGE_KEY,
  getBreakerState,
  setBreakerState,
  CircuitBreaker,
};
export default CircuitBreaker;
