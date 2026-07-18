/**
 * Scheduling Orchestrator
 *
 * Iterates through pendingSchedules in storage, processes each claimed campaign:
 * 1. Opens the target platform's scheduling page in a new Chrome tab (inactive)
 * 2. Sends the campaign payload to the platform-specific content script via message
 * 3. Listens for completion/failure messages from the content script
 * 4. On success → POST /api/extension/queue/scheduled (Story 6.2 endpoint)
 * 5. On failure → log + leave campaign in pending_schedule (stale lock scanner handles timeout)
 * 6. Removes the campaign from pendingSchedules in extension storage
 *
 * Execution constraints (ADR-003):
 * - Max 2 campaigns per scheduling cycle
 * - 90-second inter-campaign delay (prevents rate limiting)
 * - Sequential (not parallel) — one platform tab at a time
 * - 90-second timeout per campaign (content script must respond within this window)
 *
 * Architecture (ADR-001):
 * - Extension NEVER touches D1 or n8n directly
 * - All communication through Worker API endpoints
 * - Content scripts only message the background worker — no direct API calls
 */

import { CircuitBreaker } from './circuit-breaker';
import { API_BASE_URL } from '../config';
import { extensionPollStorage, extensionAuthStorage } from '@extension/storage';
import type {
  CampaignPayload,
  ContentScriptMessage,
  BackgroundToContentMessage,
  ScheduleResult,
  PlatformCode,
} from '@extension/shared';

// ─── Constants ───────────────────────────────────────────

const SCHEDULING_TIMEOUT_MS = 90_000; // 90 seconds per campaign
const MAX_CAMPAIGNS_PER_CYCLE = 2;
const INTER_CAMPAIGN_DELAY_MS = 90_000; // 90-second delay between platform switches
const TAB_LOAD_TIMEOUT_MS = 30_000; // 30 seconds for page to load

/** Scheduling page URLs for each supported platform */
const PLATFORM_SCHEDULE_URLS: Record<PlatformCode, string> = {
  instagram: 'https://www.instagram.com/creator/manage_schedule/',
  facebook: 'https://business.facebook.com/latest/publishing_tools/composer/',
  tiktok: 'https://www.tiktok.com/creator-center/upload',
  gbp: 'https://business.google.com/posts/create',
};

/**
 * Parse a `reason` string into a structured `{ code, message }` pair.
 *
 * Content script catch blocks format errors as `<CODE>: <selector-or-message>`
 * (e.g. `TEXT_SET_FAILED: input.form`) when derived from `DomUtilError`. Free-
 * form reasons (e.g. `timeout`, `tab_creation_failed`) have no structured code.
 *
 * Anything that doesn't look like a SCREAMING_SNAKE prefix is treated as a
 * plain platform message and falls back to the `PLATFORM` code so telemetry
 * never loses the original string.
 */
const parseReason = (reason: string | undefined): { code: string; message: string } => {
  if (!reason) return { code: 'UNKNOWN', message: 'Unknown failure' };
  const idx = reason.indexOf(':');
  if (idx <= 0) return { code: 'PLATFORM', message: reason };
  const head = reason.slice(0, idx).trim();
  const tail = reason.slice(idx + 1).trim();
  if (!/^[A-Z][A-Z0-9_]+$/.test(head)) return { code: 'PLATFORM', message: reason };
  return { code: head, message: tail || reason };
};

// ─── Module State ────────────────────────────────────────

/** Prevents overlapping scheduling cycles */
let isSchedulingInProgress = false;

/** Track active scheduling tabs for cleanup */
const activeSchedulingTabs = new Map<string, number>();

/**
 * Shared circuit-breaker instance for per-platform scheduling protection.
 * State persists in `chrome.storage.local` under the breaker's own key so it
 * survives service-worker restarts and is shared across all callers.
 */
const breaker = new CircuitBreaker();

// ─── Public API ──────────────────────────────────────────

/**
 * Process all pending campaigns in the scheduling queue.
 *
 * Called after the poll/claim cycle in the background service worker.
 * Safe to call multiple times — guards against overlapping cycles.
 */
const processPendingSchedules = async (): Promise<void> => {
  if (isSchedulingInProgress) {
    console.log('[Litoral] Scheduling already in progress — skipping');
    return;
  }

  const state = await extensionPollStorage.get();
  const pending = [...state.pendingSchedules];

  if (pending.length === 0) {
    return;
  }

  isSchedulingInProgress = true;
  console.log(`[Litoral] Starting scheduling cycle — ${pending.length} campaign(s) pending`);

  // Process at most MAX_CAMPAIGNS_PER_CYCLE (architecture constraint)
  const batch = pending.slice(0, MAX_CAMPAIGNS_PER_CYCLE);

  for (let i = 0; i < batch.length; i++) {
    const campaign = batch[i];
    let result: ScheduleResult | undefined;

    try {
      result = await scheduleOneCampaign(campaign);

      if (result.success && result.scheduledAt) {
        console.log(`[Litoral] Successfully scheduled campaign ${campaign.campaignId} on ${campaign.platform}`);
      } else {
        console.warn(
          `[Litoral] Scheduling failed for campaign ${campaign.campaignId}: ${
            /* c8 ignore start -- defensive fallback: every failure path in
               scheduleOneCampaign sets `reason` to a non-empty string, so
               this nullish coalescing arm is only reached if a future code
               change drops the assignment. */
            result.reason ?? 'unknown'
            /* c8 ignore stop */
          }`,
        );
      }
    } catch (error) {
      console.error(
        `[Litoral] Orchestrator error for campaign ${campaign.campaignId}:`,
        /* c8 ignore start -- `error instanceof Error ? ... : error` else
           branch is only reached when scheduleOneCampaign throws a non-Error,
           which no production code path does today. The defensive arm exists
           for future code changes that might throw unstructured primitives. */
        error instanceof Error ? error.message : error,
        /* c8 ignore stop */
      );
    }

    // Remove from pending immediately after the result is determined — we never retry the
    // same campaign in this cycle. On failure, the stale lock scanner will auto-revert the
    // campaign to 'approved' for the next cycle.
    // (Q9 fix candidate (a): moved BEFORE markScheduledOnServer so a hung marker fetch can
    // no longer block local-state convergence. The 90s SCHEDULING_TIMEOUT_MS clears on
    // SCHEDULE_COMPLETE; without this reordering, a never-resolving marker fetch would
    // hold the await indefinitely — the 90s timer cannot rescue it because done() already
    // cleared it. See ROADMAP.md → Open Questions & Decisions → Q9.)
    await extensionPollStorage.removeCampaign(campaign.campaignId);

    // Per-platform telemetry: write AFTER removeCampaign so a rejected set never
    // orphans a still-pending schedule entry. Success → recordPlatformSuccess.
    // Failure → recordPlatformFailure with a structured error code parsed from
    // the reason string (or the synthetic 'BREAKER' code when the breaker
    // short-circuits the call).
    if (result?.success && result.scheduledAt) {
      await extensionPollStorage.recordPlatformSuccess(campaign.platform);
    } else if (result && !result.success) {
      if (result.reason === 'circuit_breaker_open') {
        await extensionPollStorage.recordPlatformFailure(campaign.platform, 'BREAKER', result.reason);
      } else {
        const { code, message } = parseReason(result.reason);
        await extensionPollStorage.recordPlatformFailure(campaign.platform, code, message);
      }
    }

    // Mark scheduled on server AFTER local-state convergence (Q9 fix candidate (a)).
    // If this call fails (non-OK status, network error, or hangs), the stale lock scanner
    // auto-reverts the campaign to 'approved' on the next cycle. `markScheduledOnServer`
    // does NOT swallow fetch rejections internally (post-Q9 fix (a)) — a thrown/rejected
    // fetch propagates to the `.catch` handler below, which logs a single warning and
    // continues the cycle. The non-OK status arm + the body.status-!=='success' arm still
    // log + return early from inside `markScheduledOnServer` without throwing, so they do
    // NOT reach this `.catch` — only true fetch rejections (TypeError, network outage,
    // primitive) do.
    //
    // The marker call is DETACHED via `void` (Q9 fix (a) final shape) so a hung marker
    // `fetch` cannot hold the cycle's promise resolution. Local-state convergence
    // (`removeCampaign` + `recordPlatformSuccess` above) already ran synchronously before
    // this fire-and-forget kick-off, so the Q9 fix (a) contract — "a hung marker fetch no
    // longer blocks local-state convergence" — holds whether or not the marker ever
    // settles. The DETACH is what makes the orchestrator's `processPendingSchedules`
    // promise RESOLVE despite a still-pending marker (the E2 test's central assertion).
    // Without it, `await markScheduledOnServer(...)` would block the for-loop body for the
    // duration of the fetch hang even after the reorder — that's the trade-off the spec
    // flagged between candidates (a) (pure reorder) and (b) (detach); the E2 contract
    // requires both.
    if (result?.success && result.scheduledAt) {
      void markScheduledOnServer(campaign.campaignId, result.scheduledAt).catch(error => {
        console.warn(
          `[Litoral] markScheduledOnServer threw for campaign ${campaign.campaignId} — stale lock scanner will auto-revert; local state already converged.`,
          // Q9 fix (a): `markScheduledOnServer` does NOT swallow fetch rejections
          // internally; the rejection propagates here. The `error instanceof Error ?
          // error.message : error` ternary mirrors the defensive pattern in the outer
          // catch above. The truthy (Error) arm is covered by tests E3 + the new
          // marker-throw test (TypeError / Error rejections); the falsy (primitive)
          // arm is covered by the `'connection reset'` test (non-Error fetch reject).
          error instanceof Error ? error.message : error,
        );
      });
    }

    // 90-second delay between platforms (prevents rate limiting)
    if (i < batch.length - 1) {
      console.log(`[Litoral] Waiting ${INTER_CAMPAIGN_DELAY_MS / 1000}s before next platform...`);
      await delay(INTER_CAMPAIGN_DELAY_MS);
    }
  }

  isSchedulingInProgress = false;
  console.log('[Litoral] Scheduling cycle complete');

  // Update badge to reflect remaining count
  await updateBadge();
};

/**
 * Check if scheduling is currently in progress.
 */
const getSchedulingInProgress = (): boolean => isSchedulingInProgress;

// ─── Single Campaign Scheduling ──────────────────────────

const scheduleOneCampaign = async (campaign: CampaignPayload): Promise<ScheduleResult> => {
  if (await breaker.isOpen(campaign.platform)) {
    return {
      campaignId: campaign.campaignId,
      platform: campaign.platform,
      success: false,
      reason: 'circuit_breaker_open',
    };
  }

  const platformUrl = getPlatformScheduleUrl(campaign.platform);

  const inner = new Promise<ScheduleResult>(resolve => {
    let resolved = false;
    let messageListener: ((message: ContentScriptMessage) => void) | null = null;
    let createdTabId: number | null = null;

    const cleanup = () => {
      if (messageListener) {
        chrome.runtime.onMessage.removeListener(messageListener);
        messageListener = null;
      }
      if (createdTabId) {
        activeSchedulingTabs.delete(campaign.campaignId);
        chrome.tabs.remove(createdTabId).catch(() => {
          // Tab already closed or no permission — fine to ignore
        });
        createdTabId = null;
      }
    };

    const done = (result: ScheduleResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      cleanup();
      resolve(result);
    };

    // 90-second global timeout
    const timeout = setTimeout(() => {
      done({
        campaignId: campaign.campaignId,
        platform: campaign.platform,
        success: false,
        reason: 'timeout',
      });
    }, SCHEDULING_TIMEOUT_MS);

    // Register listener BEFORE tab creation to close the race condition window.
    // The campaignId filter ensures messages from other campaigns are ignored.
    // resolved flag prevents double-resolution from stale messages.
    messageListener = (message: ContentScriptMessage) => {
      if (message.campaignId !== campaign.campaignId) return;

      if (message.type === 'SCHEDULE_COMPLETE') {
        done({
          campaignId: campaign.campaignId,
          platform: campaign.platform,
          success: true,
          scheduledAt: message.scheduledAt,
        });
      } else if (message.type === 'SCHEDULE_FAILED') {
        done({
          campaignId: campaign.campaignId,
          platform: campaign.platform,
          success: false,
          reason: message.reason,
        });
      } else if (message.type === 'SCHEDULING_PROGRESS') {
        console.log(`[Litoral] ${message.step} (campaign: ${message.campaignId})`);
      }
    };

    // Now register the listener before tab creation
    chrome.runtime.onMessage.addListener(messageListener);

    // Open the platform scheduling page in a new inactive tab
    chrome.tabs.create({ url: platformUrl, active: false }, async tab => {
      if (!tab?.id) {
        done({
          campaignId: campaign.campaignId,
          platform: campaign.platform,
          success: false,
          reason: 'tab_creation_failed',
        });
        return;
      }

      // Track this tab for cleanup
      createdTabId = tab.id;
      activeSchedulingTabs.set(campaign.campaignId, tab.id);

      // Listener already registered before tab creation — messages from
      // all campaigns pass through but campaignId filter ensures correct routing.

      // Wait for the page to fully load
      // (auth redirects like accounts.instagram.com are normal —
      // the content script detects whether the scheduling page rendered)
      const urlValid = await waitForTabLoad(tab.id);
      if (!urlValid) {
        done({
          campaignId: campaign.campaignId,
          platform: campaign.platform,
          success: false,
          reason: 'tab_load_failed_or_redirected',
        });
        return;
      }

      // Send the scheduling command to the content script
      // (content scripts are registered at document_idle — they're already running)
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'START_SCHEDULING',
          campaign,
        } satisfies BackgroundToContentMessage);
        console.log(`[Litoral] Scheduling command sent to tab ${tab.id} for campaign ${campaign.campaignId}`);
      } catch (sendError) {
        console.error(`[Litoral] Failed to send START_SCHEDULING to tab ${tab.id}:`, sendError);
        // Don't fail here — the content script may still pick it up
        // If it doesn't respond within 90s, the timeout handles it
      }
    });
  });

  const result = await inner;
  if (result.success && result.scheduledAt) {
    await breaker.recordSuccess(campaign.platform);
  } else if (result.reason !== 'circuit_breaker_open') {
    // Circuit-breaker short-circuits already returned before we entered `inner`,
    // so this branch covers every real scheduling failure (timeout, tab errors,
    // SCHEDULE_FAILED from the content script). Re-recording failures caused
    // by the breaker being open would loop the same cycle before storage can
    // even observe the next isOpen read.
    await breaker.recordFailure(campaign.platform);
  }
  return result;
};

// ─── Server Communication ────────────────────────────────

/**
 * Notify the Litoral Platform API that a campaign has been scheduled.
 * Calls Story 6.2's POST /api/extension/queue/scheduled endpoint.
 * Atomically transitions pending_schedule → scheduled in D1.
 *
 * (Q9 fix candidate (a), 2026-07-18 — Phase 2.4 production-flight record):
 * This function does NOT swallow fetch rejections internally anymore. The
 * `try` block covers only the res.ok / res.json() read path; a network error
 * or non-OK response propagates to the caller's try/catch (in
 * `processPendingSchedules`'s loop body), which logs a single
 * `console.warn('[Litoral] markScheduledOnServer threw for campaign ...')`
 * and continues the cycle. The non-OK and status-!=='success' branches still
 * log + return early without throwing (best-effort surface observability),
 * so a 401/500/server-side rejection does NOT reach the outer wrapper — only
 * a thrown/rejected fetch (TypeError, network outage, primitive rejection)
 * does. This consolidates the marker's error-reporting surface at the new
 * outer catch site, which is the only path that needs the warning prefix
 * `markScheduledOnServer threw for campaign ...`.
 */
const markScheduledOnServer = async (campaignId: string, scheduledAt: string): Promise<void> => {
  const token = await extensionAuthStorage.getToken();
  if (!token) {
    console.error('[Litoral] Cannot mark scheduled — no auth token');
    return;
  }

  const res = await fetch(`${API_BASE_URL}/api/extension/queue/scheduled`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ campaignId, scheduledAt }),
  });

  if (!res.ok) {
    console.error(`[Litoral] Failed to mark campaign ${campaignId} as scheduled on server: ${res.status}`);
    return;
  }

  const body = await res.json();
  if (body.status !== 'success') {
    console.warn(
      `[Litoral] Server rejected schedule marker for campaign ${campaignId}:`,
      body.message ?? 'unknown error',
    );
  }
};

// ─── Helpers ─────────────────────────────────────────────

/**
 * Wait for a tab to fully load.
 * Removed domain validation — auth redirects (e.g., accounts.instagram.com)
 * are normal for social platforms. The content script itself detects whether
 * the scheduling page actually rendered, and the 90s global timeout covers
 * cases where the page never loads correctly.
 */
const waitForTabLoad = (tabId: number): Promise<boolean> =>
  new Promise(resolve => {
    let resolved = false;

    const listener = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (_tabId !== tabId || changeInfo.status !== 'complete') return;
      /* c8 ignore start -- defensive re-entrance guard: removeListener on the
         line below fires synchronously on first resolve, so the SAME listener
         cannot be invoked again. The unwrap exists for theoretically-reentrant
         frames (no caller relies on it) and never executes in practice. */
      if (resolved) return;
      /* c8 ignore stop */

      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
      resolve(true);
    };

    chrome.tabs.onUpdated.addListener(listener);

    // Timeout safety: resolve after TAB_LOAD_TIMEOUT_MS regardless
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false); // Timeout = invalid
      }
    }, TAB_LOAD_TIMEOUT_MS);
  });

/**
 * Get the scheduling page URL for a platform.
 * @throws Error if the platform code is not recognized
 */
const getPlatformScheduleUrl = (platform: string): string => {
  if (!Object.hasOwn(PLATFORM_SCHEDULE_URLS, platform)) {
    throw new Error(`Unknown platform: ${platform}`);
  }
  return PLATFORM_SCHEDULE_URLS[platform as PlatformCode];
};

/**
 * Simple delay utility.
 */
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Update the extension badge to reflect remaining pending count.
 */
const updateBadge = async (): Promise<void> => {
  const count = await extensionPollStorage.getPendingCount();
  if (count === 0) {
    await chrome.action.setBadgeText({ text: '' });
  } else {
    await chrome.action.setBadgeText({ text: String(count) });
    await chrome.action.setBadgeBackgroundColor({ color: '#0058bc' }); // primary blue
  }
};

// ─── Tab Cleanup ─────────────────────────────────────────

/**
 * Listen for tab removal — if a scheduling tab is closed manually,
 * the content script's beforeunload event should already have sent
 * SCHEDULE_FAILED. This is a secondary safety net.
 */
chrome.tabs.onRemoved.addListener(tabId => {
  for (const [campaignId, scheduledTabId] of activeSchedulingTabs.entries()) {
    if (scheduledTabId === tabId) {
      activeSchedulingTabs.delete(campaignId);
      console.log('[Litoral] Scheduling tab closed:', { tabId, campaignId });
      break;
    }
  }
});

export { processPendingSchedules, getSchedulingInProgress };
