#!/usr/bin/env bash
# generate_changelog.sh — append or refresh a Keep a Changelog 1.1.0 entry
# in CHANGELOG.md from Conventional-Commit subjects in a given git range.
#
# Usage:
#   ./generate_changelog.sh                       # use range <last v* tag | root commit>..HEAD
#                                                #   and version = package.json#version
#   ./generate_changelog.sh --dry-run             # print what would happen; do NOT touch CHANGELOG.md
#   ./generate_changelog.sh --version Unreleased # use "## [Unreleased]" header (no date)
#   ./generate_changelog.sh --from-ref <ref>      # override range start (exclusive)
#   ./generate_changelog.sh --to-ref <ref>        # override range end (inclusive of tip)
#   ./generate_changelog.sh --changelog <path>    # override CHANGELOG.md path
#   ./generate_changelog.sh -h | --help           # print help and exit 0
#
# Conventional-Commit type -> Keep a Changelog section mapping:
#   feat:                 -> ### Added
#   fix:                  -> ### Fixed
#   perf:                 -> ### Changed   (sub-bullet: "Performance: ...")
#   refactor:             -> ### Changed   (sub-bullet: "Refactor: ...")
#   build(deps):          -> ### Changed   (sub-bullet: "Dependencies: ...")
#   build(deps-dev):      -> ### Changed   (sub-bullet: "Dependencies: ...")
#   build(other scopes):  -> omitted       (developer hygiene; not user-facing)
#   <type>!:              -> ### BREAKING CHANGES (above Added) + ### Changed
#   BREAKING CHANGE:       -> ### BREAKING CHANGES (above Added) + ### Changed
#   Revert "..."          -> ### Reverts
#   chore/docs/ci/test/style/debug: -> omitted (developer hygiene)
#
# When multiple sections are non-empty they are emitted in this order:
#   ### BREAKING CHANGES -> ### Added -> ### Changed -> ### Fixed -> ### Reverts
# Empty sections are omitted entirely (no header-with-no-bullets).
#
# Idempotency: when a "## [${version}]" section already exists in CHANGELOG.md
# its body is REPLACED in-place with the freshly generated content. Sections
# for other versions are left untouched. When "## [Unreleased]" is requested
# it is always inserted immediately below the preamble (Keep a Changelog
# convention: Unreleased sits on top). For real versions the new section is
# inserted BELOW any "## [Unreleased]" and ABOVE any existing older
# "## [version]" sections (newest release on top).
#
# Exit codes:
#   0  success
#   1  generic error (bad args, git failure, file write failure)
#   2  root marker not found (no pnpm-workspace.yaml reachable)
#   3  git command failure (bad ref, etc.)
#   4  read/write error on the changelog file
#
# Composition note:
#   Companion to bash-scripts/bump_version.sh (semver derivation) and
#   bash-scripts/update_version.sh (version-string rewriter). The three form
#   the release toolchain: bump_version.sh computes the next version,
#   update_version.sh rewrites package.json files, and THIS script produces
#   the human-readable CHANGELOG.md entry from the same git range. They share
#   the same Conventional-Commit regex library and the same range-resolution
#   logic so the published changelog always reflects the commits that drove
#   the version bump.

set -euo pipefail

# --- Locate repo root via git so we always read the ROOT package.json and
# write root CHANGELOG.md, regardless of the caller's CWD (CI, Git Bash, etc.).
# Mirrors bump_version.sh's approach exactly.
repo_root="$(git rev-parse --show-toplevel)"
root_package_json="${repo_root}/package.json"

# --- Argument defaults
dry_run=0
from_ref=""
to_ref="HEAD"
version_arg=""
changelog_path="${repo_root}/CHANGELOG.md"

# --- print_help: heredoc with a stable usage block. Mirrors bump_version.sh.
print_help() {
  cat <<'EOF'
generate_changelog.sh — append/refresh a Keep a Changelog 1.1.0 entry in CHANGELOG.md.

Usage:
  bash generate_changelog.sh [--dry-run] [--version <ver>] [--from-ref <ref>]
                              [--to-ref <ref>] [--changelog <path>] [-h|--help]

Options:
  --dry-run              Print the resolved inputs + the new section body to
                         stdout WITHOUT modifying CHANGELOG.md.
  --version <ver>        Version string for the new "## [${ver}] - YYYY-MM-DD"
                         header. Default: read from root package.json#version.
                         Special value "Unreleased" -> "## [Unreleased]" with
                         no date and always inserted at the top (Keep a
                         Changelog convention).
  --from-ref <ref>       Git ref starting the range (exclusive).
                         Default: most recent tag matching v* reachable from HEAD.
                         Fallback if no v* tag exists: the repository root commit.
  --to-ref <ref>         Git ref ending the range (inclusive of the tip's message).
                         Default: HEAD.
  --changelog <path>     Path to the changelog file.
                         Default: <repo_root>/CHANGELOG.md.
  -h, --help             Show this help and exit 0.

Conventional-Commit type -> Keep a Changelog section mapping:
  feat:                 -> ### Added
  fix:                  -> ### Fixed
  perf:                 -> ### Changed (sub-bullet: "Performance: ...")
  refactor:             -> ### Changed (sub-bullet: "Refactor: ...")
  build(deps):           -> ### Changed (sub-bullet: "Dependencies: ...")
  build(deps-dev):       -> ### Changed (sub-bullet: "Dependencies: ...")
  <type>!:              -> ### BREAKING CHANGES + ### Changed
  BREAKING CHANGE:       -> ### BREAKING CHANGES + ### Changed
  Revert "..."          -> ### Reverts
  chore/docs/ci/test/style/debug: -> omitted (developer hygiene)

Section order in the generated block:
  ### BREAKING CHANGES -> ### Added -> ### Changed -> ### Fixed -> ### Reverts
Empty sections are omitted entirely (no header-with-no-bullets).

Exit codes:
  0  success
  1  generic error (bad args, git failure, file write failure)
  2  root marker not found
  3  git command failure (bad ref)
  4  read/write error on the changelog file

Composition note:
  Companion to bump_version.sh (semver derivation) and update_version.sh
  (version-string rewriter). The three form the release toolchain.
EOF
}

# --- die <msg> <exit_code>: uniform error+exit helper.
die() {
  printf 'error: %s\n' "$1" >&2
  exit "$2"
}

# --- Parse argv. Stay portable across Git Bash / MSYS and Linux ubuntu-latest
# runners without locale surprises (same approach as bump_version.sh).
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --version)
      [[ $# -lt 2 ]] && die "--version requires a value" 1
      version_arg="$2"
      shift 2
      ;;
    --from-ref)
      [[ $# -lt 2 ]] && die "--from-ref requires a value" 1
      from_ref="$2"
      shift 2
      ;;
    --to-ref)
      [[ $# -lt 2 ]] && die "--to-ref requires a value" 1
      to_ref="$2"
      shift 2
      ;;
    --changelog)
      [[ $# -lt 2 ]] && die "--changelog requires a value" 1
      changelog_path="$2"
      shift 2
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      die "unknown argument: $1" 1
      ;;
  esac
done

# --- Resolve the start of the range (from_ref).
# Default: most recent v* tag reachable from HEAD. We use git describe so a
# missing tag is reported via exit status rather than crashing under set -e.
# Mirrors bump_version.sh lines 122-140 exactly so the changelog range always
# matches the semver-bump range.
if [[ -z "$from_ref" ]]; then
  if from_ref="$(git describe --tags --abbrev=0 --match 'v*' HEAD 2>/dev/null)"; then
    : # found a v* tag; use it
  else
    # No v* tag exists yet (common in fresh repos / pre-release phase).
    # Fall back to the root commit so we scan every commit ever made.
    from_ref="$(git rev-list --max-parents=0 HEAD | tail -n 1)"
    [[ -z "$from_ref" ]] && die "could not determine a start ref (no v* tag and no root commit)" 3
  fi
fi

# --- Validate refs resolve before we use them in a range. Failing fast here
# produces a clearer error than letting git log choke under set -e.
git rev-parse --verify --quiet "$from_ref" >/dev/null || die "--from-ref does not resolve to a valid ref: $from_ref" 3
git rev-parse --verify --quiet "$to_ref"   >/dev/null || die "--to-ref does not resolve to a valid ref: $to_ref" 3

# --- Resolve the section version. Default: read root package.json#version via
# node -p (faithful JSON parse); fall back to a grep/sed parse so the script
# still works on minimal CI images that lack node in PATH. Mirrors
# bump_version.sh lines 153-167.
if [[ -z "$version_arg" ]]; then
  if command -v node >/dev/null 2>&1; then
    version_arg="$(node -p "require('${root_package_json}').version")"
  else
    version_arg="$(grep -o '"version": "[^"]*"' "$root_package_json" | head -n 1 | sed -E 's/"version": "([^"]*)"/\1/')"
  fi
  [[ -z "$version_arg" ]] && die "could not read version from $root_package_json and --version was not provided" 1
fi

# Resolve the section date: ISO YYYY-MM-DD today, except for "Unreleased"
# which per Keep a Changelog convention carries no date.
section_date=""
if [[ "$version_arg" != "Unreleased" ]]; then
  section_date="$(date +%Y-%m-%d)"
fi

# --- Collect commit subjects AND bodies for the range.
# We need bodies too because the BREAKING CHANGE: marker lives in the footer
# of a commit body, not in the subject line. %H is the full SHA (rarely used
# here but cheap to capture; future tooling may want it). %s is the subject,
# %b is the body. We delimit commits with a "---END---" sentinel so we can
# parse the mapfile robustly even when bodies span multiple lines. The range
# is from_ref..to_ref (exclusive of from_ref, inclusive of to_ref) — same
# semantic as bump_version.sh and the downstream release-notes consumer.
commit_raw="$(git log --format='%H%n%s%n%b%n---END---' --no-merges "${from_ref}..${to_ref}")"
commit_count="$(printf '%s\n' "$commit_raw" | grep -c '^---END---$' || true)"
# grep returns exit 1 if zero matches; we want to treat zero as a soft-empty
# range (mirror bump_version.sh's no-bumpable-commits path).
if [[ "$commit_count" -eq 0 ]]; then
  printf 'No commits found in range %s..%s; nothing to do.\n' "$from_ref" "$to_ref"
  exit 0
fi

# --- Buckets: arrays of bullet lines per Keep a Changelog section.
# We use bash arrays; missing entries default to empty arrays via the
# "ary=()" idiom and "${ary[@]}" expands harmlessly when empty under
# `set -u` if we use the `${ary[@]+"${ary[@]}"}` defensive form.
breaking_bullets=()
added_bullets=()
changed_bullets=()
fixed_bullets=()
reverts_bullets=()
other_count=0

# --- Regex library, identical to bump_version.sh lines 209-243 plus the
# build/revert variants this script needs.
breaking_subject_re='^[a-z]+(\([a-z0-9._-]+\))?!:'
breaking_footer_marker='BREAKING CHANGE:'
feat_re='^feat(\([a-z0-9._-]+\))?:'
fix_re='^fix(\([a-z0-9._-]+\))?:'
perf_re='^perf(\([a-z0-9._-]+\))?:'
refactor_re='^refactor(\([a-z0-9._-]+\))?:'
build_deps_re='^build\(deps(\-dev)?\):'
build_other_re='^build(\([a-z0-9._-]+\))?:'

# --- strip_prefix <subject>: remove the conventional type+scope+colon prefix
# and return the human-readable summary. When a scope is present it is
# preserved as a bolded (scope) tag at the start of the returned string;
# when absent the bare summary is returned. Examples:
#   "feat(background): foo"  -> "**(background)** foo"
#   "feat: foo"               -> "foo"
#   "fix(e2e)!: bar"          -> "**(e2e)** bar"
strip_prefix() {
  local subj="$1"
  # Match a leading type, optional (scope), optional "!", then ": ".
  # We use [[ =~ ]] capturing groups in BASH_REMATCH.
  if [[ "$subj" =~ ^[a-z]+(\(([a-z0-9._-]+)\))?(!)?:[[:space:]]+(.*)$ ]]; then
    local scope="${BASH_REMATCH[2]}"
    local summary="${BASH_REMATCH[4]}"
    if [[ -n "$scope" ]]; then
      printf '**(%s)** %s' "$scope" "$summary"
    else
      printf '%s' "$summary"
    fi
  else
    # Not a conventional subject (should not happen here because we only call
    # strip_prefix after matching one of the type regexes); return as-is.
    printf '%s' "$subj"
  fi
}

# --- extract_breaking_body <body>: return the text after the
# "BREAKING CHANGE:" footer marker, trimmed of leading whitespace. If the
# marker is absent or has no trailing text, returns the empty string.
extract_breaking_body() {
  local body="$1"
  local after
  # Use parameter expansion to slice from the marker onward. We use sed for
  # the portability of "first occurrence, take the rest of that line" because
  # bodies may contain newlines but the BREAKING CHANGE footer conventionally
  # sits on its own line with the description immediately after it.
  after="$(printf '%s\n' "$body" | sed -n 's/^BREAKING CHANGE:[[:space:]]*//p' | head -n 1)"
  printf '%s' "$after"
}

# --- bucket_commit <subject> <body>: classify one commit into the proper
# Keep a Changelog array, or bump other_count if no rule matches. Side
# effects only (no return value). Runs in sane mode (no nocasematch here).
# MUST be defined before the parsing loop because the loop calls it per
# commit; bash does not hoist function definitions forward.
bucket_commit() {
  local subj="$1"
  local body="$2"
  local stripped
  local breaking_body

  # Revert "..." commits are bucketed by an uppercase "Revert" prefix; enable
  # case-insensitive match just for this check. We bracket the shopt toggles
  # so the rest of the script stays case-sensitive.
  shopt -s nocasematch
  if [[ "$subj" =~ ^Revert[[:space:]]+\" ]]; then
    shopt -u nocasematch
    reverts_bullets+=("- $subj")
    return
  fi
  shopt -u nocasematch

  if [[ "$subj" =~ $breaking_subject_re ]] || [[ "$body" == *"$breaking_footer_marker"* ]]; then
    # Breaking change: the subject also gets surfaced in ### Changed so the
    # operator sees what changed mechanically, AND we prepend a breaking
    # bullet describing the user-visible breakage. The breaking bullet
    # prefers the footer text when present (more user-oriented) and falls
    # back to the subject otherwise.
    stripped="$(strip_prefix "$subj")"
    breaking_body="$(extract_breaking_body "$body")"
    if [[ -n "$breaking_body" ]]; then
      breaking_bullets+=("- $stripped — $breaking_body")
    else
      breaking_bullets+=("- $stripped")
    fi
    # Also surface in Changed so the mechanics aren't lost.
    changed_bullets+=("- Breaking: $stripped")
    return
  fi

  if [[ "$subj" =~ $feat_re ]]; then
    stripped="$(strip_prefix "$subj")"
    added_bullets+=("- $stripped")
    return
  fi

  if [[ "$subj" =~ $fix_re ]]; then
    stripped="$(strip_prefix "$subj")"
    fixed_bullets+=("- $stripped")
    return
  fi

  if [[ "$subj" =~ $perf_re ]]; then
    stripped="$(strip_prefix "$subj")"
    changed_bullets+=("- Performance: $stripped")
    return
  fi

  if [[ "$subj" =~ $refactor_re ]]; then
    stripped="$(strip_prefix "$subj")"
    changed_bullets+=("- Refactor: $stripped")
    return
  fi

  if [[ "$subj" =~ $build_deps_re ]]; then
    stripped="$(strip_prefix "$subj")"
    changed_bullets+=("- Dependencies: $stripped")
    return
  fi

  if [[ "$subj" =~ $build_other_re ]]; then
    # Other build-scoped commits (e.g. build(ci):) are developer hygiene;
    # silently skip.
    other_count=$((other_count + 1))
    return
  fi

  # Anything else (chore/docs/ci/test/style/debug: or non-conventional) is
  # developer hygiene and not surfaced in the public-facing changelog.
  other_count=$((other_count + 1))
}

# --- render_section_body: build the markdown body for the new section,
# in canonical Keep a Changelog order: Breaking -> Added -> Changed -> Fixed
# -> Reverts. Empty sections are omitted entirely. Returns the body on stdout
# (without the "## [version] - date" header line; the caller prepends that).
render_section_body() {
  local out=""

  if [[ ${#breaking_bullets[@]} -gt 0 ]]; then
    out+="### ⚠ BREAKING CHANGES"$'\n\n'
    for b in "${breaking_bullets[@]}"; do
      out+="$b"$'\n'
    done
    out+=$'\n'
  fi

  if [[ ${#added_bullets[@]} -gt 0 ]]; then
    out+="### Added"$'\n\n'
    for b in "${added_bullets[@]}"; do
      out+="$b"$'\n'
    done
    out+=$'\n'
  fi

  if [[ ${#changed_bullets[@]} -gt 0 ]]; then
    out+="### Changed"$'\n\n'
    for b in "${changed_bullets[@]}"; do
      out+="$b"$'\n'
    done
    out+=$'\n'
  fi

  if [[ ${#fixed_bullets[@]} -gt 0 ]]; then
    out+="### Fixed"$'\n\n'
    for b in "${fixed_bullets[@]}"; do
      out+="$b"$'\n'
    done
    out+=$'\n'
  fi

  if [[ ${#reverts_bullets[@]} -gt 0 ]]; then
    out+="### Reverts"$'\n\n'
    for b in "${reverts_bullets[@]}"; do
      out+="$b"$'\n'
    done
    out+=$'\n'
  fi

  printf '%s' "$out"
}

# --- Parse the commit_raw blob line-by-line, grouping per-commit fields.
# State machine: expect SHA -> subject -> body (zero or more lines) -> ---END---.
# We invoke bucket_commit (defined above) at each ---END--- boundary so the
# function is already in scope by the time the loop runs.
current_sha=""
current_subject=""
current_body=""
in_body=0
while IFS= read -r line; do
  if [[ "$in_body" -eq 0 && "$line" == "---END---" ]]; then
    # Commit record with an empty body. Process it via the fallback below
    # so a no-body commit is still bucketed.
    bucket_commit "$current_subject" "$current_body"
    current_sha=""
    current_subject=""
    current_body=""
    in_body=0
  elif [[ "$in_body" -eq 0 ]]; then
    # First line = SHA, second = subject, then body lines until ---END---.
    if [[ -z "$current_sha" ]]; then
      current_sha="$line"
    elif [[ -z "$current_subject" ]]; then
      current_subject="$line"
      in_body=1
    fi
  elif [[ "$in_body" -eq 1 ]]; then
    if [[ "$line" == "---END---" ]]; then
      # End of this commit record. Bucket it, then reset for the next.
      bucket_commit "$current_subject" "$current_body"
      current_sha=""
      current_subject=""
      current_body=""
      in_body=0
    else
      # Accumulate body line. We separate lines with $'\n' so the BREAKING
      # CHANGE marker scanner can locate it on its own line.
      if [[ -z "$current_body" ]]; then
        current_body="$line"
      else
        current_body="${current_body}"$'\n'"${line}"
      fi
    fi
  fi
done <<<"$commit_raw"

# --- Build the full header+body block for the new section.
if [[ -n "$section_date" ]]; then
  section_header="## [${version_arg}] - ${section_date}"
else
  section_header="## [${version_arg}]"
fi
section_body="$(render_section_body)"
section_block="${section_header}"$'\n\n'"${section_body}"

# --- Dry-run path: print resolved inputs + the section block to stdout, exit
# 0 without touching the changelog file or any temp file.
if [[ "$dry_run" -eq 1 ]]; then
  printf '# Generate Changelog — Dry Run\n'
  printf 'from_ref: %s\n' "$from_ref"
  printf 'to_ref: %s\n' "$to_ref"
  printf 'commits scanned: %s\n' "$commit_count"
  printf 'version: %s\n' "$version_arg"
  if [[ -n "$section_date" ]]; then
    printf 'date: %s\n' "$section_date"
  else
    printf -- 'date: (omitted for Unreleased)\n'
  fi
  printf 'changelog_path: %s\n' "$changelog_path"
  printf -- '---\n'
  printf '%s\n' "$section_block"
  exit 0
fi

# --- File-creation-or-update path.
# Keep a Changelog 1.1.0 preamble written verbatim when the file does not
# exist yet. When the file exists we either replace an existing matching
# "## [${version_arg}]" section in-place or insert a new section at the
# correct position (below preamble, below any Unreleased section, above
# older sections for real versions; at the very top for "## [Unreleased]").
preamble='# Changelog

All notable changes to the Litoral Agency Publisher browser extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).'

if [[ ! -f "$changelog_path" ]]; then
  # Fresh changelog. If version is "Unreleased" the freshly generated section
  # IS the Unreleased section, so we must NOT emit an empty "## [Unreleased]"
  # before the generator's block (avoid a deduplicated empty header).
  if [[ "$version_arg" == "Unreleased" ]]; then
    printf '%s\n\n%s\n' "$preamble" "$section_block" >"$changelog_path"
  else
    # Default layout for a fresh non-Unreleased version: preamble, an empty
    # Unreleased placeholder on top, then the generated real-version block.
    printf '%s\n\n## [Unreleased]\n\n%s\n' "$preamble" "$section_block" >"$changelog_path"
  fi
  exit 0
fi

# Existing file. Read it into memory; if a matching "## [${version_arg}]"
# section already exists, replace its body; otherwise insert a new section
# at the correct location.
#
# We use awk for the in-place mutation because it handles multi-line state
# transitions cleanly and is portable across Git Bash / MSYS / Linux. The
# awk script:
#   - Walks lines.
#   - When it encounters the opening "## [${version_arg}]" header it
#     - Emits the new section_block instead of the old section's lines.
#     - Skips lines until the next "## [" header or EOF.
#   - When it encounters ANY "## [" header in the file AND we haven't yet
#     inserted our section AND we're inserting a new section (not replacing),
#     it decides whether to insert ABOVE that header based on:
#       - For Unreleased: insert ABOVE the FIRST "## [" header.
#       - For real versions: insert ABOVE the first "## [${older_version}]"
#         header, but BELOW any "## [Unreleased]" header.
#   Tracks state via variables: replaced (0/1), inserted (0/1).
#
# We pre-stage the new section_block in a temp file because awk's system()
# invocation is messy; instead we pass it as an awk variable (multi-line
# strings are fine in awk's -v).

# First, detect whether a matching section already exists.
existing_section_marker="## [${version_arg}]"
if grep -Fq "$existing_section_marker" "$changelog_path"; then
  # Replace-in-place path.
  # Use awk to emit the file with the matching section's body replaced.
  # We capture the new block text into an awk variable; because awk -v
  # expands backslash escapes, we pass via the environment with ENVIRON
  # instead to avoid mangling. Approach: write the new block to a temp
  # file, then have awk read it via getline when we hit the section.
  tmp_block="$(mktemp)"
  printf '%s\n' "$section_block" >"$tmp_block"
  # The awk program: on encountering "$existing_section_marker" at line
  # start, emit the temp file's contents, then skip lines until the next
  # "^## [" header (or EOF). All other lines are emitted verbatim.
  awk -v marker="$existing_section_marker" -v blockfile="$tmp_block" '
    BEGIN { in_target = 0 }
    {
      if (in_target == 1) {
        if ($0 ~ /^## \[/) {
          in_target = 0
          print
        } else {
          # Skip the old section body lines (do not emit them).
          next
        }
      } else if (index($0, marker) == 1 && $0 == marker) {
        # Found the opening header. Emit the new block.
        while ((getline line < blockfile) > 0) print line
        close(blockfile)
        in_target = 1
        # Do NOT print the original header line; the new block includes
        # its own header.
      } else {
        print
      }
    }
  ' "$changelog_path" >"${changelog_path}.tmp" || {
    rm -f "$tmp_block" "${changelog_path}.tmp"
    die "awk substitution failed while replacing existing section" 4
  }
  rm -f "$tmp_block"
  mv "${changelog_path}.tmp" "$changelog_path" || die "could not write $changelog_path" 4
  exit 0
fi

# New-section-insertion path. For "## [Unreleased]" -> insert ABOVE the first
# "## [" header. For a real version -> insert BELOW any "## [Unreleased]"
# section and ABOVE the next "## [" header (which will be an older release or
# EOF). We use the same ENVIRON-via-temp-file technique to avoid awk -v
# escape mangling.
tmp_block="$(mktemp)"
printf '%s\n\n' "$section_block" >"$tmp_block"
if [[ "$version_arg" == "Unreleased" ]]; then
  # Insert above the first "## [" header (or at EOF if there is none).
  awk -v blockfile="$tmp_block" '
    BEGIN { inserted = 0 }
    {
      if (inserted == 0 && $0 ~ /^## \[/) {
        while ((getline line < blockfile) > 0) print line
        close(blockfile)
        inserted = 1
      }
      print
    }
    END {
      if (inserted == 0) {
        # No "## [" header found in the file. Append at EOF.
        while ((getline line < blockfile) > 0) print line
        close(blockfile)
      }
    }
  ' "$changelog_path" >"${changelog_path}.tmp" || {
    rm -f "$tmp_block" "${changelog_path}.tmp"
    die "awk substitution failed while inserting Unreleased section" 4
  }
else
  # Real version: skip past any leading "## [Unreleased]" section, then
  # insert above the NEXT "## [" header (which will be an older release
  # or EOF). This keeps "## [Unreleased]" on top and newest release below
  # it. We track whether we are still inside the Unreleased section.
  awk -v blockfile="$tmp_block" '
    BEGIN { inserted = 0; in_unreleased = 0 }
    {
      if (inserted == 0) {
        if ($0 ~ /^## \[Unreleased\]/) {
          print
          in_unreleased = 1
          next
        }
        if (in_unreleased == 1) {
          # Pass through the Unreleased section body until the next header.
          if ($0 ~ /^## \[/) {
            # We hit the first real-version header. Emit the new block
            # first, then this header, then continue printing the rest.
            while ((getline line < blockfile) > 0) print line
            close(blockfile)
            inserted = 1
            in_unreleased = 0
            print
            next
          } else {
            print
            next
          }
        }
        # Not in Unreleased, and we have not yet inserted. Insert above the
        # first "## [" header we encounter (or at EOF if there are no other
        # real-version sections).
        if ($0 ~ /^## \[/) {
          while ((getline line < blockfile) > 0) print line
          close(blockfile)
          inserted = 1
          print
          next
        }
        print
      } else {
        print
      }
    }
    END {
      if (inserted == 0) {
        # No "## [" header after Unreleased (or no Unreleased at all and
        # no real versions yet). Append at EOF.
        print ""
        while ((getline line < blockfile) > 0) print line
        close(blockfile)
      }
    }
  ' "$changelog_path" >"${changelog_path}.tmp" || {
    rm -f "$tmp_block" "${changelog_path}.tmp"
    die "awk substitution failed while inserting new version section" 4
  }
fi
rm -f "$tmp_block"
mv "${changelog_path}.tmp" "$changelog_path" || die "could not write $changelog_path" 4

exit 0
