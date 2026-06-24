/**
 * Facebook Content Script — Native UI Scheduling
 *
 * This script runs on Meta Business Suite (business.facebook.com).
 * It navigates the Facebook web composer DOM, injects the campaign asset and
 * caption, sets the scheduled time, and clicks "Schedule". Zero credentials
 * stored or transmitted.
 *
 * Architecture:
 * - NFR-7: Uses the restaurant owner's authenticated session only
 * - Story 6.4 boundary: Isolated module — Facebook DOM changes won't break
 *   Instagram or TikTok scheduling
 * - Registered dynamically via chrome.scripting.registerContentScripts in the
 *   background worker, matches: ['https://business.facebook.com/*', 'https://www.facebook.com/*']
 *
 * Facebook's Meta Business Suite is a React application. All inputs require
 * native value setters + synthetic event dispatch (see dom-utils.ts).
 */

import {
  waitForElement,
  clickElement,
  setTextContent,
  setDateTimeInput,
  uploadMedia,
  delay,
} from '../../shared/dom-utils';
import type { CampaignPayload, ContentScriptMessage, BackgroundToContentMessage } from '@extension/shared';

// ─── Selectors ───────────────────────────────────────────

/**
 * Meta Business Suite selectors (June 2026).
 *
 * Facebook's Meta Business Suite uses a mix of aria-label and role-based
 * selectors. Aria-labels are preferred for stability.
 *
 * Note: Facebook's "Photo/Video" button reveals a hidden <input type="file">.
 * The scheduling workflow requires clicking the media button first, then
 * targeting the revealed input.
 *
 * If scheduling fails with 'dom_not_found', review and update these selectors.
 */
const SELECTORS = {
  /** Button to open the post composer */
  createPostButton: '[aria-label="Create post"]',
  /** "Photo/Video" button that reveals the hidden file input */
  mediaUploadButton: '[aria-label="Photo/Video"]',
  /** Hidden file input exposed after clicking Photo/Video */
  mediaUploadInput: 'input[type="file"]',
  /** Caption / "What's on your mind" text area */
  captionTextArea: '[aria-label*="What\'s on your mind"]',
  /** Publish button that opens the schedule dropdown */
  publishButton: '[role="button"][aria-label="Publish"], [role="button"][aria-label*="Publish"]',
  /** Schedule option in the publish dropdown */
  scheduleOption: '[role="menuitem"][aria-label*="Schedule"]',
  /** Date/time picker input (shows after selecting schedule) */
  scheduleDateInput: 'input[type="datetime-local"]',
  /** Final "Schedule post" button */
  scheduleButton: '[role="button"][aria-label*="Schedule post"]',
  /** Success dialog confirmation */
  successIndicator: '[role="dialog"][aria-label*="Post scheduled"]',
  /** Error dialog */
  errorIndicator: '[role="dialog"][aria-label*="error"], [role="alert"]',
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
 * Execute the Facebook scheduling flow.
 *
 * Steps:
 * 1. Open the post composer
 * 2. Click "Photo/Video" to reveal the file input
 * 3. Upload the campaign asset
 * 4. Write the caption
 * 5. Click the Publish button to open the dropdown
 * 6. Select the "Schedule" option from the dropdown
 * 7. Set the scheduled date/time
 * 8. Click "Schedule post"
 * 9. Wait for success confirmation
 */
const scheduleOnFacebook = async (campaign: CampaignPayload): Promise<void> => {
  currentCampaignId = campaign.campaignId;

  sendProgress(campaign.campaignId, 'Opening post composer');
  await waitForElement(SELECTORS.createPostButton, 10_000);
  clickElement(SELECTORS.createPostButton);

  sendProgress(campaign.campaignId, 'Opening media upload');
  await waitForElement(SELECTORS.mediaUploadButton, 5_000);
  clickElement(SELECTORS.mediaUploadButton);

  // Facebook's file input appears after clicking the media button
  await delay(1_000);

  sendProgress(campaign.campaignId, 'Uploading media');
  await waitForElement(SELECTORS.mediaUploadInput, 10_000);
  await uploadMedia(SELECTORS.mediaUploadInput, campaign.assetUrl);

  // Facebook takes a few seconds to process uploaded media
  await delay(3_000);

  sendProgress(campaign.campaignId, 'Writing caption');
  await waitForElement(SELECTORS.captionTextArea, 10_000);
  setTextContent(SELECTORS.captionTextArea, campaign.caption);

  // Click the Publish button to open the dropdown containing the schedule option
  sendProgress(campaign.campaignId, 'Opening publish dropdown');
  await waitForElement(SELECTORS.publishButton, 5_000);
  clickElement(SELECTORS.publishButton);

  // Wait for dropdown to appear
  await delay(500);

  sendProgress(campaign.campaignId, 'Selecting schedule option');
  await waitForElement(SELECTORS.scheduleOption, 5_000);
  clickElement(SELECTORS.scheduleOption);

  // Wait for the schedule date picker to appear
  await delay(1_000);

  if (campaign.scheduledTime) {
    sendProgress(campaign.campaignId, 'Setting schedule time');
    await waitForElement(SELECTORS.scheduleDateInput, 5_000);
    setDateTimeInput(SELECTORS.scheduleDateInput, campaign.scheduledTime);
  }

  sendProgress(campaign.campaignId, 'Clicking Schedule post button');
  await waitForElement(SELECTORS.scheduleButton, 5_000);
  clickElement(SELECTORS.scheduleButton);

  sendProgress(campaign.campaignId, 'Waiting for confirmation');
  await waitForElement(SELECTORS.successIndicator, 30_000);

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
      step: `facebook: ${step}`,
    } satisfies ContentScriptMessage)
    .catch(() => {
      // Background worker may not be listening — no-op
    });
};

/**
 * Listen for START_SCHEDULING messages from the background worker.
 * The content script is registered at document_idle and waits for this message.
 */
chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage, _sender, sendResponse) => {
  if (message.type === 'START_SCHEDULING') {
    const campaign = message.campaign;

    scheduleOnFacebook(campaign)
      .then(() => {
        // Success handled inside scheduleOnFacebook
      })
      .catch((error: unknown) => {
        // Tab unload already sent SCHEDULE_FAILED — don't send duplicate
        if (isUnloading) return;
        const reason = error instanceof Error ? error.message : 'Unknown Facebook scheduling error';
        console.error('[Litoral] Facebook scheduling failed:', reason);
        // Guard against duplicate send if beforeunload handler already ran
        if (currentCampaignId !== campaign.campaignId) return;
        currentCampaignId = null;
        chrome.runtime.sendMessage({
          type: 'SCHEDULE_FAILED',
          campaignId: campaign.campaignId,
          reason,
        } satisfies ContentScriptMessage);
      });

    sendResponse({ received: true });
  } else if (message.type === 'CANCEL_SCHEDULING') {
    console.log('[Litoral] Received cancel for campaign:', message.campaignId);
  }

  return false;
});
