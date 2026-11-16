#!/usr/bin/env bash
# Build "Harness Local" for this deployment, where port 8088 serves it.
#
#   scripts/build-local-apk.sh
#
# Everything the phone needs is compiled in: the API origin, local mode, and the pair host. A build
# that misses one of them is the cloud app wearing a local icon — sign-in goes to autonomous.ai,
# the pair QR reads as nothing at all, and no session ever loads. So the result is checked, not
# trusted: the API origin has to be findable in the ARM snapshot, and the package id and name are
# printed. The `.local` id suffix keeps it beside the Play app instead of fighting it for one slot.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
api=${HARNESS_API_BASE_URL:-http://10.126.126.10:8085}
pair_host=${HARNESS_LOCAL_PAIR_HOST:-10.126.126.10}
flutter_bin=${FLUTTER:-$HOME/opt/flutter347/flutter/bin/flutter}
aapt2=${AAPT2:-$HOME/Android/Sdk/build-tools/36.0.0/aapt2}
apk="$root/mobile/build/app/outputs/flutter-apk/app-release.apk"

cd "$root/mobile"
"$flutter_bin" build apk --release \
  --android-project-arg=harnessIdSuffix=.local \
  --dart-define="HARNESS_API_BASE_URL=$api" \
  --dart-define=HARNESS_LOCAL_MODE=true \
  --dart-define="HARNESS_LOCAL_PAIR_HOST=$pair_host"

origin=${api#*://}
snapshot=$(mktemp)
badging=$(mktemp)
trap 'find "$snapshot" "$badging" -delete' EXIT
unzip -p "$apk" lib/arm64-v8a/libapp.so > "$snapshot"
# ⚠️ Read the snapshot from the file, not a pipe: `... | strings | rg -q` makes rg exit at the
# first match, strings die of SIGPIPE, and pipefail turns a hit into a failure.
if ! strings -a "$snapshot" | rg -q -F "$origin"; then
  echo "FAIL: $apk does not carry the API origin $origin" >&2
  echo "      that is the cloud build: local mode did not compile in. Not serving it." >&2
  exit 1
fi

digest=$(sha256sum "$apk" | cut -d' ' -f1)
"$aapt2" dump badging "$apk" > "$badging"
rg '^package:|^application-label:' "$badging"
APK_SHA256="$digest" APK_API="$api" APK_PAIR_HOST="$pair_host" \
  APK_INFO_PATH="${apk%.apk}-info.json" node "$root/scripts/apk-info.mjs" > /dev/null
echo "sha256 $digest"
echo
echo "served at http://$pair_host:8088/harness.apk"
