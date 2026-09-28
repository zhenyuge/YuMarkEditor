#!/bin/bash
# Renders design/icon/yumark.svg into native/AppIcon.icns (headless Chrome + iconutil).
set -euo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d)
node design/icon/render.mjs design/icon/yumark.svg "$T/icon-1024.png" 1024
mkdir -p "$T/AppIcon.iconset"
for s in 16 32 128 256 512; do
  magick "$T/icon-1024.png" -filter Lanczos -resize ${s}x${s} "$T/AppIcon.iconset/icon_${s}x${s}.png"
  magick "$T/icon-1024.png" -filter Lanczos -resize $((s*2))x$((s*2)) "$T/AppIcon.iconset/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$T/AppIcon.iconset" -o native/AppIcon.icns
cp "$T/icon-1024.png" design/icon/yumark-1024.png
rm -rf "$T"
echo "icon ok"
