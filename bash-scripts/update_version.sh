#!/bin/bash
# Usage: ./update_version.sh <new_version>
# FORMAT IS <0.0.0>
#
# Rewrites the "version" field in every package.json under the repo (excluding
# node_modules) to <new_version>.
#
# The original Jonghakseo-era implementation (preserved in git history as of
# the v0.6.0 cut) used an UNSCOPED unanchored perl regex:
#
#   find . -name 'package.json' -not -path '*/node_modules/*' -exec bash -c '
#     current_version=$(grep -o "\"version\": \"[^\"]*" "$0" | cut -d"\"" -f4)
#     perl -i -pe"s/$current_version/'$1'/" "$0"
#   '  {} \;
#
# Two latent bugs in that form:
#
#   (a) The perl substitution matched the version literal ANYWHERE in the file,
#       including inside dependency specifiers like
#       `"prettier-plugin-tailwindcss": "^0.6.11"`. If the current version
#       happened to be a prefix of a dependency version (e.g. `0.6.1` versus
#       `^0.6.11`), the perl substitution would corrupt the dependency
#       specifier in addition to bumping the actual version field. This bit
#       the first Litoral-era 0.6.1 -> 0.6.2 bump (commit 8cbd7a0), which
#       silently rewrote `"prettier-plugin-tailwindcss": "^0.6.11"` to
#       `"^0.6.21"` -- an off-by-one that made `pnpm install
#       --frozen-lockfile` fail with ERR_PNPM_OUTDATED_LOCKFILE on the next
#       CI run (release.yml run 29645121705's build-chrome matrix step).
#
#   (b) The bash -c single-quoted subshell made it impossible to safely pass
#       the next_version literal (`$1` from outer scope) into perl's
#       substitution-replacement field. The original used `'$1'` inside the
#       single-quoted subshell, which worked accidentally because the outer
#       `$1` was the only caller-supplied arg -- but any attempt to anchor
#       the regex (which needs careful escape handling) runs into shell-
#       quoting hell inside the nested subshell.
#
# Fix:
#   (1) Drop the `find -exec bash -c` pattern in favor of a `while IFS=
#       read -r file` loop, which gives us proper bash variable expansion
#       without nested subshell quoting hazards.
#   (2) Anchor the perl regex to the JSON `"version":` field with
#       `^(\s*"version":\s*")...(")` so the substitution only fires on the
#       version field, not on dependency specifiers that happen to share a
#       version prefix.
#   (3) Perl quotemeta `\Q...\E` the current_version literal so any regex
#       metacharacters in the version (there are none for clean X.Y.Z, but
#       defensive) are treated as literal characters.
#
# The composition contract with bump_version.sh is preserved:
#   - exit 0 on success
#   - exit 1 on bad args (caller passes through)
#   - caller passes <new_version> as a single argv

if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  next_version="$1"
  # Use process substitution so we can iterate paths with spaces without
  # needing toarle `IFS=$'\n'` globally. `git ls-files` would be more
  # reliable than `find` but adds a git dependency for callers (the
  # `pnpm update-version` script) that might run this without a git repo --
  # keep `find` for now.
  while IFS= read -r file; do
    # Parse the current version from package.json. The grep+cut combo
    # extracts the value of the first `"version": "..."` field in the
    # file; all 24 package.json files in this repo use the standard
    # 2-space-indented `"version": "X.Y.Z"` line shape.
    current_version=$(grep -o "\"version\": \"[^\"]*" "$file" | head -n 1 | cut -d'"' -f4)

    # Skip files that have no version field (defensive). With the standard
    # 24-package layout this never fires, but it is cheap insurance against
    # a future file-shaped package.json (e.g. a vendor manifest) being
    # added to the tree without a version.
    if [[ -z "$current_version" ]]; then
      continue
    fi

    # Anchored perl substitution. Regex break-down:
    #   ^(\s*"version":\s*")        ^              start of line
    #                                 \s*          optional leading whitespace
    #                                 "version":   literal field name + colon
    #                                 \s*          optional whitespace (JSON spec)
    #                                 "            opening quote, captured into ${1}
    #   \Q$current_version\E         quotemeta'd version literal
    #   (")                          closing quote, captured into ${2}
    #
    # Replacement:
    #   ${1}${next_version}${2}      re-inserts the captured prefix + new version
    #                               + closing quote
    #
    # Why ${1} and ${2} instead of $1 and $2: when next_version starts with a
    # digit (which it always does for semver -- "0.6.2" starts with '0'), the
    # naive `$10` would be parsed by perl as capture-group 10 (= empty) plus
    # literal "0.6.2", scrubbing the leading 2 chars of $1 in the replacement.
    # Wrapping the backref in `${1}` removes the ambiguity. This bug was the
    # cause of the `.6.2",` corruption seen in the first attempt at this fix.
    #
    # Single quotes around the perl -pe 'PROGRAM' arg let us write the regex
    # with raw \s without bash interfering, and $file / $next_version are
    # interpolated via '"$var"'-style shell-quote breaking OUT of the single
    # quote, then back IN. Net result: perl sees exactly the regex we want,
    # with safe interpolation of $file and $next_version.
    perl -i -pe's/^(\s*"version":\s*")\Q'"$current_version"'\E(")/${1}'"$next_version"'${2}/' "$file"
  done < <(find . -name 'package.json' -not -path '*/node_modules/*' -print)

  echo "Updated versions to $1";
else
  echo "Version format <$1> isn't correct, proper format is <0.0.0>";
fi
