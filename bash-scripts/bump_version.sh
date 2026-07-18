#!/usr/bin/env bash
# bump_version.sh — derive the next semver from Conventional-Commit messages
# and delegate the actual file rewrite to bash-scripts/update_version.sh.
#
# Usage:
#   ./bump_version.sh                      # bump using range <last v* tag>..HEAD
#   ./bump_version.sh --dry-run            # compute + print, do NOT touch files
#   ./bump_version.sh --from-ref <ref>      # override range start (exclusive)
#   ./bump_version.sh --to-ref <ref>        # override range end (inclusive of tip)
#   ./bump_version.sh -h | --help           # print help and exit 0
#
# Conventional-Commit type -> bump mapping:
#   fix:                          -> patch
#   feat:                         -> minor
#   perf:                         -> minor
#   <type>!:                      -> major   (breaking marker on the subject)
#   BREAKING CHANGE:              -> major   (footer in the commit body)
#   refactor/style/docs/test/ci/chore: -> no bump
# When multiple types appear in the range, the HIGHEST bump wins
# (major > minor > patch > none) so a single breaking change forces a major
# bump even if every other commit is a patch.
#
# Exit codes:
#   0  success (or dry-run printed successfully)
#   1  generic error (bad args, git failure, update_version.sh failed)
#   2  no bumpable commits found in the range; nothing to do
#
# Composition note:
#   This script does NOT rewrite package.json files itself. After computing
#   the next version it calls bash-scripts/update_version.sh "<X.Y.Z>", which
#   does the perl -i -pe substitution across every non-node_modules
#   package.json in the tree. We compose rather than duplicate so the
#   rewrite logic stays in one place.

set -euo pipefail

# --- Locate sibling update_version.sh relative to this script's own dir
# so the script works regardless of the caller's CWD (CI, Git Bash, etc.).
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
update_version_sh="${script_dir}/update_version.sh"

# --- Locate the repo root via git so we always read the ROOT package.json,
# not whatever package.json happens to sit under CWD.
repo_root="$(git rev-parse --show-toplevel)"
root_package_json="${repo_root}/package.json"

# --- Argument defaults
dry_run=0
from_ref=""
to_ref="HEAD"

print_help() {
  cat <<'EOF'
bump_version.sh — derive the next semver from Conventional-Commit messages.

Usage:
  bash bump_version.sh [--dry-run] [--from-ref <ref>] [--to-ref <ref>] [-h|--help]

Options:
  --dry-run            Compute and print the next version; do NOT modify files.
  --from-ref <ref>     Git ref starting the range (exclusive).
                       Default: most recent tag matching v* reachable from HEAD.
                       Fallback if no v* tag exists: the repository root commit
                       ($(git rev-list --max-parents=0 HEAD) equivalent).
  --to-ref <ref>       Git ref ending the range (inclusive of the tip's message).
                       Default: HEAD.
  -h, --help           Show this help and exit 0.

Conventional-Commit type -> bump mapping:
  fix:               -> patch
  feat:              -> minor
  perf:              -> minor
  <type>!:           -> major   (breaking marker on the subject)
  BREAKING CHANGE:   -> major   (footer in the commit body)
  refactor/style/docs/test/ci/chore: -> no bump

Highest bump in the range wins (major > minor > patch > none).

Exit codes:
  0  success
  1  generic error (bad args, git failure, update_version.sh failed)
  2  no bumpable commits found in the range; nothing to do
EOF
}

# --- Parse argv. We do not use getopt/getopts to stay portable across
# Git Bash / MSYS and Linux ubuntu-latest runners without locale surprises.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --from-ref)
      if [[ $# -lt 2 ]]; then
        echo "error: --from-ref requires a value" >&2
        exit 1
      fi
      from_ref="$2"
      shift 2
      ;;
    --to-ref)
      if [[ $# -lt 2 ]]; then
        echo "error: --to-ref requires a value" >&2
        exit 1
      fi
      to_ref="$2"
      shift 2
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      print_help >&2
      exit 1
      ;;
  esac
done

# --- Resolve the start of the range (from_ref).
# Default: most recent v* tag reachable from HEAD. We use git describe so a
# missing tag is reported via exit status rather than crashing under set -e.
if [[ -z "$from_ref" ]]; then
  if from_ref="$(git describe --tags --abbrev=0 --match 'v*' HEAD 2>/dev/null)"; then
    : # found a v* tag; use it
  else
    # No v* tag exists yet (common in fresh repos / pre-release phase).
    # Fall back to the root commit so we scan every commit ever made.
    # We pick the root commit (rather than, say, HEAD~N) because there is no
    # natural earlier boundary without a tag, and a partial range would
    # silently drop history the user expects to be inspected.
    from_ref="$(git rev-list --max-parents=0 HEAD | tail -n 1)"
    if [[ -z "$from_ref" ]]; then
      echo "error: could not determine a start ref (no v* tag and no root commit)" >&2
      exit 1
    fi
  fi
fi

# --- Validate refs resolve before we use them in a range. Failing fast here
# produces a clearer error than letting git log choke under set -e.
if ! git rev-parse --verify --quiet "$from_ref" >/dev/null; then
  echo "error: --from-ref does not resolve to a valid ref: $from_ref" >&2
  exit 1
fi
if ! git rev-parse --verify --quiet "$to_ref" >/dev/null; then
  echo "error: --to-ref does not resolve to a valid ref: $to_ref" >&2
  exit 1
fi

# --- Read current version from the ROOT package.json.
# Prefer node -p for a faithful JSON parse; fall back to a grep/sed parse so
# the script still works on minimal CI images that lack node in PATH.
if command -v node >/dev/null 2>&1; then
  current_version="$(node -p "require('${root_package_json}').version")"
else
  # Fallback: pull the first "version": "X.Y.Z" occurrence. Good enough for
  # well-formed package.json; node -p above is the robust path.
  current_version="$(grep -o '"version": "[^"]*"' "$root_package_json" | head -n 1 | sed -E 's/"version": "([^"]*)"/\1/')"
fi

if [[ -z "$current_version" ]]; then
  echo "error: could not read version from $root_package_json" >&2
  exit 1
fi

# We only support the first three dot-separated numeric components in this
# first version of the script. If a prerelease suffix (-...) is present we
# strip it and warn so the user knows we are not bumping the pre tag.
if [[ "$current_version" == *-* ]]; then
  echo "warning: current version '$current_version' contains a prerelease suffix; using only the first three numeric components" >&2
fi
# Strip any prerelease suffix and keep major.minor.patch.
version_core="${current_version%%-*}"

# Save the raw current_version for display; everything else uses version_core.
display_current_version="$current_version"

# --- Collect commit subjects AND bodies for the range.
# We need bodies too because the BREAKING CHANGE: marker lives in the footer
# of a commit body, not in the subject line. %s is the subject, %b is the
# body; we join them with a newline per commit and let the scanners handle
# the boundary. The range is from_ref..to_ref, which is exclusive of
# from_ref and inclusive of to_ref — this is the standard "what's new since
# the last tag" semantic and matches how the release notes tooling will
# consume the same range downstream.
mapfile -t commit_messages < <(git log --format='%s%n%b' "${from_ref}..${to_ref}")

commit_count="${#commit_messages[@]}"
# We treat an empty range as "nothing to do" rather than a hard error so the
# caller can wire this into CI without spurious red builds when nothing
# changed; the no-bumpable-commits path below still returns 2.
if [[ "$commit_count" -eq 0 ]]; then
  echo "No bumpable commits found in range ${from_ref}..${to_ref}; nothing to do."
  exit 2
fi

# --- Scan messages for bump signals. We concatenate subject+body per commit
# into one string per commit (the mapfile line breaks are preserved), then
# apply extended-regex matching. We pick the HIGHEST bump detected because a
# single breaking change must force a major bump even if every other commit
# is a patch; ordering the bumps major>minor>patch and taking the max models
# that directly.
detected_bump="none"

# Breaking marker on the subject: any conventional type followed by "!".
# We use =~ which on bash 3.2+ (macOS) and bash 4+ (Linux/MSYS) supports ERE.
breaking_subject_re='^[a-z]+(\([a-z0-9._-]+\))?!:'
breaking_footer_re='BREAKING CHANGE:'

for msg in "${commit_messages[@]}"; do
  # Skip empty lines produced by multiline %b boundaries.
  [[ -z "$msg" ]] && continue

  # Check breaking first so we can short-circuit to the highest level.
  if [[ "$msg" =~ $breaking_subject_re ]] || [[ "$msg" == *"BREAKING CHANGE:"* ]]; then
    detected_bump="major"
    break
  fi
done

# If no breaking marker was found, scan for feat/perf (minor) and fix (patch).
# We keep scanning even after finding a minor in case a later commit raises
# the level — but once we have minor we only need to keep an eye out for
# major (already handled above), so the minor/patch pass is order-independent.
if [[ "$detected_bump" == "none" ]]; then
  feat_re='^feat(\([a-z0-9._-]+\))?:'
  perf_re='^perf(\([a-z0-9._-]+\))?:'
  fix_re='^fix(\([a-z0-9._-]+\))?:'
  for msg in "${commit_messages[@]}"; do
    [[ -z "$msg" ]] && continue
    if [[ "$msg" =~ $feat_re ]] || [[ "$msg" =~ $perf_re ]]; then
      detected_bump="minor"
      # Don't break: keep iterating to keep semantics uniform with the major
      # pass; minor is still the highest we can reach in this loop.
    elif [[ "$msg" =~ $fix_re ]]; then
      if [[ "$detected_bump" == "none" ]]; then
        detected_bump="patch"
      fi
    fi
  done
fi

if [[ "$detected_bump" == "none" ]]; then
  echo "No bumpable commits found in range ${from_ref}..${to_ref}; nothing to do."
  exit 2
fi

# --- Compute the next version by splitting on "." and incrementing the
# relevant component, resetting the trailing components to 0.
IFS='.' read -r major minor patch <<<"$version_core"
# Validate we got three numeric components; if not, bail rather than
# silently producing a malformed next version.
if [[ ! "$major" =~ ^[0-9]+$ || ! "$minor" =~ ^[0-9]+$ || ! "$patch" =~ ^[0-9]+$ ]]; then
  echo "error: current version '$current_version' is not a clean major.minor.patch" >&2
  exit 1
fi

case "$detected_bump" in
  major)
    major=$((major + 1))
    minor=0
    patch=0
    ;;
  minor)
    minor=$((minor + 1))
    patch=0
    ;;
  patch)
    patch=$((patch + 1))
    ;;
esac

next_version="${major}.${minor}.${patch}"

# --- Report. Echo a stable block so CI logs and the release workflow can
# parse the detected level and next version line by line.
echo "Current version: ${display_current_version}"
echo "Commit range: ${from_ref}..${to_ref} (${commit_count} commits)"
echo "Detected bump: ${detected_bump}"
echo "Next version: ${next_version}"

if [[ "$dry_run" -eq 1 ]]; then
  echo "(dry-run; no files modified)"
  exit 0
fi

if [[ ! -x "$update_version_sh" ]]; then
  echo "error: expected update_version.sh at ${update_version_sh} (not found or not executable)" >&2
  exit 1
fi

echo "Calling update_version.sh ${next_version} ..."
"$update_version_sh" "$next_version"
echo "Done."
