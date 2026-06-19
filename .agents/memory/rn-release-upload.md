---
name: RN release-APK file upload
description: Why multipart uploads that work in Expo Go/web fail with "Network request failed" only in the standalone release APK
---

## Rule
For multipart file uploads (e.g. avatar PATCH to PocketBase), DO NOT build a Blob by
`fetch()`-ing a `data:` URI. Use the platform-split pattern:
- **native (Android/iOS):** append the raw file object
  `fd.append(field, { uri: Platform.OS==='android' ? uri : uri.replace('file://',''), name, type: mime || 'image/jpeg' })`
- **web:** `fetch(localUri) -> blob -> fd.append(field, blob, name)` (web FormData needs a real Blob, the `{uri}` object is ignored).
- Never set `Content-Type` manually — XHR/RN must generate the multipart boundary itself.

**Why:** `fetch('data:...')` works in Expo Go and on web, but the **release** Android
build's OkHttp networking stack rejects data: URIs and throws "Network request failed".
Symptom is upload works in dev/Expo Go but fails only on the published APK. Requesting
`base64:true` from ImagePicker just to rebuild a Blob is the smell — drop it and stream
the file URI directly.

**How to apply:** any new device->server binary upload in this app. Also confirms
no app.json change is needed when the endpoint is HTTPS (INTERNET is granted by default;
cleartext/network-security config only matters for HTTP endpoints).
