#!/usr/bin/env bash
# Copy easy-read.js from the easy-read skill (single source of truth) into the extension.
set -euo pipefail
SRC="${EASY_READ_SKILL:-$HOME/.claude/skills/easy-read}/easy-read.js"
DEST="$(cd "$(dirname "$0")/.." && pwd)/extension/easy-read.js"
if [ ! -f "$SRC" ]; then
  echo "easy-read skill not found: $SRC (set EASY_READ_SKILL)" >&2
  exit 1
fi
cp "$SRC" "$DEST"
echo "copied $SRC -> $DEST"
