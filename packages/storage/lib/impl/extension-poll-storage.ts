import { createStorage, StorageEnum } from '../base/index.js';

// NOTE: Cross-package import from `@extension/shared` is intentionally avoided here.
// `@extension/shared` declares a `devDependency` on `@extension/storage` (see
// packages/shared/package.json), so importing back into `@extension/shared` from this
// package would create a circular workspace dependency and `@extension/shared` is not
// listed under packages/storage/package.json#dependencies. To keep this package
// self-contained (and respecting tsconfig-noEmit, no built `dist`), `PlatformCode`,
// `CampaignPayload`, and `SUPPORTED_PLATFORMS` are redeclared locally. Keep these in
// sync with packages/shared/lib/utils/extension-types.ts. A future refactor may split
// pure types into a separate `packages/shared-types/` package to remove this redeclaration.

// Platform codes supported by the scheduling engine
type PlatformCode = 'instagram' | 'facebook' | 'tiktok' | 'gbp';

const SUPPORTED_PLATFORMS_LOCAL: readonly PlatformCode[] = ['instagram', 'facebook', 'tiktok', 'gbp'];

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

type PlatformTelemetry = {
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastErrorCode: string | null;
  lastErrorReason: string | null;
  consecutiveFailures: number;
};

type PlatformTelemetryMap = Partial<Record<PlatformCode, PlatformTelemetry>>;

const EMPTY_TELEMETRY: PlatformTelemetry = {
  lastSuccessAt: null,
  lastFailureAt: null,
  lastErrorCode: null,
  lastErrorReason: null,
  consecutiveFailures: 0,
};

const INITIAL_TELEMETRY: PlatformTelemetryMap = SUPPORTED_PLATFORMS_LOCAL.reduce((acc, platform) => {
  acc[platform] = { ...EMPTY_TELEMETRY };
  return acc;
}, {} as PlatformTelemetryMap);

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
  /** Per-platform success/failure telemetry */
  telemetry: PlatformTelemetryMap;
  /** Backend-suggested poll backoff in minutes (null when none) */
  pollBackoffMinutes: number | null;
}

const initialState: PollState = {
  pendingSchedules: [],
  consecutiveFailures: 0,
  lastPollTime: null,
  lastPollError: null,
  pollFailures: [],
  telemetry: { ...INITIAL_TELEMETRY },
  pollBackoffMinutes: null,
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

  /** Record a successful platform interaction; clears error fields and resets counter */
  recordPlatformSuccess: async (platform: PlatformCode) => {
    await storage.set(state => {
      const previous = state.telemetry[platform] ?? { ...EMPTY_TELEMETRY };
      return {
        ...state,
        telemetry: {
          ...state.telemetry,
          [platform]: {
            ...previous,
            lastSuccessAt: Date.now(),
            lastErrorCode: null,
            lastErrorReason: null,
            consecutiveFailures: 0,
          },
        },
      };
    });
  },

  /** Record a platform failure with structured code + reason; retains previous success timestamp */
  recordPlatformFailure: async (platform: PlatformCode, code: string, reason: string) => {
    await storage.set(state => {
      const previous = state.telemetry[platform] ?? { ...EMPTY_TELEMETRY };
      return {
        ...state,
        telemetry: {
          ...state.telemetry,
          [platform]: {
            ...previous,
            lastFailureAt: Date.now(),
            lastErrorCode: code,
            lastErrorReason: reason,
            consecutiveFailures: previous.consecutiveFailures + 1,
          },
        },
      };
    });
  },

  /** Return the raw telemetry map (or freshly-initialized one if missing) */
  getTelemetry: async (): Promise<PlatformTelemetryMap> => {
    const state = await storage.get();
    return state.telemetry ?? { ...INITIAL_TELEMETRY };
  },

  /** Persist a backend-suggested poll backoff in minutes (null clears it) */
  setPollBackoff: async (minutes: number | null) => {
    await storage.set(state => ({ ...state, pollBackoffMinutes: minutes }));
  },

  /** Read the current poll backoff in minutes */
  getPollBackoff: async (): Promise<number | null> => {
    const state = await storage.get();
    return state.pollBackoffMinutes;
  },

  /** Reset telemetry entries to zeroed values and clear poll backoff */
  clearAllTelemetry: async () => {
    await storage.set(state => ({
      ...state,
      telemetry: { ...INITIAL_TELEMETRY },
      pollBackoffMinutes: null,
    }));
  },
};
