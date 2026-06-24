# Litoral Agency — Content Script Modules

This directory contains platform-specific content scripts for the Chrome Extension's native UI scheduling engine. Each platform module operates in strict isolation — changes to one platform's DOM selectors or injection flow never affect another.

## Architecture

```
pages/content/src/matches/
├── all/                # Runs on all pages (boilerplate)
├── instagram/          # Story 6.3 — Instagram Creator Studio scheduler
├── facebook/           # Story 6.3 — Meta Business Suite scheduler
├── tiktok/             # Story 6.4 — TikTok Creator Center scheduler
└── gbp/                # Story 6.4 — Google Business Profile scheduler
```

Each module:
- **Imports only** `../../shared/dom-utils` and `@extension/shared` types
- **Never imports** from another platform's directory
- **Registers** a `chrome.runtime.onMessage` listener for `START_SCHEDULING`
- **Sends** `SCHEDULE_COMPLETE` or `SCHEDULE_FAILED` via `chrome.runtime.sendMessage`
- **Uses** `aria-label` selectors (most stable across React/SPA re-renders)

## Message Contract

### Background → Content Script

```typescript
{ type: 'START_SCHEDULING', campaign: CampaignPayload }
{ type: 'CANCEL_SCHEDULING', campaignId: string }
```

### Content Script → Background

```typescript
{ type: 'SCHEDULE_COMPLETE', campaignId: string, scheduledAt: string }
{ type: 'SCHEDULE_FAILED', campaignId: string, reason: string }
{ type: 'SCHEDULING_PROGRESS', campaignId: string, step: string }
```

## dom-utils.ts API

All platform modules use the shared DOM utilities in `src/shared/dom-utils.ts`:

| Function | Purpose |
|---|---|
| `waitForElement(selector, timeoutMs)` | Poll DOM every 500ms until element appears |
| `waitForElementToDisappear(selector, timeoutMs)` | Poll until element is removed from DOM |
| `clickElement(selector)` | Click with native `.click()` + MouseEvent fallback |
| `setTextContent(selector, text)` | Set text on React-controlled inputs (native setter + events) |
| `setDateTimeInput(selector, isoString)` | Set datetime-local input value (React-safe) |
| `uploadMedia(inputSelector, assetUrl)` | Fetch file from URL + dispatch to file input via DataTransfer |
| `waitForMediaProcessing(timeoutMs)` | Wait for processing indicators to disappear |
| `delay(ms)` | Simple promise-based delay |

## Adding a New Platform Module

1. **Create** `pages/content/src/matches/{platform}/index.ts`
2. **Copy** the template from `instagram/index.ts` as a starting point
3. **Update** the `SELECTORS` object with the new platform's DOM selectors
4. **Implement** the scheduling flow following the same pattern
5. **Register** the content script in `chrome-extension/src/background/index.ts`:
   ```typescript
   {
     id: 'litoral-{platform}-scheduler',
     matches: ['https://{platform-url}/*'],
     js: ['content/{platform}.js'],
     runAt: 'document_idle',
     persistAcrossSessions: true,
   }
   ```
6. **Add** the platform to `packages/shared/lib/utils/extension-types.ts`:
   - Add to `PlatformCode` union type
   - Add to `SUPPORTED_PLATFORMS` array
7. **Add** a scheduling URL to `chrome-extension/src/background/scheduling-orchestrator.ts`:
   - Add entry to `PLATFORM_SCHEDULE_URLS`

## Updating Selectors When Platforms Change UI

1. Open the platform's scheduling page in Chrome DevTools
2. Inspect the DOM elements for the scheduling flow
3. Find the most stable `aria-label` attribute for each element
4. Update the `SELECTORS` object in the platform's `index.ts`
5. **Do NOT** touch other platform modules — they are isolated
6. Test manually by loading the extension and running a scheduling cycle

## Testing

- **Unit tests**: Test message handling and selector matching logic
- **Manual E2E**: Load extension in Chrome, mock `START_SCHEDULING` with test campaign payloads
- **Regression**: `npm run build` + `npm run test` from `litoral-extension/` root