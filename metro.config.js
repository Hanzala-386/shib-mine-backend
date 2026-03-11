const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

/**
 * 1. react-native-google-mobile-ads stubs for web:
 *    The SDK imports React Native internals (codegenNativeComponent) that crash
 *    the web bundler. On web we return a no-op stub so the web build succeeds.
 *    Real ads only run on native (via the try-catch in AdContext / nativeAds).
 *
 * 2. @firebase/auth/react-native fix:
 *    Firebase v12 removed the "./react-native" subpath from its package.json
 *    exports map. Metro warns and falls back to file-based resolution, which
 *    also fails because no react-native.js exists at the package root.
 *    - On web:    redirect to an empty stub (the Platform.OS==='web' branch in
 *                 lib/firebase.ts handles auth before this path is ever reached)
 *    - On native: redirect to the actual dist file that exports
 *                 getReactNativePersistence in Firebase v12
 *
 * 3. @iabtcf/core ESM fix:
 *    @iabtcf/core uses explicit .js extensions in imports (e.g. './Vendor.js').
 *    Metro strips extensions and re-appends them, so it can't find the files.
 *    Strip the trailing .js so Metro's resolver works normally.
 *
 * 4. Replit state directory watcher crash fix:
 *    Metro's FallbackWatcher walks all project subdirectories and crashes with
 *    ENOENT if a directory disappears between the walk and the fs.watch() call.
 *    Replit's workflow-logs folder is deleted and recreated on every workflow
 *    restart. Blocking .local/state prevents Metro from ever watching it.
 */
config.resolver.blockList = [
  /[/\\]\.local[/\\]state[/\\]/,
];

const originalResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  /* ── Web stub for Google Mobile Ads ── */
  if (platform === "web" && moduleName === "react-native-google-mobile-ads") {
    return {
      filePath: path.resolve(__dirname, "lib/googleMobileAdsStub.ts"),
      type: "sourceFile",
    };
  }

  /* ── Firebase auth React Native subpath fix ── */
  if (moduleName === "@firebase/auth/react-native") {
    if (platform === "web") {
      return {
        filePath: path.resolve(__dirname, "lib/firebaseAuthRnStub.ts"),
        type: "sourceFile",
      };
    }
    return {
      filePath: path.resolve(
        path.dirname(require.resolve("@firebase/auth/package.json")),
        "dist",
        "rn",
        "index.js"
      ),
      type: "sourceFile",
    };
  }

  /* ── @iabtcf/core .js extension fix ── */
  const resolverFn = originalResolveRequest || context.resolveRequest;
  if (moduleName.endsWith(".js")) {
    try {
      return resolverFn(context, moduleName.slice(0, -3), platform);
    } catch (_) {
      /* fall through */
    }
  }

  return resolverFn(context, moduleName, platform);
};

module.exports = config;
