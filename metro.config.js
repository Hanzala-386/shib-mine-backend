const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

/**
 * 1. react-native-google-mobile-ads stubs for web:
 *    The SDK imports React Native internals (codegenNativeComponent) that crash
 *    the web bundler. On web we return a no-op stub so the web build succeeds.
 *    Real ads only run on native (via the try-catch in AdContext / nativeAds).
 *
 * 2. @iabtcf/core ESM fix:
 *    @iabtcf/core uses explicit .js extensions in imports (e.g. './Vendor.js').
 *    Metro strips extensions and re-appends them, so it can't find the files.
 *    Strip the trailing .js so Metro's resolver works normally.
 */
const originalResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  /* ── Web stub for Google Mobile Ads ── */
  if (platform === "web" && moduleName === "react-native-google-mobile-ads") {
    return {
      filePath: path.resolve(__dirname, "lib/googleMobileAdsStub.ts"),
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
