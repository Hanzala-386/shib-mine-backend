---
name: Expo/Metro dev server recovery
description: Why the Start Frontend workflow gets stuck and how to actually recover the web preview.
---

# Start Frontend stuck / web preview frozen on "Your app is starting"

## EADDRINUSE on :8081
- Symptom: the Replit preview pane is frozen on the "Your app is starting"
  spinner, and the `Start Frontend` workflow log ends with
  `Error: listen EADDRINUSE: address already in use 0.0.0.0:8081`.
- Cause: a previous Metro process is still bound to 8081 (orphaned after a crash
  or an interrupted restart). The "Your app is starting" overlay is a Replit-side
  indicator that clears only once Metro actually serves the app.
- **Fix order matters:** `restart_workflow` alone may NOT free an orphaned port
  (the new process dies on bind before the old one is reaped). First kill the
  orphan, then restart:
  1. `fuser -k 8081/tcp` (then re-check it's free)
  2. `restart_workflow({ name: "Start Frontend" })`
- Verify recovery without relying on a screenshot: the log should show
  `Web Bundled … modules`, and `curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/`
  returns 200 with an HTML shell containing `<title>Shiba Hit</title>` + `id="root"`.

## Blank/white web preview is often NOT a real break
- This app gates the whole tree on fonts + an auth/announcement boot splash, and
  every inner screen (home, wallet, etc.) wraps content in
  `Animated.View entering={FadeInDown…}` (reanimated). Reanimated **layout/entering
  animations do not paint on react-native-web**, so inner screens can capture as
  blank in the preview even though the JS is running fine.
- Before assuming a crash: check the browser console (clean = no ErrorBoundary
  trigger, providers loaded) and the served HTTP 200 shell. The real target is the
  Android APK, where these animations render normally.
- The auth screen was deliberately switched to RN's built-in `Animated` (not
  reanimated `entering`) precisely so it stays visible on web.
