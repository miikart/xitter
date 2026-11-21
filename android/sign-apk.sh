#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
	printf 'usage: sh android/sign-apk.sh <input.apk> <output.apk> <min-sdk>\n' >&2
	exit 1
fi

INPUT="$1"
OUTPUT="$2"
MIN_SDK="$3"
if [ ! -r "$INPUT" ] || [ "$INPUT" = "$OUTPUT" ]; then
	printf 'Input must be a readable APK at a different path from the output: %s\n' "$INPUT" >&2
	exit 1
fi

SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
BT="$(ls -d "$SDK"/build-tools/* | tail -1)"
APKSIGNER="${APKSIGNER:-$BT/apksigner}"
DEBUG_KEYSTORE="$HOME/.android/debug.keystore"
KEYSTORE="${KEYSTORE:-$DEBUG_KEYSTORE}"

set -- --ks "$KEYSTORE" --min-sdk-version "$MIN_SDK" --out "$OUTPUT"
if [ -n "${KEYSTORE_ALIAS:-}" ]; then
	set -- "$@" --ks-key-alias "$KEYSTORE_ALIAS"
fi
if [ -n "${KEYSTORE_PASSWORD_FILE:-}" ]; then
	set -- "$@" --ks-pass "file:$KEYSTORE_PASSWORD_FILE"
elif [ "$KEYSTORE" = "$DEBUG_KEYSTORE" ]; then
	set -- "$@" --ks-pass pass:android
fi

"$APKSIGNER" sign "$@" "$INPUT"
"$APKSIGNER" verify --min-sdk-version "$MIN_SDK" "$OUTPUT"
