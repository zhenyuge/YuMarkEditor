#!/bin/bash
# Run the built app headlessly-ish with a test script: scripts/apptest.sh test.js [outdir]
set -euo pipefail
cd "$(dirname "$0")/.."
SCRIPT=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
OUT=${2:-$(pwd)/build/test-out}
SUPPORT=${YUMARK_SUPPORT:-$(pwd)/build/test-support}
mkdir -p "$OUT" "$SUPPORT"
rm -f "$OUT/result.txt" "$OUT/snap.png"
YUMARK_SUPPORT="$SUPPORT" YUMARK_TEST_SCRIPT="$SCRIPT" YUMARK_TEST_OUT="$OUT" \
  build/YuMarkEditor.app/Contents/MacOS/YuMarkEditor ${APP_ARGS:-} >"$OUT/stdout.log" 2>&1 &
PID=$!
for i in $(seq 1 120); do
  if ! kill -0 $PID 2>/dev/null; then break; fi
  sleep 0.5
done
kill $PID 2>/dev/null || true
cat "$OUT/result.txt" 2>/dev/null || echo "(no result)"
