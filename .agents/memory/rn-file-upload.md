---
name: React Native file upload to PocketBase
description: The only reliable way to upload a file (image) to PocketBase from a React Native / Expo app
---

## Rule
Use `base64: true` in `ImagePicker.launchImageLibraryAsync`, convert base64 → `Uint8Array` → `Blob`, append the Blob to `FormData`, then call `pb.collection('users').update(id, formData)`.

**Why:**
- `{uri, name, type}` FormData file objects: silently dropped by React Native's `fetch` (the PB SDK uses fetch). File bytes never reach the server.
- `XMLHttpRequest` with `{uri, name, type}`: works for `file://` URIs but fails silently for `ph://` PhotoKit URIs on iOS (returned by ImagePicker when `allowsEditing: true` on some iOS versions).
- Proper `Blob` objects: handled correctly by both React Native `fetch` and the PB JS SDK on all platforms — same as uploading from a browser.

**How to apply:**
Any time an image (or file) needs to be uploaded to PocketBase from a React Native / Expo app, always follow this pattern:

```typescript
const result = await ImagePicker.launchImageLibraryAsync({
  ...,
  base64: true,
});
if (!result.canceled && result.assets[0].base64) {
  const { base64: b64, mimeType = 'image/jpeg' } = result.assets[0];
  const chars = atob(b64);
  const bytes = new Uint8Array(chars.length);
  for (let i = 0; i < chars.length; i++) bytes[i] = chars.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType });
  const fd = new FormData();
  fd.append('fieldName', blob, `file_${Date.now()}.${mimeType.split('/')[1]}`);
  const updated = await pb.collection('collection').update(recordId, fd);
}
```
