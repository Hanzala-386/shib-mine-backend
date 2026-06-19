---
name: Metro JS bundle verification
description: How to compile-verify JS that touches native modules untestable in the Replit sandbox (Expo Go / web only).
---

# Verifying JS that wraps untestable native modules

When a feature ships only in an EAS APK (native Kotlin/Swift, AdMob, Unity Ads, local Expo modules), the native side cannot run in the Replit sandbox. Only the JS bundle is verifiable here.

**To force Metro to fully compile the app and surface import/transform errors:**

```
curl -s "http://localhost:8081/node_modules/expo-router/entry.bundle?platform=android&dev=true&minify=false" -o /tmp/b.js -w "HTTP %{http_code} size=%{size_download}\n"
```

- The entry is `node_modules/expo-router/entry.bundle` (because `package.json` `"main": "expo-router/entry"`). **`/index.bundle` 404s** — it's the wrong entry for an Expo Router app.
- Swap `platform=android` ↔ `platform=ios`/`web` to check each target.
- HTTP 200 + a multi-MB body = clean compile. On error Metro returns HTTP ~500/404 with a JSON `UnableToResolveError`/`SyntaxError` body — `head -c 400` the file to read it.
- Confirm your new code actually got included: `rg -co "YourSymbol" /tmp/b.js`.

**Why:** native-module features must degrade to safe no-ops off-device (web/iOS/Expo Go). The bundle check + a runtime console line (e.g. settings loaded) is the strongest signal available without an APK build.

**How to apply:** after editing any RN/Expo native-wrapping JS, re-bundle for the relevant platform and grep for your symbols + error markers before claiming success. Real device/Unity/AdMob behavior must be flagged as APK-only and verified separately in EAS.
