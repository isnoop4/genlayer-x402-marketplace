#!/usr/bin/env bash
# Real-browser check for injected markup: loads tests/browser/markup.html in
# headless Chromium and prints the page's PASS/FAIL line.
#   CHROME=/path/to/chrome tests/browser/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
chrome="${CHROME:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)}"
if [ -z "$chrome" ]; then echo "no Chromium found; set CHROME=/path/to/chrome"; exit 2; fi
line="$("$chrome" --headless --no-sandbox --disable-gpu --allow-file-access-from-files --virtual-time-budget=3000 --dump-dom "file://$here/markup.html" 2>/dev/null | grep -o '<pre id="result">[^<]*' | sed 's/<pre id="result">//')"
echo "$line"
case "$line" in PASS*) exit 0 ;; *) exit 1 ;; esac
