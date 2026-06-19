---
name: Expo native view import
description: How local Expo modules expose native views in SDK 54, and the requireNativeView alias quirk.
---

# Native views from local Expo modules (SDK 54)

- `expo` re-exports `requireNativeViewManager as requireNativeView`, so `import { requireNativeView } from 'expo'` is valid and is how a local Expo module's `index.ts` wires up a native `View` (e.g. a Unity/AdMob banner).
- `requireOptionalNativeModule` from `expo-modules-core` returns `null` (no throw) when the native module is absent — this is the safe-off-device pattern. Use it (not `requireNativeModule`) in any local module's `index.ts` so web/iOS/Expo Go get a clean no-op instead of a crash.
- The `@/modules/*` path alias resolves via the tsconfig `@/*` baseUrl mapping.

**Why:** native modules only exist in an EAS APK. Importing them unguarded crashes the JS bundle everywhere it's run in the sandbox.

**How to apply:** local Expo native modules must (1) gate availability with `requireOptionalNativeModule`/a platform check, (2) expose the view via `requireNativeView`, and (3) have a JS wrapper whose every method is a no-op when the module is null. Verify with the Metro bundle check (see metro-bundle-verification.md).
