#!/usr/bin/env bash
# The section of one version in CHANGELOG.md, as release notes:
#   bash scripts/changelog.sh 0.2.0 > section.md
# Prints the entries below "## [0.2.0]" (up to the next "## " heading) under a "## Changelog"
# heading, followed by an empty line. Prints nothing if CHANGELOG.md has no section for the
# version, so a release without an entry still gets the generated notes.
set -euo pipefail

version="${1#v}"
file="$(dirname "$0")/../CHANGELOG.md"
[ -f "$file" ] || exit 0

# leading empty lines are dropped by sed, trailing ones by the command substitution; the link
# definitions at the end of the file ("[0.2.0]: https://...") are not part of a section
section=$(awk -v v="$version" '
  /^## / {
    if (found) exit
    if (index($0, "## [" v "]") == 1 || index($0, "## " v " ") == 1 || $0 == "## " v) { found = 1; next }
  }
  found && !/^\[[^]]+\]: / { print }
' "$file" | sed -e '/./,$!d')

if [ -z "$section" ]; then
  echo "CHANGELOG.md has no section for $version" >&2
  exit 0
fi

echo '## Changelog'
echo
printf '%s\n' "$section"
echo
