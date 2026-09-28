#!/bin/bash
# Build YuMarkEditor.app: web UI (esbuild) + native shell (swiftc) + icon, ad-hoc signed.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(pwd)
APP="$ROOT/build/YuMarkEditor.app"
WEBP=/opt/homebrew/opt/webp   # brew install webp (linked statically)

echo "▸ web"
(cd web && node build.mjs)

echo "▸ bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp native/Info.plist "$APP/Contents/Info.plist"
cp -R web/dist "$APP/Contents/Resources/web"
[ -f native/AppIcon.icns ] || scripts/make-icon.sh
cp native/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

echo "▸ swift"
swiftc -O -swift-version 5 -target arm64-apple-macos13.0 \
  -import-objc-header native/Bridging.h -I "$WEBP/include" \
  native/Sources/*.swift \
  "$WEBP/lib/libwebp.a" "$WEBP/lib/libsharpyuv.a" \
  -framework AppKit -framework WebKit -framework UniformTypeIdentifiers \
  -Xlinker -dead_strip \
  -o "$APP/Contents/MacOS/YuMarkEditor" 2>&1 | grep -v "was built for newer 'macOS' version" || true
test -x "$APP/Contents/MacOS/YuMarkEditor"

echo "▸ sign"
codesign --force --sign - --timestamp=none "$APP" >/dev/null
echo "✓ $(du -sh "$APP" | cut -f1)  $APP"
