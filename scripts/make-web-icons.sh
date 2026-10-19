#!/bin/sh
# Builds the web icons from the iOS app icon (macOS `sips`). Run from the project root:
#   sh scripts/make-web-icons.sh
set -e
SRC="ios/AgentMustafa/Sources/Assets.xcassets/AppIcon.appiconset/Minimalistički logo AGENT MUSTAFA.png"
OUT="web/public"
mkdir -p "$OUT"
sips -z 32 32   "$SRC" --out "$OUT/favicon-32.png"       >/dev/null
sips -z 180 180 "$SRC" --out "$OUT/apple-touch-icon.png" >/dev/null
sips -z 192 192 "$SRC" --out "$OUT/icon-192.png"         >/dev/null
sips -z 512 512 "$SRC" --out "$OUT/icon-512.png"         >/dev/null
echo "Web icons written to $OUT"
