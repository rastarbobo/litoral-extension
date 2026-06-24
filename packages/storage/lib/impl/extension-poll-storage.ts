import { createStorage, StorageEnum } from '../base/index.js';
// CampaignPayload and extension types are defined elsewhere, import from the local extension-types.ts
// or define inline to avoid circular deps.
// For tsconfig-noEmit mode without a built dist, we cannot cross-import from @extension/shared
// because it also depends on @extension/storage. Define locally or use a shared types file.

// Platform codes supported by the scheduling engine
type PlatformCode = 'instagram' | 'facebook' | 'tiktok' | 'gbp';

/** Campaign payload from the Litoral Platform API */
interface CampaignPayload {
  campaignId: string;
  restaurantId: string;
  platform: PlatformCode;
  assetUrl: string;
  caption: string;
  scheduledTime?: string;
  mediaType: 'image' | 'video';
}

/** Shape of the poll status and campaign storage */
interface PollState {
  /** Campaigns that have been claimed and are awaiting scheduling (Story 6.3) */
  pendingSchedules: CampaignPayload[];
  /** Consecutive poll failures */
  consecutiveFailures: number;
  /** Last successful poll timestamp (milliseconds since epoch) */
  lastPollTime: number | null;
  /** Last error message from a failed poll */
  lastPollError: string | null;
  /** Poll failure log entries */
  pollFailures: Array<{ timestamp: number; message: string }>;
}

const initialState: PollState = {
  pendingSchedules: [],
  consecutiveFailures: 0,
  lastPollTime: null,
  lastPollError: null,
  pollFailures: [],
};

const storage = createStorage<PollState>('litoral-poll-storage-key', initialState, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

const MAX_PENDING_CAMPAIGNS = 100; // Prevent storage quota exhaustion

export const extensionPollStorage = {
  ...storage,

  /** Append a claimed campaign to pending schedules */
  storeClaimedCampaign: async (campaign: CampaignPayload) => {
    await storage.set(state => {
      const pendingSchedules = [...state.pendingSchedules, campaign];
      // Cap to prevent storage quota exhaustion
      if (pendingSchedules.length > MAX_PENDING_CAMPAIGNS) {
        pendingSchedules.splice(0, pendingSchedules.length - MAX_PENDING_CAMPAIGNS);
      }
      return { ...state, pendingSchedules };
    });
  },

  /** Reset consecutive failure count after a successful poll */
  resetFailureCount: async () => {
    await storage.set(state => ({
      ...state,
      consecutiveFailures: 0,
      lastPollError: null,
    }));
  },

  /** Record a poll failure */
  recordFailure: async (message: string) => {
    await storage.set(state => {
      const newFailures = [...state.pollFailures, { timestamp: Date.now(), message }].slice(-20); // keep last 20
      const newCount = state.consecutiveFailures + 1;
      return {
        ...state,
        consecutiveFailures: newCount,
        lastPollError: message,
        pollFailures: newFailures,
      };
    });
  },

  /** Mark a successful poll timestamp */
  markPollSuccess: async () => {
    await storage.set(state => ({
      ...state,
      lastPollTime: Date.now(),
    }));
  },

  /** Get pending campaign count */
  getPendingCount: async (): Promise<number> => {
    const state = await storage.get();
    return state.pendingSchedules.length;
  },

  /** Remove a campaign from pending schedules after scheduling (success or failure) */
  removeCampaign: async (campaignId: string) => {
    await storage.set(state => ({
      ...state,
      pendingSchedules: state.pendingSchedules.filter(c => c.campaignId !== campaignId),
    }));
  },
};
