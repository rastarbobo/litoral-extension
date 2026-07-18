# Litoral Agency Publisher — Operator Docs

This `docs/` directory holds the operator-facing specifics that the top-level
`README.md` intentionally kept short: a step-by-step deployment runbook for
shipping the extension to the Chrome Web Store and AMO, an onboarding guide
for a new engineer joining the project, a step-by-step guide for adding a new
social platform to the scheduler, and a short troubleshooting FAQ. The
README still owns the canonical architecture overview, quick-start, and
development-scripts table; the files here fill out the specifics that a
maintainer-on-duty needs but that a first-time reader does not.

| Document | Purpose |
|---|---|
| [`DEPLOYMENT.md`](./DEPLOYMENT.md) | Step-by-step runbook for building, verifying, and shipping the extension to the Chrome Web Store and Firefox AMO. Honest about what is currently manual vs. what `release.yml` + `listing-sync.yml` will do once Phase 3.2 / 3.3 secrets land (Q5 still open). |
| [`STORE_PUBLISH_RUNBOOK.md`](./STORE_PUBLISH_RUNBOOK.md) | Step-by-step cred-provisioning runbook for flipping the dark-by-default `ENABLE_STORE_PUBLISH` switch on a fresh fork: registering a Google Cloud OAuth client for the Chrome Web Store Publish API, looking up the AMO JWT issuer/key pair, deciding Q5 (draft vs public publish), dry-run verification via `workflow_dispatch`, and rollback. The workflow scaffolds at `.github/workflows/publish-{chrome,amo}.yml` already exist dark-by-default; this runbook is the operator-action-side companion. |
| [`ONBOARDING.md`](./ONBOARDING.md) | Walkthrough for a new engineer: repo layout, local setup, first-time build + load as an unpacked extension, recommended reading order for the code, conventions, testing, and common pitfalls. |
| [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) | Short FAQ covering auth-required popups, stuck red `!` badge, campaigns stuck in the pending queue, content-script timeouts, the Q9 marker-detach behavior, Firefox-vs-Chrome manifest differences, the 100% orchestrator+breaker coverage gate, and `release.yml` no-op re-runs. |
| [`PLATFORM_ONBOARDING.md`](./PLATFORM_ONBOARDING.md) | Step-by-step guide for adding a new social platform to the extension: the seven plumbing touch-points (`PlatformCode`, `SUPPORTED_PLATFORMS`, `PLATFORM_NAMES`, `PLATFORM_SCHEDULE_URLS`, the storage-package local redeclaration pair, `registerContentScripts`, content-script file), the message protocol, growing a stub into a real implementation against the shared `dom-utils.ts` helpers, the three-tier testing strategy (stub contract test, content-script unit tests mirroring the Instagram 8-test pattern, background-side `T18` registration order update), manual end-to-end verification, and common pitfalls. |

For AI-assistant conventions (orchestrator + subagent model, coding rules,
storage surface, external-backend honesty), see [`AGENTS.md`](../AGENTS.md).
For project phases, Q-items, and the changelog, see
[`ROADMAP.md`](../ROADMAP.md).
