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
HOST="${HOST:-miikart.co}"
SCHEME="${SCHEME:-http}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$WORK/out"
APK="${OUTPUT:-$OUT/twitter-4.1.9-miikart.apk}"

export HOST SCHEME ANDROID_HOME="$SDK" APKTOOL

rm -rf "$WORK/unpacked"
java -jar "$APKTOOL" d -f -o "$WORK/unpacked" "$WORK/twitter-4.1.9.apk"

echo "== patching ($SCHEME://$HOST) =="
bun "$HERE/patch-legacy.ts" "$WORK/unpacked"

echo "== rebuilding =="
mkdir -p "$OUT"
java -jar "$APKTOOL" b "$WORK/unpacked" -o "$OUT/unsigned.apk"
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "== signing (v1 + v2, so Android 2.3 through 8 accept it) =="
sh "$HERE/sign-apk.sh" "$OUT/aligned.apk" "$APK" 9
echo "built $APK"

[ "$1" = "--no-install" ] && exit 0
if [ -n "$ADB_SERIAL" ]; then
	adb -s "$ADB_SERIAL" install -r "$APK"
else
	adb install -r "$APK"
fi
