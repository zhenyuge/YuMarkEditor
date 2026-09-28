#!/bin/bash
# Runs every automated check: markdown round-trip, Word export, UI (headless Chrome), app (WKWebView).
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

step "markdown round-trip (CommonMark spec ×3 variants)"
(cd web && npx esbuild test/md.test.ts --bundle --platform=node --format=cjs --external:commonmark-spec --outfile=test/.out/mdtest.cjs --log-level=warning && node test/.out/mdtest.cjs) || fail=1

step "Word export"
(cd web && npx esbuild test/docx.test.ts --bundle --platform=node --format=cjs --outfile=test/.out/docxtest.cjs --log-level=warning && node test/.out/docxtest.cjs | tail -1) || fail=1

step "type check"
(cd web && npx tsc --noEmit -p .) || fail=1

step "UI in headless Chrome"
(cd web && node build.mjs >/dev/null && for s in interact.mjs interact2.mjs paste.mjs; do node test/ui.mjs $s 2>&1 | grep -E "PASS|FAIL"; done) | tee /tmp/yumark-ui.txt
grep -q FAIL /tmp/yumark-ui.txt && fail=1

if [ -x build/YuMarkEditor.app/Contents/MacOS/YuMarkEditor ]; then
  step "app (WKWebView) — opens a window briefly"
  rm -f build/test-support/session.json
  scripts/apptest.sh tests/native/smoke.js | head -3
fi

[ $fail = 0 ] && printf '\n\033[32mall checks passed\033[0m\n' || printf '\n\033[31msome checks failed\033[0m\n'
exit $fail
