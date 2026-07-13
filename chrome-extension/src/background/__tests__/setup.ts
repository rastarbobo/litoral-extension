/**
 * Global Chrome Extension API shim for Vitest tests.
 *
 * Installs an in-memory `chrome` global BEFORE any production module (the
 * scheduling orchestrator, the storage package) reads `globalThis.chrome`.
 * Each test file's `setupFiles` directive ensures this module runs first.
 *
 * The shim models the surface area used by `chrome-extension/src/background`:
 * `storage.local`, `storage.session`, `runtime`, `alarms`, `tabs`, `action`,
 * `notifications`, and `scripting`.
 *
 * Dual API styles
 * ---------------
 * Production mixes callback-style and Promise-style Chrome calls:
 * - `chrome.storage.local.get(keys, cb)` (callback) — `circuit-breaker.ts`
 * - `await chrome.storage.local.get(keys)` (Promise) — `packages/storage/lib/base/base.ts`
 * - `chrome.tabs.create(opts, cb)` (callback) — `scheduling-orchestrator.ts`
 * - `chrome.tabs.remove(id).catch(...)` (Promise) — orchestrator cleanup
 * - `await chrome.alarms.create(...)` (Promise) — `index.ts`
 *
 * To support both, every method detects an optional trailing callback:
 * when present it is invoked synchronously (returning `undefined`);
 * when absent a Promise resolves with the same value. The promise also
 * resolves whenever the real Chrome API would (e.g. `alarms.create` → void,
 * `alarms.get` → alarm | undefined, `notifications.create` → id string).
 *
 * Listener arrays and side-effect records (`__tabCreateCalls`, `__sentMessages`,
 * `__tabMessages`, `__registeredScripts`) plus a `__badge` snapshot let tests
 * assert externalized behavior. `__resetChromeShim` wipes all internal state
 * so each test starts from a blank slate.
 */

type Listener<T extends unknown[]> = (...args: T) => void;

interface TabRecord {
  id: number;
  status: 'loading' | 'complete';
  url?: string;
}

interface AlarmRecord {
  name: string;
  scheduledTime?: number;
  periodInMinutes?: number;
  delayInMinutes?: number;
}

interface CreateTabsProps {
  url?: string;
  active?: boolean;
}

interface CreatedTab {
  id: number;
  status: string;
  url?: string;
}

// ─── Internal state (module-scoped so spies/listeners share identity) ───

const storageMap = new Map<string, unknown>();
const sessionMap = new Map<string, unknown>();
const alarmsMap = new Map<string, AlarmRecord>();
const tabsMap = new Map<number, TabRecord>();

const storageOnChangedListeners: Array<Listener<[{ [key: string]: { oldValue?: unknown; newValue?: unknown } }]>> = [];
const sessionOnChangedListeners: Array<Listener<[{ [key: string]: { oldValue?: unknown; newValue?: unknown } }]>> = [];
const runtimeOnMessageListeners: Array<Listener<[unknown, unknown, (response: unknown) => void]>> = [];
const alarmsOnAlarmListeners: Array<Listener<[{ name: string }]>> = [];
const tabsOnUpdatedListeners: Array<Listener<[number, { status?: string; url?: string }, { id: number }]>> = [];
const tabsOnRemovedListeners: Array<Listener<[number]>> = [];

let runtimeLastError: unknown;

/** Public record arrays — tests assert on these. */
let __nextTabId = 1;
const __tabCreateCalls: Array<CreateTabsProps> = [];
const __sentMessages: unknown[] = [];
const __tabMessages: Array<{ id: number; msg: unknown }> = [];
const __registeredScripts: unknown[] = [];
const __notifications = new Map<string, unknown>();
const __badge: { text: string; color: string | undefined } = { text: '', color: undefined };

// ─── Helpers ────────────────────────────────────────────

/** Coerce `keys` to an array of strings (or "all keys" when null/undefined). */
const normalizeKeys = (keys: string | string[] | null | undefined): string[] | null => {
  if (keys === null || keys === undefined) return null;
  if (Array.isArray(keys)) return keys.filter(k => typeof k === 'string') as string[];
  if (typeof keys === 'string') return [keys];
  return null;
};

/** Build a { [key]: value } response object for `storage.local.get`. */
const pickValues = (keys: string[] | null, map: Map<string, unknown>): Record<string, unknown> => {
  if (keys === null) {
    return Object.fromEntries(map.entries());
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (map.has(k)) {
      out[k] = map.get(k);
    }
  }
  return out;
};

/**
 * Bridge callback/Promise duality. If `cb` is provided, call it synchronously
 * with `value` (chrome's old-style API returns undefined). If not, return a
 * Promise resolving to `value` (chrome's MV3 Promise-style API).
 */
const dual = <T, C extends ((value: T) => void) | undefined>(
  cb: C,
  value: T,
): C extends undefined ? Promise<T> : undefined => {
  if (cb) {
    (cb as (value: T) => void)(value);
    return undefined as C extends undefined ? Promise<T> : undefined;
  }
  return Promise.resolve(value) as C extends undefined ? Promise<T> : undefined;
};

// ─── Storage area factory ───────────────────────────────

const makeStorageArea = (
  map: Map<string, unknown>,
  onChangedListeners: Array<Listener<[{ [key: string]: { oldValue?: unknown; newValue?: unknown } }]>>,
) => {
  const get = (
    keys: string | string[] | null | undefined,
    cb?: (items: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> | void => {
    const result = pickValues(normalizeKeys(keys), map);
    // Match chrome API: lastError is inspected by production in the cb branch.
    // Even in Promise mode we fall through with whatever values matched.
    return dual(cb, result) as Promise<Record<string, unknown>> | void;
  };

  const set = (obj: Record<string, unknown>, cb?: () => void): Promise<void> | void => {
    const changes: { [key: string]: { oldValue?: unknown; newValue?: unknown } } = {};
    for (const [k, v] of Object.entries(obj)) {
      const oldValue = map.get(k);
      map.set(k, v);
      changes[k] = { oldValue, newValue: v };
    }
    const result: Promise<void> | void = dual(cb, undefined);
    // Emit AFTER the callback (production callers don't depend on order, but
    // tests do for deterministic ordering of liveUpdate listeners).
    for (const fn of [...onChangedListeners]) {
      fn(changes);
    }
    return result;
  };

  const remove = (keys: string | string[], cb?: () => void): Promise<void> | void => {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) {
      map.delete(k);
    }
    return dual(cb, undefined);
  };

  const clear = (cb?: () => void): Promise<void> | void => {
    map.clear();
    return dual(cb, undefined);
  };

  return {
    get,
    set,
    remove,
    clear,
    onChanged: {
      addListener: (fn: Listener<[{ [key: string]: { oldValue?: unknown; newValue?: unknown } }]>) => {
        onChangedListeners.push(fn);
      },
      removeListener: (fn: Listener<[{ [key: string]: { oldValue?: unknown; newValue?: unknown } }]>) => {
        const idx = onChangedListeners.indexOf(fn);
        if (idx >= 0) onChangedListeners.splice(idx, 1);
      },
      hasListener: (fn: Listener<[{ [key: string]: { oldValue?: unknown; newValue?: unknown } }]>) =>
        onChangedListeners.includes(fn),
    },
  };
};

// ─── Chrome shim ─────────────────────────────────────────

const chromeShim = {
  storage: {
    local: makeStorageArea(storageMap, storageOnChangedListeners),
    session: makeStorageArea(sessionMap, sessionOnChangedListeners),
  },
  runtime: {
    get lastError(): unknown {
      return runtimeLastError;
    },
    getURL: (path: string): string => `chrome-extension://${path}`,
    onMessage: {
      addListener: (fn: Listener<[unknown, unknown, (response: unknown) => void]>) => {
        runtimeOnMessageListeners.push(fn);
      },
      removeListener: (fn: Listener<[unknown, unknown, (response: unknown) => void]>) => {
        const idx = runtimeOnMessageListeners.indexOf(fn);
        if (idx >= 0) runtimeOnMessageListeners.splice(idx, 1);
      },
      hasListener: (fn: Listener<[unknown, unknown, (response: unknown) => void]>) =>
        runtimeOnMessageListeners.includes(fn),
    },
    sendMessage: (msg: unknown, cb?: (response: unknown) => void): Promise<void> | void => {
      __sentMessages.push(msg);
      return dual(cb, undefined);
    },
  },
  alarms: {
    create: (name: string, opts?: AlarmRecord): Promise<void> => {
      alarmsMap.set(name, { name, ...(opts ?? {}) });
      // `chrome.alarms.create` neither accepts a callback in production nor
      // resolves a meaningful value — return a resolved Promise for `await`.
      return Promise.resolve();
    },
    get: (name: string, cb?: (alarm: AlarmRecord | undefined) => void): Promise<AlarmRecord | undefined> | void => {
      const alarm = alarmsMap.get(name);
      return dual(cb, alarm);
    },
    clear: (name: string, cb?: (wasCleared: boolean) => void): Promise<boolean> | void => {
      const wasCleared = alarmsMap.delete(name);
      return dual(cb, wasCleared);
    },
    clearAll: (cb?: (wasCleared: boolean) => void): Promise<boolean> | void => {
      alarmsMap.clear();
      return dual(cb, true);
    },
    onAlarm: {
      addListener: (fn: Listener<[{ name: string }]>) => {
        alarmsOnAlarmListeners.push(fn);
      },
      removeListener: (fn: Listener<[{ name: string }]>) => {
        const idx = alarmsOnAlarmListeners.indexOf(fn);
        if (idx >= 0) alarmsOnAlarmListeners.splice(idx, 1);
      },
    },
  },
  tabs: {
    create: (opts: CreateTabsProps, cb?: (tab: CreatedTab) => void): Promise<CreatedTab> | void => {
      __tabCreateCalls.push({ url: opts.url, active: opts.active });
      const id = __nextTabId++;
      const tab: TabRecord = { id, status: 'loading', url: opts.url };
      tabsMap.set(id, tab);
      const created: CreatedTab = { id, status: 'loading', url: opts.url };
      return dual(cb, created);
    },
    remove: (id: number, cb?: () => void): Promise<void> => {
      tabsMap.delete(id);
      // Production always uses Promise style: `chrome.tabs.remove(id).catch(() => {})`.
      // Return a guaranteed-resolved Promise so the .catch arm never fires.
      if (cb) cb();
      return Promise.resolve();
    },
    sendMessage: (
      id: number,
      msg: unknown,
      cb?: (response: unknown) => void,
    ): Promise<{ received: boolean }> | void => {
      __tabMessages.push({ id, msg });
      return dual(cb, { received: true });
    },
    onUpdated: {
      addListener: (fn: Listener<[number, { status?: string; url?: string }, { id: number }]>) => {
        tabsOnUpdatedListeners.push(fn);
      },
      removeListener: (fn: Listener<[number, { status?: string; url?: string }, { id: number }]>) => {
        const idx = tabsOnUpdatedListeners.indexOf(fn);
        if (idx >= 0) tabsOnUpdatedListeners.splice(idx, 1);
      },
    },
    onRemoved: {
      addListener: (fn: Listener<[number]>) => {
        tabsOnRemovedListeners.push(fn);
      },
      removeListener: (fn: Listener<[number]>) => {
        const idx = tabsOnRemovedListeners.indexOf(fn);
        if (idx >= 0) tabsOnRemovedListeners.splice(idx, 1);
      },
    },
  },
  action: {
    setBadgeText: ({ text }: { text: string }): Promise<void> => {
      __badge.text = text;
      // Production awaits — return a resolved Promise.
      return Promise.resolve();
    },
    setBadgeBackgroundColor: ({ color }: { color: string }): Promise<void> => {
      __badge.color = color;
      return Promise.resolve();
    },
  },
  notifications: {
    create: (id: string, opts: unknown): Promise<string> => {
      __notifications.set(id, opts);
      // Real chrome.notifications.create returns the id string immediately
      // (Promise resolves to it). Keep the contract identical.
      return Promise.resolve(id);
    },
  },
  scripting: {
    registerContentScripts: (scripts: unknown[]): Promise<void> => {
      __registeredScripts.push(...scripts);
      return Promise.resolve();
    },
  },
};

// Install as the global chrome BEFORE production modules read it. The storage
// package snapshots `globalThis.chrome` at module load; assigning here (during
// setupFiles execution) ensures that snapshot captures the shim.
(globalThis as unknown as { chrome: typeof chromeShim }).chrome = chromeShim;

// ─── Test-helper exports ─────────────────────────────────

/** Restore all internal state to empty defaults. Call in `beforeEach`. */
const __resetChromeShim = (): void => {
  storageMap.clear();
  sessionMap.clear();
  alarmsMap.clear();
  tabsMap.clear();
  storageOnChangedListeners.length = 0;
  sessionOnChangedListeners.length = 0;
  runtimeOnMessageListeners.length = 0;
  alarmsOnAlarmListeners.length = 0;
  tabsOnUpdatedListeners.length = 0;
  tabsOnRemovedListeners.length = 0;
  __nextTabId = 1;
  __tabCreateCalls.length = 0;
  __sentMessages.length = 0;
  __tabMessages.length = 0;
  __registeredScripts.length = 0;
  __notifications.clear();
  __badge.text = '';
  __badge.color = undefined;
  runtimeLastError = undefined;
};

/**
 * Stub `chrome.runtime.lastError` for the next synchronous chrome callback.
 * Production code reads it inside `chrome.storage.local.get` callbacks to
 * decide whether to fall through to a default. Tests pass an Error (or any
 * truthy value) to simulate a corrupt-payload read.
 */
const __setLastError = (err: unknown): void => {
  runtimeLastError = err;
};

/** Fire all `storage.local.onChanged` listeners with `changes`. */
const __emitStorageChange = (changes: { [key: string]: { oldValue?: unknown; newValue?: unknown } }): void => {
  for (const fn of [...storageOnChangedListeners]) {
    fn(changes);
  }
};

/** Fire all `tabs.onUpdated` listeners with `(id, changeInfo, {id})`. */
const __emitTabUpdated = (id: number, changeInfo: { status?: string; url?: string }): void => {
  const tab = tabsMap.get(id);
  if (tab && changeInfo.status) tab.status = changeInfo.status as 'loading' | 'complete';
  for (const fn of [...tabsOnUpdatedListeners]) {
    fn(id, changeInfo, { id });
  }
};

/** Fire all `tabs.onRemoved` listeners with `(id)`. */
const __emitTabRemoved = (id: number): void => {
  tabsMap.delete(id);
  for (const fn of [...tabsOnRemovedListeners]) {
    fn(id);
  }
};

/**
 * Fire all `runtime.onMessage` listeners with `(msg, {}, sendResponse)`.
 *
 * Iterates a COPY of the listener array so a listener that removes itself
 * (as the orchestrator's `messageListener` does via cleanup) cannot skip the
 * next listener. `sendResponse` is a no-op — the orchestrator doesn't await
 * it for inbound SCHEDULE_COMPLETE messages.
 */
const __sendRuntimeMessage = (msg: unknown): void => {
  const sendResponse = () => {
    // no-op — production SCHEDULE_COMPLETE handlers don't reply.
  };
  for (const fn of [...runtimeOnMessageListeners]) {
    fn(msg, {}, sendResponse);
  }
};

/** Fire all `alarms.onAlarm` listeners (used by index.ts poll alarm). */
const __emitAlarm = (alarm: { name: string }): void => {
  for (const fn of [...alarmsOnAlarmListeners]) {
    fn(alarm);
  }
};

export {
  chromeShim,
  __resetChromeShim,
  __setLastError,
  __emitStorageChange,
  __emitTabUpdated,
  __emitTabRemoved,
  __emitAlarm,
  __sendRuntimeMessage,
  // Exposed for tests that assert side effects directly.
  __tabCreateCalls,
  __sentMessages,
  __tabMessages,
  __registeredScripts,
  __notifications,
  __badge,
};
