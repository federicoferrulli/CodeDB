#!/bin/bash
set -euo pipefail
directory="${1:-dist}"
: "${APPLE_TEAM_ID:?Configura APPLE_TEAM_ID}"
temp="$(mktemp -d "${TMPDIR:-/tmp}/codedb-verifica.XXXXXX")"
mounted=false
cleanup() {
  if [ "$mounted" = true ]; then hdiutil detach "$temp/mount" -quiet; fi
  rm -rf "$temp"
}
trap cleanup EXIT
verifica_app() {
  codesign --verify --deep --strict --verbose=2 "$1"
  codesign -dvv "$1" 2>&1 | grep -F "TeamIdentifier=$APPLE_TEAM_ID"
  codesign -dvv "$1" 2>&1 | grep -E 'flags=.*runtime'
  xcrun stapler validate "$1"
  spctl --assess --type execute --verbose=2 "$1"
}
shopt -s nullglob
zips=("$directory"/*.zip)
dmgs=("$directory"/*.dmg)
[ "${#zips[@]}" -gt 0 ] && [ "${#dmgs[@]}" -gt 0 ]
for zip in "${zips[@]}"; do
  mkdir "$temp/zip"
  ditto -x -k "$zip" "$temp/zip"
  verifica_app "$temp/zip/CodeDB.app"
  rm -rf "$temp/zip"
done
for dmg in "${dmgs[@]}"; do
  codesign --verify --strict --verbose=2 "$dmg"
  mkdir -p "$temp/mount"
  hdiutil attach "$dmg" -readonly -nobrowse -mountpoint "$temp/mount" -quiet
  mounted=true
  verifica_app "$temp/mount/CodeDB.app"
  hdiutil detach "$temp/mount" -quiet
  mounted=false
done
echo 'Firma Developer ID, Hardened Runtime, ticket e Gatekeeper verificati negli archivi finali.'
