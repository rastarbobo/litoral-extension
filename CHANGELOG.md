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


## [0.6.3] - 2026-07-18

### Fixed

- **(scripts)** anchor update_version.sh's perl regex to the "version" field so dependency specifiers are not corrupted by partial-version matches
- **(ci)** let release.yml's changelog job handle detached HEAD via `git checkout -B main` before pull/push

