# Litoral Agency Publisher — Operator Docs

This `docs/` directory holds the operator-facing specifics that the top-level
`README.md` intentionally kept short: a step-by-step deployment runbook for
shipping the extension to the Chrome Web Store and AMO, an onboarding guide
for a new engineer joining the project, and a short troubleshooting FAQ. The
README still owns the canonical architecture overview, quick-start, and
development-scripts table; the files here fill out the specifics that a
maintainer-on-duty needs but that a first-time reader does not.

| Document | Purpose |
|---|---|
| [`DEPLOYMENT.md`](./DEPLOYMENT.md) | Step-by-step runbook for building, verifying, and shipping the extension to the Chrome Web Store and Firefox AMO. Honest about what is currently manual vs. what `release.yml` + `listing-sync.yml` will do once Phase 3.2 / 3.3 secrets land (Q5 still open). |
| [`ONBOARDING.md`](./ONBOARDING.md) | Walkthrough for a new engineer: repo layout, local setup, first-time build + load as an unpacked extension, recommended reading order for the code, conventions, testing, and common pitfalls. |
| [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) | Short FAQ covering auth-required popups, stuck red `!` badge, campaigns stuck in the pending queue, content-script timeouts, the Q9 marker-detach behavior, Firefox-vs-Chrome manifest differences, the 100% orchestrator+breaker coverage gate, and `release.yml` no-op re-runs. |

For AI-assistant conventions (orchestrator + subagent model, coding rules,
storage surface, external-backend honesty), see [`AGENTS.md`](../AGENTS.md).
For project phases, Q-items, and the changelog, see
[`ROADMAP.md`](../ROADMAP.md).
