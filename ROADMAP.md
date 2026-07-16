# Litoral Extension — Development & Deployment Roadmap

> **Last Updated:** July 16, 2026  
> **Status:** 🚧 In Progress (Phase 2 — Testing & Reliability (2.1 done, 2.2-2.4 pending))  
> **Next Milestone:** Complete Phase 2.2 (Mocked Platform Tests)  

---

## 📖 Table of Contents

- [Project Overview](#project-overview)
- [Architecture Summary](#architecture-summary)
- [Phase Roadmap](#phase-roadmap)
  - [Phase 1: Polish Existing Features](#phase-1-polish-existing-features)
  - [Phase 2: Testing & Reliability](#phase-2-testing--reliability)
  - [Phase 3: CI/CD & Automated Deployment](#phase-3-cicd--automated-deployment)
  - [Phase 4: Documentation & Final Polish](#phase-4-documentation--final-polish)
- [Development System](#development-system)
  - [Branch Strategy](#branch-str.md#branch-strategy)
  - [Commit Convention](#commit-convention)
  - [Deployment Pipeline](#deployment-pipeline)
  - [Environment & Secrets](#environment--secrets)
- [Platform Integration Checklist](#platform-integration-checklist)
- [Definition of Done](#definition-of-done)
- [Open Questions & Decisions](#open-questions--decisions)

---

## 📋 Project Overview

**Project Name:** Litoral Agency Publisher  
**Type:** Chrome Extension (Manifest V3) / Firefox Add-on  
**Purpose:** Publishes approved campaigns to social media platforms from the user's own browser.

### Core Functionality
- The extension acts as a **thin client** that polls the Litoral API for approved campaigns.
- Campaigns are claimed from a queue and scheduled on social platforms by directly manipulating each platform's native web UI via content scripts.
- Supported platforms: **Facebook**, **Instagram**, **TikTok** (stub), **Google Business Profile** (stub).

### Tech Stack
| Technology | Purpose |
|------------|---------|
| React 19.1.0 | UI framework for all extension pages |
| TypeScript 5.8.3 | Type safety |
| Vite 6.3.6 | Build tool per package/page |
| Tailwind CSS 3.4.17 | Styling |
| Turborepo | Monorepo task orchestration |
| pnpm 10.11.0 | Package manager |
| Chrome Extension Manifest V3 | Extension format |

---

## 🏗️ Architecture Summary

```
litoral-extension/
├── chrome-extension/          # Manifest, background service worker, icons
│   ├── manifest.ts
│   └── src/background/
│       ├── index.ts                    # Polling, badge, auth
│       └── scheduling-orchestrator.ts  # Campaign execution engine
├── pages/                     # Extension UI and content scripts
│   ├── popup/                 # Main extension popup
│   ├── options/               # Settings page
│   ├── new-tab/               # Custom new tab page
│   ├── side-panel/            # Chrome side panel
│   ├── devtools/              # Chrome DevTools integration
│   ├── devtools-panel/        # DevTools panel UI
│   ├── content/               # Injected content scripts (per platform)
│   ├── content-ui/            # Injected UI overlays
│   └── content-runtime/       # Runtime content scripts
├── packages/                  # Shared monorepo packages
│   ├── shared/                # Types, helpers, hooks
│   ├── storage/               # Chrome storage abstraction
│   ├── dev-utils/             # Manifest parser, logger
│   ├── env/                   # Environment variables
│   ├── hmr/                   # Hot module replacement
│   ├── i18n/                  # Internationalization
│   ├── ui/                    # Shared UI components
│   ├── tailwindcss-config/    # Shared Tailwind config
│   ├── tsconfig/              # Shared TypeScript config
│   ├── vite-config/           # Shared Vite config
│   └── zipper/                # Build artifact zipping
└── tests/                     # E2E tests
```

### Key Architectural Patterns
1. **Monorepo** — Separate packages for shared logic, storage, UI, and per-page entry points.
2. **Dynamic Content Script Registration** — Content scripts are registered via `chrome.scripting.registerContentScripts()` at runtime, avoiding a `host_permissions` manifest allowlist.
3. **Message Passing** — Extensive use of `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` for cross-context communication.
4. **JSend API Standard** — API responses wrapped in `{ status: 'success', data: T }` or `{ status: 'error', message: string }`.
5. **Rate Limiting & Safety** — Max 2 campaigns per 90-second cycle, alarms prevent overlapping polls.
6. **Error Resilience** — 401 handling clears tokens, 6 consecutive failures trigger a system notification.

---

## 🗺️ Phase Roadmap

### **Phase 1: Polish Existing Features** 🚧 *In Progress — 1.3/1.4/1.5 + gap fixes done; 1.1/1.2 pending*
> **Objective:** Complete TikTok & GBP stubs, improve stability.
> **Timeline:** Week 1

| # | Task | Status | Details | Acceptance Criteria |
|---|------|--------|---------|---------------------|
| 1.1 | **TikTok Content Script** | 🔴 Not Started | Implement `pages/content/src/matches/tiktok/index.ts` — navigate TikTok Studio/Creator Portal, upload media, set caption, schedule post | - Can log into TikTok Studio  <br>- Uploads image/video media  <br>- Sets caption text  <br>- Clicks schedule button  <br>- Reports success/failure to background |
| 1.2 | **Google Business Profile Content Script** | 🔴 Not Started | Implement `pages/content/src/matches/gbp/index.ts` — navigate Google Business Profile manager, create post with media, set schedule | - Can navigate to GBP Posts  <br>- Uploads media  <br>- Sets post text  <br>- Schedules post  <br>- Reports success/failure |
| 1.3 | **Shared DOM Utils Hardening** | ✅ Done | Add retry logic, wait-for-network-idle, and better selectors for React-controlled inputs | - `waitForElement` has configurable retries  <br>- `setDateTimeInput` handles more React edge cases  <br>- `uploadMedia` waits for processing spinner  <br>- All utilities have typed error returns |
| 1.4 | **Error Resilience** | ✅ Done | Add exponential backoff for API polling, circuit breaker for platform failures, detailed error telemetry | - Polling backoff: 1min → 2min → 5min after consecutive failures  <br>- Circuit breaker: skip a platform after 3 consecutive failures  <br>- Errors stored in extension storage with timestamps  <br>- Popup shows last error per platform |
| 1.5 | **Popup UI Improvements** | ✅ Done | Show per-platform status, last success/failure per platform, manual retry buttons | - Popup lists all platforms with status icons  <br>- Shows last successful schedule time per platform  <br>- Shows last error per platform (expandable)  <br>- "Retry Now" button to force re-poll  <br>- "Clear Errors" button |

> **Phase 1 gap fixes (login detection + errorIndicator wiring)** also completed — see changelog `2026-07-13`.

---

### **Phase 2: Testing & Reliability** ⏳ *Pending*
> **Objective:** Ensure the scheduling engine is rock-solid before shipping.
> **Timeline:** Week 1–2 (overlaps with Phase 1)

| # | Task | Status | Details | Acceptance Criteria |
|---|------|--------|---------|---------------------|
| 2.1 | **Unit Tests for Scheduler** | ✅ Done | Test `scheduling-orchestrator.ts` logic (rate limiting, timeout, retry) | - Tests exist in `chrome-extension/src/background/__tests__/`  <br>- 100% branch coverage on rate limiting  <br>- Timeout tested with fake timers  <br>- Retry logic tested |
| 2.2 | **Mocked Platform Tests** | 🔴 Not Started | Create Playwright/Puppeteer mocks for Facebook/Instagram/TikTok/GBP DOM interactions | - Mock HTML pages for each platform's scheduler UI  <br>- Content scripts run against mocks  <br>- Assertions verify correct DOM mutations  <br>- Tests run in CI |
| 2.3 | **E2E Flow Tests** | 🔴 Not Started | End-to-end test: claim campaign → inject content script → verify platform page navigation | - Uses existing WebdriverIO e2e setup  <br>- Full flow: background poll → claim → orchestrator → content script  <br>- Assertions on badge text and storage state  <br>- Runs in CI |
| 2.4 | **Error Injection Tests** | 🔴 Not Started | Simulate API failures, network drops, and platform UI changes | - Mock API returns 500/401/timeout  <br- Simulate network offline  <br>- Simulate DOM changes (missing buttons)  <br>- Verify graceful degradation |

---

### **Phase 3: CI/CD & Automated Deployment** ⏳ *Pending*
> **Objective:** Fully automated build, zip, and store submission pipeline.
> **Timeline:** Week 2

| # | Task | Status | Details | Acceptance Criteria |
|---|------|--------|---------|---------------------|
| 3.1 | **GitHub Actions Workflow** | 🔴 Not Started | Build on push to `main`, run tests, produce signed zips for Chrome & Firefox | - `.github/workflows/build-zip.yml` updated  <br>- `.github/workflows/release.yml` created  <br>- Builds run on every PR  <br>- Zips uploaded as artifacts |
| 3.2 | **Chrome Web Store Auto-Publish** | 🔴 Not Started | Automated upload via Chrome Web Store Publish API | - OAuth credentials stored in GitHub Secrets  <br>- `webstore-upload` or custom script uploads zip  <br>- Uploads to "draft" or "publish" depending on branch  <br>- Runs only on `main` push |
| 3.3 | **Firefox Add-ons Auto-Submit** | 🔴 Not Started | Automated upload via `web-ext` or AMO API | - AMO API keys in GitHub Secrets  <br>- `web-ext sign` or `web-ext submit` in workflow  <br>- Handles both listed and unlisted versions |
| 3.4 | **Version Bumping** | 🔴 Not Started | Auto-increment version in `manifest.json` and `package.json` on deploy | - Script reads current version  <br>- Bumps patch/minor/major based on commit type  <br>- Updates all relevant files  <br>- Commits back to repo |
| 3.5 | **Store Listing Sync** | 🔴 Not Started | Keep store descriptions, screenshots, and metadata in repo for version control | - `store-assets/` directory created  <br>- Chrome & Firefox listings680metadata in JSON/markdown  <br>- Screenshots committed to repo  <br>- Workflow can update store listings via API |

---

### **Phase 4: Documentation & Final Polish** ⏳ *Pending*
> **Objective:** Make the project maintainable and onboarding-friendly.
> **Timeline:** Week 3

| # | Task | Status | Details | Acceptance Criteria |
|---|------|--------|---------|---------------------|
| 4.1 | **README Update** | 🔴 Not Started | Document architecture, local dev, testing, and deployment procedures | - Architecture diagram or description  <br>- Setup instructions  <br>- Testing commands  <br>- Deployment process |
| 4.2 | **AGENTS.md Update** | 🔴 Not Started | Update with project-specific conventions, API endpoints, and platform quirks | - API endpoint documentation  <br>- Platform-specific DOM quirks  <br>- Commit and branch conventions  <br>- Troubleshooting guide |
| 4.3 | **Changelog** | 🔴 Not Started | Set up `CHANGELOG.md` with conventional commits | - `CHANGELOG.md` at root  <br>- Auto-generated from conventional commits  <br>- Follows Keep a Changelog format |
| 4.4 | **Platform Onboarding Guide** | 🔴 Not Started | How to add a new platform to the extension | - Step-by-step guide  <br>- Code templates  <br>- Testing checklist |

---

## 🔧 Development System

### Branch Strategy
```
main          ← Production-ready, auto-deploys to stores
  └── dev     ← Integration branch for features
        └── feature/tiktok-scheduling
        └── feature/gbp-scheduling
        └── feature/error-telemetry
```

### Commit Convention
We use **Conventional Commits** to enable auto-changelog generation:

```
feat(tiktok): implement media upload in TikTok Studio
fix(scheduler): increase timeout for slow platform pages
docs(readme): update deployment instructions
chore(deps): upgrade vite to 6.4.0
test(e2e): add error injection tests
```

### Deployment Pipeline (Auto)
On every push to `main`:

1. **Build** — `pnpm build` (Chrome) + `pnpm build:firefox`
2. **Test** — `pnpm test:unit` + `pnpm test:e2e`
3. **Version** — Bump `manifest.json` version via `pnpm update-version`
4. **Package** — `pnpm zip` + `pnpm zip:firefox`
5. **Deploy** — Upload to Chrome Web Store + Firefox Add-ons (using stored API keys)
6. **Tag** — Git tag `v{version}` and release notes

### Environment & Secrets
| Secret | Purpose | Storage |
|---|---|---|
| `CHROME_CLIENT_ID` | Chrome Web Store OAuth | GitHub Secrets |
| `CHROME_CLIENT_SECRET` | Chrome Web Store OAuth | GitHub Secrets |
| `CHROME_REFRESH_TOKEN` | Chrome Web Store OAuth | GitHub Secrets |
| `CHROME_EXTENSION_ID` | Chrome extension ID | GitHub Secrets |
| `AMO_API_KEY` | Firefox Add-ons JWT issuer | GitHub Secrets |
| `AMO_API_SECRET` | Firefox Add-ons JWT secret | GitHub Secrets |

---

## ✅ Platform Integration Checklist

Use this checklist when adding or polishing a platform integration.

- [ ] **Login Detection** — Can the content script detect if the user is logged into the platform?
- [ ] **Navigation** — Can the script navigate to the post creation / scheduling page?
- [ ] **Media Upload** — Can the script upload images/videos to the platform's composer?
- [ ] **Caption/Text** — Can the script fill in the post caption or description?
- [ ] **Date/Time** — Can the script set the scheduled date and time?
- [ ] **Schedule/Submit** — Can the script click the final "Schedule" or "Post" button?
- [ ] **Success Detection** — Can the script detect a successful post (URL change, confirmation message)?
- [ ] **Error Handling** — Does the script report failures (DOM not found, upload error, login expired) to the background?
- [ ] **Rate Limiting** — Does the script respect the global 90-second delay between platforms?
- [ ] **Cleanup** — Does the script clean up any injected UI or event listeners?

### Current Platform Status

| Platform | Status | Notes |
|----------|--------|-------|
| Facebook | ✅ Functional | Business Suite composer |
| Instagram | ✅ Functional | Creator Studio scheduler |
| TikTok | 🔴 Stub | Implementation pending |
| Google Business Profile | 🔴 Stub | Implementation pending |

---

## 🏁 Definition of Done

A task is considered **Done** when:

1. **Code is written and reviewed** — Follows existing patterns, no lint errors, TypeScript compiles.
2. **Tests pass** — Unit tests and/or E2E tests cover the new functionality.
3. **Manual QA passed** — Tested against the real platform (TikTok/GBP account required).
4. **Documentation updated** — Relevant sections in this roadmap, README, and AGENTS.md updated.
5. **CI passes** — GitHub Actions build and test workflow is green.

---

## ❓ Open Questions & Decisions

> Use this section to track decisions that need owner input or answers to open questions.

| # | Question | Status | Answer / Decision |
|---|----------|--------|-------------------|
| Q1 | Do we have a TikTok Business/Creator account for testing? | 🔴 Open | — |
| Q2 | Is GBP for "Google Business Profile posts" or "Google Posts via Search/Maps"? | 🔴 Open | — |
| Q3 | Is `https://litoral.agency/api/extension/queue` the final production endpoint or is there a staging env? | 🔴 Open | — |
| Q4 | Do we want error telemetry (Sentry, LogRocket) or just console/storage logging? | 🔴 Open | — |
| Q5 | Should the deployment pipeline deploy to draft or directly publish on the stores? | 🔴 Open | — |
| Q6 | Do we need to support mobile browser extension (Kiwi, Firefox Mobile)? | 🔴 Open | — |

---

## 📝 Changelog (Roadmap Updates)

| Date | Change |
|------|--------|
| 2026-06-26 | Initial roadmap document created. Status: Phase 1 in progress. |
| 2026-07-13 | Added execution plan ROADMAP_STEP.md; sub-tasks 1.3, 1.4, 1.5 and gap fixes moving out of Not Started. |
| 2026-07-13 | Phase 1 foundation landed: 1.3 (DOM utils hardening — typed errors, retries, React edges, processing-wait), 1.4 (per-platform telemetry, circuit breaker, exponential poll backoff), 1.5 (per-platform popup UI + Retry Now / Clear Errors handlers), and gap fixes 4.i/4.ii (login detection + errorIndicator wiring) on Facebook + Instagram. Vitest infrastructure added to `pages/content` and `chrome-extension`; 35 unit tests passing (10 content + 25 background). Type-check and lint green. |
| 2026-07-16 | Phase 2.1 complete: 50 unit tests in `chrome-extension/src/background/__tests__/` (33 orchestrator + 9 circuit-breaker + 8 storage, up from 25). 100% branch/line/function/statement coverage on `scheduling-orchestrator.ts` and `circuit-breaker.ts`, gated via `chrome-extension/vitest.config.ts` `coverage.thresholds`. Added `@vitest/coverage-v8`; extended the chrome shim with `__setNextTabCreateFails` / `__setNextTabsSendMessageThrows` failure-injection helpers; added `/* c8 ignore start/stop */` around intentionally-unreachable defensive branches (defensive `?? 'unknown'` and `error instanceof Error ? ... : error` else arm in the orchestrator catch; `waitForTabLoad`'s `if (resolved) return` re-entrance guard; the `typeof chrome === 'undefined'` SSR guards in circuit-breaker). Repo-wide lint and type-check green; `pnpm run test:unit` = 60 tests across 2 packages. |

---

*This document is a living document. Update it as tasks are completed, decisions are made, or new phases are added.*
