#!/usr/bin/env bash
# Release notes with the release workflow's section (the download table, or a note while
# the downloads are being built) on top:
#   bash scripts/release-notes.sh section.md < current-notes.md > new-notes.md
# A section added by an earlier run is replaced; all other text, such as notes written when
# the release was created by hand on GitHub, is kept below it.
set -euo pipefail

echo '<!-- release-workflow -->'
cat "$1"
echo '<!-- /release-workflow -->'
echo
perl -0777 -pe 's/<!-- release-workflow -->.*?<!-- \/release-workflow -->\s*//s'
