#!/usr/bin/env bash
#
# Builds the Android app (a Trusted Web Activity wrapping the dashboard).
#
# Run from this directory:   ./build-apk.sh
#
# The signing password is read from the keystore folder and handed to
# bubblewrap through environment variables, so it never appears in a command
# line, a log, or this repository. Nothing here prints it.
#
# WHY THIS SCRIPT EXISTS rather than the password being typed each time: the
# APK has to be rebuilt for every change that should reach an installed
# tablet, and a build nobody can run unattended is a build that stops
# happening.
set -euo pipefail

KEY_DIR="${PFD_SIGNING_DIR:-$HOME/OneDrive/pfd-app-signing}"
KEYSTORE="$KEY_DIR/pfd-orders.keystore"
PASSWORD_FILE="$KEY_DIR/keystore-password.txt"

if [ ! -f "$KEYSTORE" ]; then
  echo "No keystore at $KEYSTORE" >&2
  echo "" >&2
  echo "This is the app signing key. Without the ORIGINAL key, a tablet that" >&2
  echo "already has the app cannot be updated - Android refuses an update" >&2
  echo "signed by a different key, and the only way out is uninstalling and" >&2
  echo "reinstalling on every device. Restore it from OneDrive rather than" >&2
  echo "generating a new one." >&2
  exit 1
fi

if [ ! -f "$PASSWORD_FILE" ]; then
  echo "No password file at $PASSWORD_FILE" >&2
  echo "Set BUBBLEWRAP_KEYSTORE_PASSWORD and BUBBLEWRAP_KEY_PASSWORD instead." >&2
  exit 1
fi

# Read once, into this process only. Not exported to anything but bubblewrap,
# and never echoed.
PW="$(tr -d '\r\n' < "$PASSWORD_FILE")"
export BUBBLEWRAP_KEYSTORE_PASSWORD="$PW"
export BUBBLEWRAP_KEY_PASSWORD="$PW"

# Gradle and the signing tools are called directly rather than through
# `bubblewrap build`. Bubblewrap shells out to a bare "gradlew.bat", which
# this Git Bash environment does not resolve, and it fails before compiling
# anything. Everything below is what bubblewrap would have run.
export JAVA_HOME="${JAVA_HOME:-C:/Program Files/Eclipse Adoptium/jdk-17.0.20.101-hotspot}"
export ANDROID_HOME="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
BUILD_TOOLS="$ANDROID_HOME/build-tools/36.0.0"

./gradlew.bat assembleRelease bundleRelease --no-daemon

UNSIGNED="app/build/outputs/apk/release/app-release-unsigned.apk"
BUNDLE="app/build/outputs/bundle/release/app-release.aab"

# zipalign BEFORE signing, not after: apksigner's signature covers the file
# as-is, and realigning afterwards invalidates it.
"$BUILD_TOOLS/zipalign.exe" -p -f 4 "$UNSIGNED" app-release-signed.apk

"$BUILD_TOOLS/apksigner.bat" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias pfd-orders \
  --ks-pass "pass:$PW" \
  --key-pass "pass:$PW" \
  app-release-signed.apk

"$BUILD_TOOLS/apksigner.bat" verify --print-certs app-release-signed.apk

[ -f "$BUNDLE" ] && cp "$BUNDLE" app-release-bundle.aab

# Versioned copies, named for the MDM console and the GitHub release. The
# code is the one in twa-manifest.json - the same number the shell reports
# on ?shell= and the heartbeat records, so "which build is on that wall"
# and "which file did we upload" are the same number.
CODE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("twa-manifest.json","utf8")).appVersionCode)')"
cp app-release-signed.apk "premium-orders-$CODE.apk"
[ -f app-release-bundle.aab ] && cp app-release-bundle.aab "premium-orders-$CODE.aab"

# What /install.html serves for staff, until the MDM hosts the build.
cp app-release-signed.apk ../public/app/pfd-orders.apk

echo ""
echo "Built:"
ls -1 ./*.apk ./*.aab 2>/dev/null || true
echo ""
echo "premium-orders-$CODE.apk is the file the MDM console uploads (and the"
echo "GitHub release attaches). It is also now public/app/pfd-orders.apk for"
echo "staff-only sideloading from /install.html. The .aab is for the Play"
echo "Store, if it ever goes there. Restaurants never install anything."
