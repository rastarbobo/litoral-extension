# Litoral Agency Publisher

Cross-browser publisher extension that orchestrates Facebook, Instagram, and Google Business Profile posts against your Litoral Agency backend.

## Project motivation

The Litoral Agency Publisher extension bridges a user's browser and the Litoral Agency scheduling backend. The service worker polls the backend for queued posts, claims batches, opens publishing tabs on Facebook / Instagram / Google Business Profile, drives per-platform content-script automation, and reports success/failure telemetry back. It ships as a Chrome MV3 + Firefox WebExtension inside a pnpm + Turborepo monorepo.

## Features

- **Per-platform content scripts** for Facebook, Instagram, and Google Business Profile (Phase 1). TikTok (Phase 1.1) is pending a test account.
- **Service-worker orchestration** with poll-backoff (1→2→5→5 min capped), a circuit breaker (open / recovery / closed), and idempotent notifications (a single `litoral-connection-error` toast after 6 consecutive failures).
- **Auth** via JWT bearer token stored in `chrome.storage.sync`, so it propagates across the user's signed-in browsers.
- **Telemetry** in `chrome.storage.local`: breaker state, per-platform last-success timestamp, and retry counters.
- **Popup UI** with per-platform status badges and Retry Now / Clear Errors handlers.
- **Comprehensive tests**: Vitest unit tests co-located as `*/__tests__/*.test.ts` (orchestrator, breaker, background index, storage, DOM utils, instagram, facebook, ...), plus WebdriverIO v9.29.1 E2E (Phase 2.3, Firefox-only on CI per Q7; Chrome E2E still runs locally on headed Windows).
- **Deterministic build artifacts** at `dist-zip/extension-v${version}.{zip|xpi}`, where `${version}` is read from the root `package.json`.
- **GitHub Actions release pipeline** that auto-bumps versions, commits back, tags, builds Chrome + Firefox in a matrix, and publishes a GitHub Release on every `push: [main]`.

## Quick start

1. **Prereqs**: Node 22.15.1 (see `.nvmrc`) and pnpm (`corepack enable`).
2. **Clone + install**:
   ```bash
   git clone https://github.com/rastarbobo/litoral-extension.git
   cd litoral-extension
   pnpm install
   ```
3. **Chrome dev build**: `pnpm zip` → load the unpacked `dist/` directory via `chrome://extensions` (Developer Mode → "Load unpacked"). The zipped artifact lands at `dist-zip/extension-v*.zip`.
4. **Firefox dev build**: `pnpm zip:firefox` → "Install Add-on From File" on `about:addons` pointing at `dist-zip/extension-v*.xpi`.
5. **Production build** is currently the same artifact as the dev build (no separate `pnpm build:prod`). `release.yml` packs the same archive on `push: [main]`.

## Architecture

Monorepo managed by pnpm + Turborepo. Workspace globs (`pnpm-workspace.yaml`): `chrome-extension`, `pages/*`, `packages/*`, `tests/*`.

| Path | Purpose |
|---|---|
| `chrome-extension/` | Extension shell: service worker, manifest, build configs (`manifest.ts`, `vite.config.mts`, `vitest.config.ts`). Firefox is selected via the `CLI_CEB_FIREFOX=true` env flag, not a separate manifest file. |
| `chrome-extension/src/background/` | Orchestration: `scheduling-orchestrator.ts` (claim/telemetry), `index.ts` (poll / auth / claim pipeline), `circuit-breaker.ts` (open / recovery / closed). |
| `chrome-extension/src/background/__tests__/` | Vitest: `fetch-harness.ts` (shared `fetch` mock harness), `index.test.ts`, `scheduling-orchestrator.test.ts` (incl. error-injection cases E1–E3), `setup.ts`, plus `circuit-breaker.test.ts` and `extension-poll-storage.test.ts`. |
| `chrome-extension/public/` | `icon-34.png`, `icon-128.png`, and injected `content.css`. |
| `pages/content/` | Content scripts: per-platform matchers, DOM utils, per-platform telemetry (Facebook, Instagram, Google Business Profile). |
| `pages/popup/` | Popup UI: per-platform status badges, Retry Now / Clear Errors handlers. |
| `pages/{devtools, devtools-panel, new-tab, options, side-panel, content-ui, content-runtime}/` | Boilerplate-derived pages retained from the upstream template; some are currently unused by the publisher flow. |
| `packages/shared/` | Shared types and utilities. |
| `packages/i18n/` | Internationalization (`packages/i18n/locales/<locale>/messages.json`). |
| `packages/ui/`, `packages/tailwindcss-config/`, `packages/tsconfig/`, `packages/vite-config/`, `packages/dev-utils/`, `packages/env/`, `packages/hmr/`, `packages/storage/` | Shared build / runtime helpers carried from the template. |
| `packages/zipper/` | Archive builder producing deterministic `dist-zip/extension-v${version}.{zip|xpi}` filenames. |
| `packages/module-manager/` | Template-era enable/disable helper; not used by the publisher flow. |
| `tests/e2e/` | WebdriverIO v9.29.1 E2E specs, helpers, config. |
| `bash-scripts/` | `bump_version.sh` (Conventional-Commit semver; composes with `update_version.sh`), `update_version.sh` (argv-only 24-file version rewriter), `copy_env.sh`, `set_global_env.sh`. |
| `.github/workflows/` | GitHub Actions (see CI/CD overview below). |
| `store-assets/{chrome,firefox}/` | Phase 3.5 listing-metadata sync scaffold (JSONs + JSON Schema + screenshots). |
| `ROADMAP.md` | Phases, Q-items, and changelog — single source of truth for project status. |

## Development scripts

| Script | Purpose |
|---|---|
| `pnpm lint` | Oxlint across all workspace packages (`turbo lint --continue`). |
| `pnpm type-check` | TypeScript strict type-check across all workspaces (`turbo type-check`). |
| `pnpm test:unit` | Vitest unit tests (co-located `*.test.ts`) via `turbo test:unit`. |
| `pnpm e2e` | Build Chrome zip then run WebdriverIO E2E via `turbo e2e`. |
| `pnpm e2e:firefox` | Build Firefox xpi then run WebdriverIO E2E. |
| `pnpm zip` | Build Chrome zip → `dist-zip/extension-v*.zip`. |
| `pnpm zip:firefox` | Build Firefox xpi → `dist-zip/extension-v*.xpi`. |
| `pnpm dev` | Dev build with HMR for Chrome (`CLI_CEB_DEV=true`). |
| `pnpm dev:firefox` | Dev build with HMR for Firefox (`CLI_CEB_DEV=true CLI_CEB_FIREFOX=true`). |
| `pnpm build` | Production Chrome build (`turbo build`). |
| `pnpm build:firefox` | Production Firefox build (`CLI_CEB_FIREFOX=true`). |
| `pnpm update-version <X.Y.Z>` | Rewrite the workspace `package.json` versions argv-only via `bash-scripts/update_version.sh`. |
| `pnpm format` | Prettier across all workspaces (`turbo format`). |
| `pnpm lint:fix` | Auto-fix lint findings (`turbo lint:fix --continue`). |
| `pnpm clean` | Remove `dist` / `.turbo` / `node_modules` recursively. |

## CI/CD overview

- **Every PR** runs `lint.yml`, `build-zip.yml`, `prettier.yml`, `test-unit.yml`, and `e2e.yml`.
- **On push to `main`**: `release.yml` runs its `bump` job (derives the next version via `bump_version.sh` from the Conventional-Commit range `<last v* tag>..HEAD`, commits back to `main`, tags `vX.Y.Z`), then a matrix `build` job (Chrome + Firefox in parallel), then a `release` job publishing a GitHub Release via `softprops/action-gh-release@v2` with an idempotent tag-check.
- **On push to `main` touching `store-assets/**`**: `listing-sync.yml` is **dark-by-default** — gated on the `vars.ENABLE_LISTING_SYNC == 'true'` repo variable and per-browser store-API secret presence — until Phase 3.2 / 3.3 store-API secrets are injected.
- Additional supporting workflows: `auto-change-prs-branch.yml`, `cancel-other-workflows-on-close.yml`, `codeql.yml`, `dependencies-auto-merge.yml`, `e2e-modular.yml`, `greetings.yml`.

## Branches and releases

- Active development branch: `fix/e2e-2.3-unblock` (Phase 2 E2E and Phase 3 CI/CD work is landing here).
- Releases are GitHub Releases tagged `vX.Y.Z`, produced by `release.yml`. No store auto-publish yet — Phase 3.2 (Chrome Web Store) and Phase 3.3 (Firefox AMO) are pending store-API secrets; the Q5 deploy-mode decision is still open.

## Roadmap status

`ROADMAP.md` is the source of truth for acceptance criteria, Q-items, and changelog. Current phase status:

- Phase 1 — Foundation + per-platform popup: ✅
- Phase 2 — Content-script + scheduling + error-injection tests: ✅
- Phase 3.1 — GitHub Actions workflow: ✅
- Phase 3.2 — Chrome Web Store Auto-Publish: 🔴 pending (Q5 + 4 secrets)
- Phase 3.3 — Firefox AMO Auto-Submit: 🔴 pending (Q5 + 2 secrets)
- Phase 3.4 — Version Bumping: ✅
- Phase 3.5 — Store Listing Sync: ✅
- Phase 4.1 — README + user docs: 🚧 in progress (Phase 4.2 = AGENTS.md + README.md rewrite).
- See `ROADMAP.md` for full acceptance criteria, Q-items, and changelog.

## Contributing

- Follow **Conventional Commits** (`feat:`, `fix:`, `chore:`, `ci:`, `docs:`, `refactor:`, `test:`, `style:`, `perf:`, plus `!:` breaking marker and `BREAKING CHANGE:` footer). The `release.yml` `bump` job derives the next semver from the commit types in the range `<last v* tag>..HEAD`.
- Don't commit, push, amend, or force-push unless explicitly asked.
- See `AGENTS.md` for the orchestrator + subagent model this project uses for AI-assisted development.

## License

This repository ships with an `MIT` license file at the repo root. The existing `LICENSE` file currently carries the upstream template's copyright line (`Copyright (c) 2025 Seo Jong Hak`); confirm with the project owner before redistribution under a different holder.

## Acknowledgements

Built and maintained by the Litoral Agency team. Project bootstrapped from the `chrome-extension-boilerplate-react-vite` template; the project has since forked substantially.
