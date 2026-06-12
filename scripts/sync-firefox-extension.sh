#!/usr/bin/env bash
# Copy Chrome extension sources into firefox-extension/ (real files, not symlinks).
# Firefox refuses to load scripts that symlink outside the add-on directory.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/extension"
DST="$ROOT/firefox-extension"

copy_path() {
  local rel="$1"
  rm -rf "$DST/$rel"
  if [ -d "$SRC/$rel" ]; then
    cp -R "$SRC/$rel" "$DST/$rel"
  else
    cp "$SRC/$rel" "$DST/$rel"
  fi
}

for rel in background.js content.js options.js options.html popup.js popup.html popup.css lib icons; do
  copy_path "$rel"
done

echo "Synced extension/ -> firefox-extension/ (manifest.json unchanged)"
