# Store Assets

In-repo version control of the Chrome Web Store and Mozilla Add-ons (AMO)
listing copy, metadata, and screenshots. These files are the single source
of truth for what the stores say about the extension; the
`.github/workflows/listing-sync.yml` workflow pushes changes to the store
APIs on `main` push.

## Directory structure

```
store-assets/
  chrome/
    listing.json          # Chrome Web Store listing metadata
    listing.schema.json   # JSON Schema for chrome/listing.json
    screenshots/
      README.md           # How to add a Chrome screenshot
      .gitkeep            # Placeholder so screenshots/ is tracked empty
  firefox/
    listing.json          # AMO listing metadata
    listing.schema.json   # JSON Schema for firefox/listing.json
    screenshots/
      README.md           # How to add a Firefox screenshot
      .gitkeep            # Placeholder so screenshots/ is tracked empty
```

## How to add a screenshot

1. Drop the PNG or JPG into the relevant `screenshots/` directory
   (`store-assets/chrome/screenshots/` or `store-assets/firefox/screenshots/`).
2. Name it `screenshot-NN.png` (zero-padded; starts at `01`) - see the
   per-browser `screenshots/README.md` for the count and dimension limits.
3. Add a row to the numbered table in that `screenshots/README.md` with the
   caption and aspect ratio.
4. Commit. `listing-sync.yml` does not currently upload screenshot binaries
   via the store APIs (Phase 3.2/3.3 will tighten that); until then,
   screenshots are version-controlled in-repo for manual upload via the
   store dashboards.

## DO NOT commit secrets

Store API credentials (`CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`,
`CHROME_REFRESH_TOKEN`, `CHROME_EXTENSION_ID`, `AMO_API_KEY`,
`AMO_API_SECRET`) live in **GitHub Secrets** (repository settings). They
must never appear in this directory, in commit messages, or in any file
under `store-assets/`. The workflow YAML references them only as
`${{ secrets.* }}` expressions and is gated on their presence.

## How to update a listing

1. Edit `chrome/listing.json` and/or `firefox/listing.json`. Replace any
   `__TODO__` placeholders with real values.
2. Commit to `main`.
3. The `.github/workflows/listing-sync.yml` workflow runs on `main` push
   only when `store-assets/**` changed. It is **dark by default** - the
   repo variable `ENABLE_LISTING_SYNC` must be set to `"true"` for the job
   to actually run, and each browser sub-step is additionally gated on its
   secrets being non-empty. With those guards, the workflow is a no-op
   until secrets are injected (Phase 3.2/3.3 integration).

## Cross-reference

- **Phase 3.2 (Chrome Web Store Auto-Publish)** - handles uploading the
  built `.zip` binary to the Chrome Web Store via the publish API. That is
  a separate workflow from this listing-sync workflow.
- **Phase 3.3 (Firefox Add-ons Auto-Submit)** - handles signing and
  uploading the built `.xpi` binary to AMO via `web-ext sign`. Also a
  separate workflow.
- This Phase 3.5 workflow covers only the **listing copy/metadata**, not the
  binary upload.
