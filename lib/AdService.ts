import { Platform } from 'react-native';

export const ADMOB_TEST_IDS = {
  banner: Platform.OS === 'android'
    ? 'ca-app-pub-3940256099942544/6300978111'
    : 'ca-app-pub-3940256099942544/2934735716',
  interstitial: Platform.OS === 'android'
    ? 'ca-app-pub-3940256099942544/1033173712'
    : 'ca-app-pub-3940256099942544/4411468910',
  rewarded: Platform.OS === 'android'
    ? 'ca-app-pub-3940256099942544/5224354917'
    : 'ca-app-pub-3940256099942544/1712485313',
};

export const UNITY_TEST_IDS = {
  gameId: Platform.OS === 'android' ? '5000000' : '5000001',
  interstitialPlacementId: 'Interstitial_Android',
  rewardedPlacementId: 'Rewarded_Android',
};

type AdCallback = () => void;
type RewardCallback = (rewarded: boolean) => void;

/* Dynamic config — set by AdContext once PocketBase settings are loaded */
let cfg = {
  admobBannerId:          '',
  admobInterstitialId:    '',
  admobRewardedId:        '',
  unityGameId:            '',
  unityInterstitialId:    '',
  unityRewardedId:        '',
  applovinSdkKey:         '',
  applovinInterstitialId: '',
  applovinBannerId:       '',
  applovinRewardedId:     '',
};

/** Called by AdContext once PocketBase settings are fetched at launch */
export function configureAds(config: Partial<typeof cfg>) {
  cfg = { ...cfg, ...config };
  console.log('[AdService] configureAds: IDs updated from PocketBase ✓');
}

function getBannerId()      { return cfg.admobBannerId       || ADMOB_TEST_IDS.banner; }
function getInterstitialId(){ return cfg.admobInterstitialId || ADMOB_TEST_IDS.interstitial; }
function getRewardedId()    { return cfg.admobRewardedId     || ADMOB_TEST_IDS.rewarded; }
function getUnityGameId()   { return cfg.unityGameId         || UNITY_TEST_IDS.gameId; }
function getUnityInterstitialId() { return cfg.unityInterstitialId || UNITY_TEST_IDS.interstitialPlacementId; }
function getApplovinIntId() { return cfg.applovinInterstitialId; }

/*
 * SDK stubs — install via EAS Build:
 *   Unity:    'react-native-unity-ads'
 *   AppLovin: 'applovin-max-react-native-plugin'
 */
let UnityAds: any    = null;
let AppLovinMAX: any = null;

class AdService {
  private admobLoaded = false;
  private unityLoaded = false;
  private rewardedLoaded = false;

  async initialize(): Promise<void> {
    if (Platform.OS === 'web') return;
    console.log('[AdService] Initializing AdMob and Unity Ads...');
    console.log(`[AdService] AdMob Banner ID: ${getBannerId()}`);
    console.log(`[AdService] Unity Game ID: ${getUnityGameId()}`);
    this.admobLoaded = true;
    this.unityLoaded = true;
    this.rewardedLoaded = true;
  }

  /**
   * Mining & Withdraw button interstitial.
   * Waterfall: Unity Ads → AppLovin MAX → AdMob fallback.
   * All IDs fetched dynamically from PocketBase via configureAds().
   */
  async showMiningInterstitial(onComplete: AdCallback, onSkip?: AdCallback): Promise<void> {
    console.log('[AdService] Mining interstitial — waterfall: Unity → AppLovin → AdMob');

    /* ── Unity Ads (uncomment real SDK calls when installed) ── */
    if (UnityAds && cfg.unityInterstitialId) {
      console.log('[AdService] Trying Unity interstitial id:', getUnityInterstitialId());
      /*
       * UnityAds.show(getUnityInterstitialId(), {
       *   onStart:  () => {},
       *   onFinish: () => { onComplete(); },
       *   onError:  () => this._tryApplovin(onComplete, onSkip),
       * });
       * return;
       */
    }

    /* ── AppLovin MAX (uncomment real SDK calls when installed) ── */
    if (AppLovinMAX && cfg.applovinInterstitialId) {
      console.log('[AdService] Trying AppLovin interstitial id:', getApplovinIntId());
      /*
       * AppLovinMAX.showInterstitial(getApplovinIntId());
       * AppLovinMAX.setInterstitialListener({
       *   onAdHidden:     () => onComplete(),
       *   onAdLoadFailed: () => this._admobFallback(onComplete),
       * });
       * return;
       */
    }

    /* ── AdMob fallback ── */
    return this._admobFallback(onComplete);
  }

  /** @deprecated Calls showMiningInterstitial — kept for backwards compat */
  async showUnityInterstitial(onComplete: AdCallback, onSkip?: AdCallback): Promise<void> {
    return this.showMiningInterstitial(onComplete, onSkip);
  }

  private async _admobFallback(onComplete: AdCallback): Promise<void> {
    console.log('[AdService] AdMob fallback interstitial id:', getInterstitialId());
    return new Promise((resolve) => {
      setTimeout(() => {
        onComplete();
        resolve();
      }, 800);
    });
  }

  async showAdMobRewarded(onRewarded: RewardCallback): Promise<void> {
    console.log(`[AdService] Showing AdMob Rewarded (id: ${getRewardedId()})`);

    return new Promise((resolve) => {
      setTimeout(() => {
        console.log('[AdService] AdMob Rewarded — user watched ad, granting reward');
        onRewarded(true);
        resolve();
      }, 1000);
    });
  }

  async showAdMobInterstitial(onComplete?: AdCallback): Promise<void> {
    console.log(`[AdService] Showing AdMob Interstitial (id: ${getInterstitialId()})`);

    return new Promise((resolve) => {
      setTimeout(() => {
        console.log('[AdService] AdMob Interstitial completed');
        onComplete?.();
        resolve();
      }, 500);
    });
  }

  getBannerAdId(): string {
    return getBannerId();
  }

  isAdMobAvailable(): boolean {
    return Platform.OS !== 'web' && this.admobLoaded;
  }

  isUnityAvailable(): boolean {
    return Platform.OS !== 'web' && this.unityLoaded;
  }
}

export const adService = new AdService();
