#!/bin/bash
set -euo pipefail
apk=android/app/build/outputs/apk/release/app-release.apk
aab=android/app/build/outputs/bundle/release/app-release.aab
: "${ANDROID_KEYSTORE_PATH:?Configura ANDROID_KEYSTORE_PATH}"
: "${ANDROID_KEY_ALIAS:?Configura ANDROID_KEY_ALIAS}"
expected="$(keytool -exportcert -keystore "$ANDROID_KEYSTORE_PATH" -storepass:env ANDROID_KEYSTORE_PASSWORD -alias "$ANDROID_KEY_ALIAS" | openssl dgst -sha256 | awk '{print $NF}')"
actual="$("$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --verbose --print-certs "$apk")"
printf '%s\n' "$actual" | grep -F "Signer #1 certificate SHA-256 digest: $expected"
# La chiave nel keystore è anche l'ancora fidata per jarsigner: nessun falso
# successo per un AAB unsigned e nessuna eccezione per certificati inattesi.
jarsigner -J-Duser.language=en -verify -strict -verbose -certs -keystore "$ANDROID_KEYSTORE_PATH" \
  -storepass:env ANDROID_KEYSTORE_PASSWORD "$aab" "$ANDROID_KEY_ALIAS" | grep -F 'jar verified.'
echo 'APK e AAB verificati separatamente con la chiave persistente attesa.'
