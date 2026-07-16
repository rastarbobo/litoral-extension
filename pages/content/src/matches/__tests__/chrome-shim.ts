/**
 * Minimal chrome.runtime polyfill for content-script tests.
 *
 * Background: `facebook/index.ts` and `instagram/index.ts` call
 * `chrome.runtime.onMessage.addListener(...)` and register a
 * `window.addEventListener('beforeunload', ...)` handler at module top
 * level. jsdom provides neither `chrome` nor Chrome's runtime APIs, so the
 * shim must be installed on `globalThis` *before* the script module is
 * imported.
 *
 * Scope: content scripts only touch `chrome.runtime.onMessage` and
 * `chrome.runtime.sendMessage`. Unlike the background `setup.ts` shim, this
 * one deliberately omits `chrome.tabs`, `chrome.alarms`, `chrome.storage`,
 * and `chrome.notifications` — content scripts never call them.
 *
 * The shim captures:
 *  - the `onMessage` listener the content script installs (so tests can
 *    dispatch `START_SCHEDULING` into it), and
 *  - every `sendMessage` payload the script sends back to the background
 *    (`SCHEDULE_COMPLETE` / `SCHEDULE_FAILED` / `SCHEDULING_PROGRESS`),
 *    so assertions can assert outcome and ordering.
 */

import type { CampaignPayload, ContentScriptMessage, BackgroundToContentMessage } from '@extension/shared';

/** Captured outbound message (content-script → background). */
type SentMessage = ContentScriptMessage;

/** `chrome.runtime.onMessage` listener signature (the bool return is the
 *  Chrome contract: `true` keeps the message channel open for async
 *  `sendResponse`; the scripts return `false`). */
type OnMessageListener = (
  message: BackgroundToContentMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean;

const __sent: SentMessage[] = [];
let __listener: OnMessageListener | null = null;
/** When non-null, `sendMessage` rejects with this — exercises the
 *  `sendProgress` `.catch(() => { /* no-op *\/ })` arm. */
let __sendMessageRejection: Error | null = null;

const chromeShim = {
  runtime: {
    onMessage: {
      addListener: (listener: OnMessageListener): void => {
        __listener = listener;
      },
      removeListener: (listener: OnMessageListener): void => {
        if (__listener === listener) __listener = null;
      },
      hasListener: (listener: OnMessageListener): boolean => __listener === listener,
    },
    // Both content scripts call the single-arg form and either ignore the
    // returned promise or `.catch()` it — never the callback form.
    sendMessage: (message: unknown): Promise<void> => {
      __sent.push(message as SentMessage);
      return __sendMessageRejection ? Promise.reject(__sendMessageRejection) : Promise.resolve();
    },
  },
};

// Install before any content-script module is imported. Tests must `__resetShim`
// in beforeEach AND use a fresh dynamic import per file (Vitest isolates modules
// per test file, so the top-level addListener runs once per file).
(globalThis as unknown as { chrome: typeof chromeShim }).chrome = chromeShim;

// ─── Test-only controls ──────────────────────────────────

const __resetShim = (): void => {
  __sent.length = 0;
  // Do NOT clear `__listener` here: the listener is installed once when the
  // content-script module is first imported and is tied to that module's
  // top-level closures (currentCampaignId / isUnloading). Test files reset
  // module state via `vi.resetModules()` + a fresh dynamic import; that fresh
  // import re-runs `addListener` and installs a brand-new listener, so the
  // previous `__listener` reference is naturally replaced in `beforeEach`.
  __sendMessageRejection = null;
};

/** Snapshot of all outbound messages, oldest-first. */
const __getSent = (): readonly SentMessage[] => [...__sent];

/** Most-recent outbound message of a given type, or `undefined`. */
const __getLastOfType = <T extends SentMessage['type']>(type: T): Extract<SentMessage, { type: T }> | undefined =>
  [...__sent].reverse().find((m): m is Extract<SentMessage, { type: T }> => m.type === type);

/** Force `sendMessage` to reject on the next (and every subsequent) call
 *  until cleared — used by tests asserting that `sendProgress` swallows
 *  the rejection without affecting the scheduling flow. */
const __setSendMessageRejects = (error: Error): void => {
  __sendMessageRejection = error;
};

/** Dispatch a `START_SCHEDULING` message into the installed listener.
 *  The content script kicks off its async `scheduleOnX(campaign)` and
 *  returns synchronously, so this resolves immediately — tests then flush
 *  fake timers to drive the scheduler to completion. */
const __dispatchStartScheduling = (campaign: CampaignPayload): void => {
  if (!__listener) {
    throw new Error('No chrome.runtime.onMessage listener installed — import the content script first.');
  }
  const sendResponse = (): void => {
    /* The scripts call sendResponse({ received: true }) synchronously; ignore. */
  };
  __listener(
    { type: 'START_SCHEDULING', campaign },
    { id: 'test-sender' } as chrome.runtime.MessageSender,
    sendResponse,
  );
};

/**
 * Strip every `beforeunload` listener that prior content-script imports have
 * registered on `window`.
 *
 * jsdom's `window` persists across `it` blocks within a test file, and the
 * platform scripts call `window.addEventListener('beforeunload', ...)` at
 * module top level. With `vi.resetModules()` + a fresh import per test, every
 * previous import's `beforeunload` listener stays attached — dispatching
 * `beforeunload` in an Nth test would fire N listeners, each emitting its own
 * `SCHEDULE_FAILED('tab_closed')`. This helper neutralizes that accumulation
 * by capturing listener references (via a wrapped `addEventListener`) and
 * removing them before the next test imports a fresh module.
 *
 * Idempotent: the `addEventListener` wrap is installed once per `window`
 * and accumulates refs across `beforeEach` calls; each call removes every
 * previously-captured listener before the next import registers a new one.
 * Call in `beforeEach`, BEFORE the content-script module import.
 */
const beforeUnloadListeners = new Set<EventListenerOrEventListenerObject>();
let windowWrapped = false;

const isolateWindowBeforeUnload = (windowObj: Window & typeof globalThis): void => {
  if (!windowWrapped) {
    const original = windowObj.addEventListener.bind(windowObj);
    windowObj.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: AddEventListenerOptions | boolean,
    ) => {
      if (type === 'beforeunload' && listener) beforeUnloadListeners.add(listener);
      return original(type, listener!, options as AddEventListenerOptions);
    }) as typeof windowObj.addEventListener;
    windowWrapped = true;
  }

  // Remove every listener prior imports have registered, then clear the set so
  // this import's fresh registration is the only one captured next time.
  for (const listener of beforeUnloadListeners) {
    windowObj.removeEventListener('beforeunload', listener);
  }
  beforeUnloadListeners.clear();
};

export {
  chromeShim,
  __resetShim,
  __getSent,
  __getLastOfType,
  __setSendMessageRejects,
  __dispatchStartScheduling,
  isolateWindowBeforeUnload,
};
export type { SentMessage, OnMessageListener };
