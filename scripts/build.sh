#!/usr/bin/env bash
# Packages the extension for the Chrome Web Store, Edge Add-ons and addons.mozilla.org.
# The same zip works for all three: manifest.json sits at its root.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(grep -o '"version": *"[^"]*"' extension/manifest.json | grep -o '[0-9][0-9.]*')
mkdir -p dist
out="dist/cleantube-$version.zip"
rm -f "$out"
(cd extension && zip -qr -X "../$out" . -x '.*')
echo "$out"
