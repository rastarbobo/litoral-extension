/**
 * TikTok Content Script — Native UI Scheduling (Story 6.4 Placeholder)
 *
 * TikTok scheduling is NOT yet implemented. This placeholder exists so the
 * scheduling orchestrator's dynamic dispatch for 'tiktok' doesn't fail at runtime.
 * Story 6.4 will replace this with a real implementation.
 *
 * Architecture:
 * - NFR-7: Uses the restaurant owner's authenticated session only
 * - Story 6.4 boundary: Isolated module
 * - Registered dynamically via chrome.scripting.registerContentScripts in the
 *   background worker, matches: ['https://www.tiktok.com/creator-center/*']
 */

import type { ContentScriptMessage, BackgroundToContentMessage } from '@extension/shared';

chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage) => {
  if (message.type === 'START_SCHEDULING') {
    chrome.runtime.sendMessage({
      type: 'SCHEDULE_FAILED',
      campaignId: message.campaign.campaignId,
      reason: 'Platform not yet supported (Story 6.4)',
    } satisfies ContentScriptMessage);
  }
  return false;
});
