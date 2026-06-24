/** Platform codes supported by the scheduling engine */
export type PlatformCode = 'instagram' | 'facebook' | 'tiktok' | 'gbp';

/** Platforms that have working content script implementations */
export const SUPPORTED_PLATFORMS: readonly PlatformCode[] = ['instagram', 'facebook', 'tiktok', 'gbp'];

/** Campaign payload from the Litoral Platform API */
export interface CampaignPayload {
  campaignId: string;
  restaurantId: string;
  platform: PlatformCode;
  assetUrl: string;
  caption: string;
  scheduledTime?: string;
  mediaType: 'image' | 'video';
}

/** JSend success envelope */
export interface JSendSuccess<T> {
  status: 'success';
  data: T;
}

/** JSend error envelope */
export interface JSendError {
  status: 'error';
  message: string;
}

/** Union type for API response parsing */
export type ApiResponse<T> = JSendSuccess<T> | JSendError;

/** Messages from background service worker to popup */
export type BackgroundMessage =
  | { type: 'AUTH_REQUIRED'; message?: string }
  | { type: 'POLL_STATUS'; data: PollStatusPayload };

/** Status payload sent from service worker to popup */
export interface PollStatusPayload {
  pendingCount: number;
  lastPollTime: number | null;
  lastPollError: string | null;
  consecutiveFailures: number;
  isAuthenticated: boolean;
}

/** Popup requests to the service worker */
export type PopupMessage = { type: 'GET_STATE' } | { type: 'CONNECT'; token: string };

/** Result of a scheduling attempt on a social platform */
export interface ScheduleResult {
  campaignId: string;
  platform: string;
  success: boolean;
  reason?: string; // Failure reason (e.g., 'dom_not_found', 'timeout', 'tab_closed')
  scheduledAt?: string; // ISO 8601 — populated on success
}

/** Messages from content script → background worker */
export type ContentScriptMessage =
  | { type: 'SCHEDULE_COMPLETE'; campaignId: string; scheduledAt: string }
  | { type: 'SCHEDULE_FAILED'; campaignId: string; reason: string }
  | { type: 'SCHEDULING_PROGRESS'; campaignId: string; step: string };

/** Messages from background → content script */
export type BackgroundToContentMessage =
  | { type: 'START_SCHEDULING'; campaign: CampaignPayload }
  | { type: 'CANCEL_SCHEDULING'; campaignId: string };
