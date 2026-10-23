#!/bin/sh
# Rebuild the 2013 Twitter for Android (4.1.9) as a client of this instance,
# sign it, and install it on a connected device. The APK is X's and lives
# OUTSIDE this repo (default ~/Projects/xitter-android/4.1.9).
#
# usage: HOST=miikart.co SCHEME=http sh android/build-legacy.sh [--no-install]
set -e

ROOT="$HOME/Projects/xitter-android"
WORK="${WORK:-$ROOT/4.1.9}"
APKTOOL="${APKTOOL:-$ROOT/tools/apktool_3.0.2.jar}"
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
BT="$(ls -d "$SDK"/build-tools/* | tail -1)"
KEYSTORE="${KEYSTORE:-$HOME/.android/debug.keystore}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$WORK/out"

rm -rf "$WORK/unpacked"
java -jar "$APKTOOL" d -f -o "$WORK/unpacked" "$WORK/twitter-4.1.9.apk"

echo "== patching =="
bun "$HERE/patch-legacy.ts" "$WORK/unpacked"

echo "== rebuilding =="
mkdir -p "$OUT"
java -jar "$APKTOOL" b "$WORK/unpacked" -o "$OUT/unsigned.apk"
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "== signing (v1 + v2, so Android 2.3 through 8 accept it) =="
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android --min-sdk-version 9 --out "$OUT/twitter-4.1.9-miikart.apk" "$OUT/aligned.apk"
echo "built $OUT/twitter-4.1.9-miikart.apk"

# the emulator's x86 image has no ARM libraries to load, so its build leaves them
# out (only the photo filters use them)
rm -rf "$WORK/emu" && cp -r "$WORK/unpacked" "$WORK/emu" && rm -rf "$WORK/emu/lib"
java -jar "$APKTOOL" b "$WORK/emu" -o "$OUT/emu-unsigned.apk"
"$BT/zipalign" -f 4 "$OUT/emu-unsigned.apk" "$OUT/emu-aligned.apk"
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android --min-sdk-version 9 --out "$OUT/twitter-4.1.9-miikart-emulator.apk" "$OUT/emu-aligned.apk"
rm -rf "$WORK/emu" "$OUT"/emu-*.apk "$OUT"/*.idsig
echo "built $OUT/twitter-4.1.9-miikart-emulator.apk"

[ "$1" = "--no-install" ] && exit 0
adb install -r "$OUT/twitter-4.1.9-miikart.apk"
