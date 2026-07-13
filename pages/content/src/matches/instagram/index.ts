/**
 * Instagram Content Script — Native UI Scheduling
 *
 * This script runs on Instagram Creator Studio (instagram.com/creator/).
 * It navigates the Instagram web composer DOM, injects the campaign asset and
 * caption, and clicks "Schedule". Zero credentials stored or transmitted.
 *
 * Architecture:
 * - NFR-7: Uses the restaurant owner's authenticated session only
 * - Story 6.4 boundary: Isolated module — Instagram DOM changes won't break
 *   Facebook or TikTok scheduling
 * - Registered dynamically via chrome.scripting.registerContentScripts in the
 *   background worker, matches: ['https://www.instagram.com/*']
 *
 * Instagram's web scheduler is a React application. All inputs require native
 * value setters + synthetic event dispatch (see dom-utils.ts).
 */

import {
  waitForElement,
  clickElement,
  setTextContent,
  setDateTimeInput,
  uploadMedia,
  delay,
  detectLogin,
  waitForOutcome,
  DomUtilError,
} from '../../shared/dom-utils';
import type { CampaignPayload, ContentScriptMessage, BackgroundToContentMessage } from '@extension/shared';

// ─── Selectors ───────────────────────────────────────────

/**
 * Instagram Creator Studio selectors (June 2026).
 *
 * Instagram uses React with aria-label attributes — these are the most
 * stable selectors. CSS classes are auto-generated and change frequently.
 *
 * If scheduling fails with 'dom_not_found', review and update these selectors.
 */
const SELECTORS = {
  /** Button to open the post creator wizard */
  createPostButton: '[aria-label="Create post"]',
  /** Hidden file input that accepts images and videos */
  mediaUploadInput: 'input[type="file"][accept*="image"], input[type="file"][accept*="video"]',
  /** Caption text area */
  captionTextArea: '[aria-label="Write a caption..."]',
  /** Toggle/button to switch to schedule mode */
  scheduleToggle: '[role="button"][aria-label*="Schedule"]',
  /** Date/time picker input (shows after toggling schedule mode) */
  scheduleDateInput: 'input[type="datetime-local"]',
  /** Final "Schedule" confirmation button — scoped with type=button to
   *  disambiguate from the schedule toggle which also matches aria-label*="Schedule".
   *  In the Instagram dialog, the toggle is role="button" and the submit
   *  button is button[type="button"] with the same aria-label prefix. */
  scheduleButton: 'button[type="button"][aria-label*="Schedule"]',
  /** Success dialog confirmation */
  successIndicator: '[role="dialog"][aria-label*="Scheduled"], [role="dialog"]',
  /** Error dialog */
  errorIndicator: '[role="dialog"][aria-label*="error"], [role="alert"]',
  /** DOM element present only when the user is authenticated on Instagram (left nav / profile). */
  authenticatedMarker: '[aria-label="Instagram" i], nav a[aria-label*="Profile" i]',
} as const;

// ─── Campaign tracking for tab close detection ───────────

let currentCampaignId: string | null = null;

window.addEventListener('beforeunload', () => {
  // Chrome may not fire beforeunload for programmatic tab closures (chrome.tabs.remove).
  // The background worker's 90s timeout + onRemoved listener covers this case as safety net.
  isUnloading = true;
  if (currentCampaignId) {
    try {
      chrome.runtime.sendMessage({
        type: 'SCHEDULE_FAILED',
        campaignId: currentCampaignId,
        reason: 'tab_closed',
      } satisfies ContentScriptMessage);
    } catch {
      // Tab is unloading — message may not go through; rely on background timeout
    }
    currentCampaignId = null;
  }
});

/** Whether the tab is currently unloading (prevents duplicate SCHEDULE_FAILED messages) */
let isUnloading = false;

// ─── Scheduler ───────────────────────────────────────────

/**
 * Execute the Instagram scheduling flow.
 *
 * Steps:
 * 1. Open the post creator
 * 2. Upload the campaign asset (image or video)
 * 3. Wait for media processing
 * 4. Write the caption
 * 5. Toggle scheduling mode
 * 6. Set the scheduled date/time
 * 7. Click "Schedule"
 * 8. Wait for success confirmation
 */
const scheduleOnInstagram = async (campaign: CampaignPayload): Promise<void> => {
  currentCampaignId = campaign.campaignId;

  // Login gate: bail fast with LOGIN_REQUIRED if the authenticated-mode selector
  // doesn't appear. Avoids the slow wait-for-composer timeout on logged-out pages.
  if (!(await detectLogin({ authenticatedSelector: SELECTORS.authenticatedMarker, timeoutMs: 5_000 }))) {
    throw new DomUtilError('LOGIN_REQUIRED', `${campaign.platform} login required`, {
      selector: SELECTORS.authenticatedMarker,
    });
  }

  sendProgress(campaign.campaignId, 'Opening post creator');
  await waitForElement(SELECTORS.createPostButton, 10_000);
  clickElement(SELECTORS.createPostButton);

  sendProgress(campaign.campaignId, 'Uploading media');
  await waitForElement(SELECTORS.mediaUploadInput, 15_000);
  await uploadMedia(SELECTORS.mediaUploadInput, campaign.assetUrl, {
    waitForProcessing: { timeoutMs: 30_000 },
  });

  sendProgress(campaign.campaignId, 'Writing caption');
  await waitForElement(SELECTORS.captionTextArea, 10_000);
  setTextContent(SELECTORS.captionTextArea, campaign.caption);

  sendProgress(campaign.campaignId, 'Setting schedule time');
  await waitForElement(SELECTORS.scheduleToggle, 5_000);
  clickElement(SELECTORS.scheduleToggle);

  // Wait for the datetime picker to appear
  await delay(1_000);

  if (campaign.scheduledTime) {
    await waitForElement(SELECTORS.scheduleDateInput, 5_000);
    setDateTimeInput(SELECTORS.scheduleDateInput, campaign.scheduledTime);
  }

  sendProgress(campaign.campaignId, 'Clicking Schedule button');
  await waitForElement(SELECTORS.scheduleButton, 5_000);
  clickElement(SELECTORS.scheduleButton);

  sendProgress(campaign.campaignId, 'Waiting for confirmation');
  await waitForOutcome({
    successSelector: SELECTORS.successIndicator,
    failureSelector: SELECTORS.errorIndicator,
    timeoutMs: 30_000,
    extractFailureReason: el => {
      const txt = (el as HTMLElement).textContent?.trim();
      return txt ? `Platform error: ${txt}` : 'Platform error indicator shown';
    },
  });

  // Success!
  chrome.runtime.sendMessage({
    type: 'SCHEDULE_COMPLETE',
    campaignId: campaign.campaignId,
    scheduledAt: campaign.scheduledTime ?? new Date().toISOString(),
  } satisfies ContentScriptMessage);
};

// ─── Message Handling ────────────────────────────────────

const sendProgress = (campaignId: string, step: string): void => {
  chrome.runtime
    .sendMessage({
      type: 'SCHEDULING_PROGRESS',
      campaignId,
      step: `instagram: ${step}`,
    } satisfies ContentScriptMessage)
    .catch(() => {
      // Background worker may not be изначально — no-op
    });
};

/**
 * Listen for START_SCHEDULING messages from the background worker.
 * The content script is registered at document_idle and waits for this message.
 */
chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage, _sender, sendResponse) => {
  if (message.type === 'START_SCHEDULING') {
    const campaign = message.campaign;

    // Execute scheduling asynchronously
    scheduleOnInstagram(campaign)
      .then(() => {
        // Success handled inside scheduleOnInstagram
      })
      .catch((error: unknown) => {
        // Tab unload already sent SCHEDULE_FAILED — don't send duplicate
        if (isUnloading) return;
        const reason =
          error instanceof DomUtilError
            ? `${error.code}${error.selector ? `: ${error.selector}` : ''}`
            : error instanceof Error
              ? error.message
              : 'Unknown Instagram scheduling error';
        console.error('[Litoral] Instagram scheduling failed:', reason);
        // Guard against duplicate send if beforeunload handler already ran
        if (currentCampaignId !== campaign.campaignId) return;
        currentCampaignId = null;
        chrome.runtime.sendMessage({
          type: 'SCHEDULE_FAILED',
          campaignId: campaign.campaignId,
          reason,
        } satisfies ContentScriptMessage);
      });

    // Acknowledge receipt synchronously
    sendResponse({ received: true });
  } else if (message.type === 'CANCEL_SCHEDULING') {
    // Cancellation is handled by the background worker's timeout
    // Content script may still be in the middle of DOM operations
    console.log('[Litoral] Received cancel for campaign:', message.campaignId);
  }

  // Return false — no async response needed (we use sendMessage instead)
  return false;
});
