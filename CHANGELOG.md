# Changelog

> **Provenance note:** This repository was bootstrapped from the
> [chrome-extension-boilerplate-react-vite](https://github.com/Jonghakseo/chrome-extension-boilerplate-react-vite)
> template (archived Feb 2026) and re-purposed as the Litoral Agency Publisher
> browser extension. Only Litoral-era Conventional-Commit history (from
> commit `9f8a95f chore: add repo AI tool config and AGENTS.md` onward) is
> surfaced in `## [Unreleased]` below; pre-Litoral template commits are
> omitted as they describe an unrelated product.

All notable changes to the Litoral Agency Publisher browser extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **(store-assets)** scaffold Phase 3.5 store listing sync (store-assets/ tree + dark-by-default listing-sync.yml)
- add bash-scripts/bump_version.sh conventional-commit semver bumper (Phase 3.4 toehold)
- **(content)** wire login detection + errorIndicator into instagram/facebook (4.i/4.ii)
- **(content)** add detectLogin + waitForOutcome helpers (4.i/4.ii)
- **(popup)** per-platform telemetry UI + RETRY_NOW/CLEAR_ERRORS actions (1.5)
- **(background)** circuit-breaker integration + exponential poll backoff (1.4.b/1.4.c)
- **(background)** per-platform CircuitBreaker module (1.4.b)
- **(storage)** per-platform telemetry + backoff minutes (1.4.a)
- **(content)** typed error returns + DOM utils hardening (1.3)

### Changed

- Refactor: **(zipper)** derive archive filename from package.json version for deterministic release artifacts (Phase 3.5 followup)

### Fixed

- **(orchestrator)** Q9 production-finding resolved - reorder local-state convergence before marker + detach marker via void+catch so a hung/thrown marker no longer blocks the cycle (landed with fix candidate (a) + (b) hybrid)
- **(e2e)** ship Phase 2.3 with Firefox-only CI; defer Chrome CI
- **(ci)** install matching chromedriver 137 + put on PATH ahead of system
- **(ci)** switch to setup-chrome@v2 + export CHROME_BIN from chrome-path
- **(e2e)** pass goog:chromeOptions.binary from CHROME_BIN (CI pin)
- **(ci)** pin Chrome 137 via browser-actions/setup-chrome
- **(e2e)** restore upstream base64 extension install mechanism
- **(e2e)** retry toHaveTitle for 5s on Chrome 150 headless
- **(e2e)** maxInstances=1 in CI to avoid shared --user-data-dir contention
- **(ci)** trim pnpm.overrides to @puppeteer/browsers only
- **(ci)** switch e2e workflows to pull_request so checkout uses PR head
- **(e2e)** unblock Phase 2.3 — Chrome 150+ MV3 extension loading
- **(content)** gate success path on isUnloading before sending SCHEDULE_COMPLETE
- **(build)** skip non-entry items under content-script matches/
- **(background)** preserve consecutiveFailures on stale breaker auto-close
- **(background)** drop undefined __API_BASE_URL reference and remove typing-rejected alarms option

## [0.6.3] - 2026-07-18

### Fixed

- **(scripts)** anchor update_version.sh's perl regex to the "version" field so dependency specifiers are not corrupted by partial-version matches
- **(ci)** let release.yml's changelog job handle detached HEAD via `git checkout -B main` before pull/push

