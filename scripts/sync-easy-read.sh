#!/usr/bin/env bash
# Copy the shared files from their skills (single source of truth) into the extension.
set -euo pipefail
SKILLS="${CLAUDE_SKILLS:-$HOME/.claude/skills}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/extension"
copy() {
  if [ ! -f "$1" ]; then
    echo "missing: $1 (set CLAUDE_SKILLS)" >&2
    exit 1
  fi
  cp "$1" "$2"
  echo "copied $1 -> $2"
}
copy "${EASY_READ_SKILL:-$SKILLS/easy-read}/easy-read.js" "$DEST/easy-read.js"
for f in zotero-api.js papers.js; do
  copy "$SKILLS/zotero-link/$f" "$DEST/$f"
done
