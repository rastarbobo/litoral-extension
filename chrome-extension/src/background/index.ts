import { processPendingSchedules } from './scheduling-orchestrator';
import { API_BASE_URL } from '../config';
import { extensionAuthStorage, extensionPollStorage } from '@extension/storage';
import type {
  CampaignPayload,
  ApiResponse,
  PollStatusPayload,
  BackgroundMessage,
  PopupMessage,
} from '@extension/shared';

// ─── Constants ───────────────────────────────────────────

const POLL_ALARM_NAME = 'campaign-queue-poll';
const MAX_CONSECUTIVE_FAILURES = 6;
const BADGE_AUTH_REQUIRED = '🔑';
const BADGE_ERROR = '!';

/**
 * Poll-alarm cadence on consecutive polling failures.
 *
 * Indexed by `consecutiveFailures - 1` (zero-based), so the first failed poll
 * re-arms at 1 minute, the second at 2, the third at 5, and stays at 5 until
 * the next successful poll resets the cadence. The cap is a defensive floor
 * in case the array is ever extended beyond `POLL_BACKOFF_CAP_MINUTES`.
 */
const POLL_BACKOFF_STEPS = [1, 2, 5] as const;
const POLL_BACKOFF_CAP_MINUTES = 5;
const POLL_DEFAULT_PERIOD_MINUTES = 20;

// ─── Alarm Lifecycle ─────────────────────────────────────

// persistAcrossSessions is omitted intentionally: the @types/chrome definition for
// AlarmCreateInfo doesn't include it, and chrome.runtime.onStartup (below) ensures the
// alarm recreates after a browser restart.
const createPollAlarm = async (): Promise<void> => {
  const existing = await chrome.alarms.get(POLL_ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(POLL_ALARM_NAME, {
      periodInMinutes: POLL_DEFAULT_PERIOD_MINUTES,
    });
    console.log('[Litoral] Poll alarm created: every', POLL_DEFAULT_PERIOD_MINUTES, 'minutes');
  }
};

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Litoral] Extension installed/updated — creating alarm and performing initial poll');
  await createPollAlarm();
  await registerContentScripts();
  await checkAuthAndPoll();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[Litoral] Browser started — verifying alarm exists');
  await createPollAlarm();
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === POLL_ALARM_NAME) {
    console.log('[Litoral] Poll alarm fired');
    await checkAuthAndPoll();
  }
});

// ─── Auth Check & Poll Flow ──────────────────────────────

const checkAuthAndPoll = async (): Promise<void> => {
  const hasToken = await extensionAuthStorage.hasToken();
  if (!hasToken) {
    await setBadgeAuthRequired();
    return;
  }
  const token = await extensionAuthStorage.getToken();
  if (!token) {
    await setBadgeAuthRequired();
    return;
  }
  await pollForCampaigns(token);
};

const setBadgeAuthRequired = async (): Promise<void> => {
  await chrome.action.setBadgeText({ text: BADGE_AUTH_REQUIRED });
  await chrome.action.setBadgeBackgroundColor({ color: '#9e3d00' }); // tertiary/orange
};

// ─── API Response Helper ─────────────────────────────────

const isApiResponseStatusError = <T>(response: ApiResponse<T>): response is { status: 'error'; message: string } =>
  response.status === 'error';

/**
 * Check if an API response indicates an unauthorized (401) failure.
 * Used to normalize 401 detection across all endpoints.
 */
const isApiUnauthorized = <T>(response: ApiResponse<T>): boolean =>
  response.status === 'error' && (response.message.includes('401') || response.message.includes('Unauthorized'));

// ─── API Client ──────────────────────────────────────────

const fetchQueue = async (token: string): Promise<ApiResponse<{ campaigns: CampaignPayload[] }>> => {
  const res = await fetch(`${API_BASE_URL}/api/extension/queue`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    return { status: 'error', message: 'Unauthorized — token expired or invalid' };
  }
  if (!res.ok) {
    return { status: 'error', message: `Server error: ${res.status}` };
  }
  return res.json() as Promise<ApiResponse<{ campaigns: CampaignPayload[] }>>;
};

const claimCampaign = async (token: string, campaignId: string): Promise<ApiResponse<{ claimed: boolean }>> => {
  const res = await fetch(`${API_BASE_URL}/api/extension/queue/claim`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ campaignId }),
  });
  if (res.status === 401) {
    return { status: 'error', message: 'Unauthorized — claim failed: 401' };
  }
  if (!res.ok) {
    return { status: 'error', message: `Claim failed: ${res.status}` };
  }
  return res.json() as Promise<ApiResponse<{ claimed: boolean }>>;
};

// ─── Poll Logic ──────────────────────────────────────────

const pollForCampaigns = async (token: string): Promise<void> => {
  try {
    const response = await fetchQueue(token);

    if (isApiResponseStatusError(response)) {
      const isUnauthorized = isApiUnauthorized(response);
      await handlePollError(response.message, isUnauthorized);
      return;
    }

    const { campaigns } = response.data;

    if (campaigns.length === 0) {
      await handlePollSuccess();
      console.log('[Litoral] Poll successful — no campaigns waiting');
      return;
    }

    // Claim each campaign atomically
    for (const campaign of campaigns) {
      const claimResult = await claimCampaign(token, campaign.campaignId);
      if (isApiResponseStatusError(claimResult)) {
        // Check if the claim itself returned a 401
        if (isApiUnauthorized(claimResult)) {
          await handlePollError(claimResult.message, true);
          return; // Abort remaining claims, token is bad
        }
        console.warn('[Litoral] Claim failed for campaign:', campaign.campaignId, claimResult);
        continue;
      }
      if (claimResult.data.claimed) {
        await extensionPollStorage.storeClaimedCampaign(campaign);
        console.log('[Litoral] Claimed campaign:', campaign.campaignId);
      } else {
        console.log('[Litoral] Campaign already claimed (idempotent):', campaign.campaignId);
      }
    }

    await handlePollSuccess();
    console.log('[Litoral] Poll successful — processed', campaigns.length, 'campaign(s)');

    // Trigger scheduling for newly claimed campaigns
    // (does nothing if already in progress or no campaigns pending)
    await processPendingSchedules();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network error';
    await handlePollError(message, false);
  }
};

// ─── Poll Alarm Backoff ──────────────────────────────────

/**
 * Recreate the poll alarm with a one-shot `delayInMinutes` window. We use
 * `delayInMinutes` instead of `periodInMinutes` so the alarm fires exactly
 * once at the next scheduled tick; if the next tick triggers another
 * backoff (or reset), the alarm listener overwrites the schedule rather than
 * coasting on a stale period.
 */
const reschedulePollAlarm = async (delayMinutes: number): Promise<void> => {
  await chrome.alarms.clear(POLL_ALARM_NAME);
  await chrome.alarms.create(POLL_ALARM_NAME, {
    delayInMinutes: delayMinutes,
  });
};

/**
 * Reset all backoff bookkeeping and re-arm the alarm at the default cadence
 * (one-shot `delayInMinutes` of 20, which is also the historical polling
 * period). Next successful poll re-schedules again — the cascade is self-
 * perpetuating as long as `checkAuthAndPoll` continues to succeed.
 */
const handlePollSuccess = async (): Promise<void> => {
  await extensionPollStorage.markPollSuccess();
  await extensionPollStorage.setPollBackoff(null);
  await extensionPollStorage.resetFailureCount();
  await updateBadgeFromStorage();
  await reschedulePollAlarm(POLL_DEFAULT_PERIOD_MINUTES);
};

// ─── Error Handling ──────────────────────────────────────

const handlePollError = async (message: string, isUnauthorized: boolean): Promise<void> => {
  await extensionPollStorage.recordFailure(message);

  const state = await extensionPollStorage.get();
  const failures = state.consecutiveFailures;

  if (isUnauthorized) {
    // 401: clear token, alert owner
    await extensionAuthStorage.clearToken();
    await chrome.action.setBadgeText({ text: BADGE_AUTH_REQUIRED });
    await chrome.action.setBadgeBackgroundColor({ color: '#9e3d00' });
    // Try to notify popup
    try {
      await chrome.runtime.sendMessage({
        type: 'AUTH_REQUIRED',
        message,
      } satisfies BackgroundMessage);
    } catch {
      // Popup not open — that's fine
    }
    console.warn('[Litoral] Auth token expired — badge set to 🔑');
  } else {
    // Non-401 failure: apply exponential backoff before the next poll. The
    // failure counter was already incremented inside `recordFailure` so we
    // look it up here and translate failures-1 → step index.
    const idx = Math.min(failures - 1, POLL_BACKOFF_STEPS.length - 1);
    const steppedMinutes = POLL_BACKOFF_STEPS[Math.max(idx, 0)];
    const nextMinutes = Math.min(steppedMinutes, POLL_BACKOFF_CAP_MINUTES);
    await extensionPollStorage.setPollBackoff(nextMinutes);
    await reschedulePollAlarm(nextMinutes);

    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      // 6 consecutive failures (2 hours): notify owner
      await chrome.action.setBadgeText({ text: BADGE_ERROR });
      await chrome.action.setBadgeBackgroundColor({ color: '#ba1a1a' }); // error red
      try {
        await chrome.notifications.create('litoral-connection-error', {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon-128.png'),
          title: 'Litoral: Connection Issue',
          message: 'Unable to reach server. Please check your internet connection and reopen Chrome.',
        });
        console.error('[Litoral] Max consecutive failures reached — notification sent');
      } catch (e) {
        console.warn('[Litoral] Failed to show notification:', e);
      }
    }
  }
};

// ─── Badge Management ────────────────────────────────────

const updateBadgeFromStorage = async (): Promise<void> => {
  const count = await extensionPollStorage.getPendingCount();
  if (count === 0) {
    await chrome.action.setBadgeText({ text: '' });
  } else {
    await chrome.action.setBadgeText({ text: String(count) });
    await chrome.action.setBadgeBackgroundColor({ color: '#0058bc' }); // primary blue
  }
};

// ─── Popup Message Handler ───────────────────────────────

interface SendResponse {
  (response: unknown): void;
  _called?: boolean;
}

chrome.runtime.onMessage.addListener((message, _sender, rawSendResponse) => {
  const sendResponse = rawSendResponse as SendResponse;
  const msg = message as PopupMessage;

  void (async () => {
    switch (msg.type) {
      case 'GET_STATE': {
        const [pollState, isAuthenticated] = await Promise.all([
          extensionPollStorage.get(),
          extensionAuthStorage.hasToken(),
        ]);
        const payload: PollStatusPayload = {
          pendingCount: pollState.pendingSchedules.length,
          lastPollTime: pollState.lastPollTime,
          lastPollError: pollState.lastPollError,
          consecutiveFailures: pollState.consecutiveFailures,
          isAuthenticated,
        };
        if (!sendResponse._called) {
          sendResponse._called = true;
          sendResponse({ type: 'POLL_STATUS', data: payload });
        }
        break;
      }
      case 'CONNECT': {
        await extensionAuthStorage.setToken(msg.token);
        void checkAuthAndPoll(); // Non-blocking
        if (!sendResponse._called) {
          sendResponse._called = true;
          sendResponse({ success: true });
        }
        break;
      }
    }
  })();

  return true; // keep channel open for async response
});

// ─── Content Script Registration ─────────────────────────

/**
 * Register content scripts for each supported social platform.
 *
 * These scripts run at document_idle on their respective platform pages.
 * They do NOT auto-execute scheduling — they wait for START_SCHEDULING
 * messages from the background scheduling orchestrator.
 *
 * Architecture: NO domain allowlist in manifest.json.
 * Content scripts are registered dynamically via scripting API.
 */
const registerContentScripts = async (): Promise<void> => {
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: 'litoral-instagram-scheduler',
        matches: ['https://www.instagram.com/*'],
        js: ['content/instagram.js'],
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
      {
        id: 'litoral-facebook-scheduler',
        matches: ['https://business.facebook.com/*', 'https://www.facebook.com/*'],
        js: ['content/facebook.js'],
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
      {
        id: 'litoral-tiktok-scheduler',
        matches: ['https://www.tiktok.com/creator-center/*'],
        js: ['content/tiktok.js'],
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
      {
        id: 'litoral-gbp-scheduler',
        matches: ['https://business.google.com/*'],
        js: ['content/gbp.js'],
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
    ]);
    console.log('[Litoral] Content scripts registered for all platforms');
  } catch (err) {
    // Already registered from a previous session — that's fine
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Duplicate')) {
      console.log('[Litoral] Content scripts already registered (from previous session)');
    } else {
      console.warn('[Litoral] Content script registration warning:', message);
    }
  }
};
