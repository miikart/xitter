#!/bin/sh
set -eu

ROOT="$HOME/Projects/xitter-android"
HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
BT="$(ls -d "$SDK"/build-tools/* | tail -1)"
APKTOOL="${APKTOOL:-$ROOT/tools/apktool_3.0.2.jar}"
INPUT="${1:-$ROOT/6.17.0/out/twitter-6.17.0-miikart-pixel-fcm-registration.apk}"
OUTPUT="${2:-$ROOT/6.17.0/out/twitter-6.17.0-miikart-pixel-no-connection-notif.apk}"

WORK="$(mktemp -d)"
trap 'rm -r "$WORK"' EXIT
unzip -p "$INPUT" classes4.dex > "$WORK/classes.dex"
jar cf "$WORK/dex.apk" -C "$WORK" classes.dex
java -jar "$APKTOOL" d --no-res -o "$WORK/decoded" "$WORK/dex.apk"
bun "$HERE/patch-6.17-push.ts" "$WORK/decoded/smali"
java -jar "$APKTOOL" b --no-apk "$WORK/decoded"
cp "$WORK/decoded/build/apk/classes.dex" "$WORK/classes4.dex"

cp "$INPUT" "$WORK/unsigned.apk"
zip -qd "$WORK/unsigned.apk" 'META-INF/*.SF' 'META-INF/*.RSA' 'META-INF/*.DSA' 'META-INF/*.EC' 'META-INF/MANIFEST.MF'
(cd "$WORK" && zip -q unsigned.apk classes4.dex)
"$BT/zipalign" -P 16 -f 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"
sh "$HERE/sign-apk.sh" "$WORK/aligned.apk" "$WORK/signed.apk" 16
cp "$WORK/signed.apk" "$OUTPUT"
printf 'built %s\n' "$OUTPUT"
