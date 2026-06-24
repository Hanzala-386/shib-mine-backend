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
  gameId: Platform.OS === 'android' ? '6061517' : '6061517',
  interstitialPlacementId: 'Shib_Interstitial_Android',
  rewardedPlacementId: 'Shib_Rewarded_Android',
  bannerPlacementId: 'Shib_Banner_Android',
};

type AdCallback = () => void;
type RewardCallback = (rewarded: boolean) => void;

/* Dynamic config — set by AdContext once PocketBase settings are loaded */
let cfg = {
  yodo1AppKey: '',
  admobBannerId: '',
  admobInterstitialId: '',
  admobRewardedId: '',
  unityGameId: '',
  unityInterstitialId: '',
  unityRewardedId: '',
  applovinSdkKey: '',
  applovinInterstitialId: '',
  applovinBannerId: '',
  applovinRewardedId: '',
};

/** Called by AdContext once PocketBase settings are fetched at launch */
export function configureAds(config: Partial<typeof cfg>) {
  cfg = { ...cfg, ...config };
  console.log('[AdService] configureAds: IDs updated from PocketBase');
}

function getBannerId() { return cfg.admobBannerId || ADMOB_TEST_IDS.banner; }
function getInterstitialId() { return cfg.admobInterstitialId || ADMOB_TEST_IDS.interstitial; }
function getRewardedId() { return cfg.admobRewardedId || ADMOB_TEST_IDS.rewarded; }
function getUnityGameId() { return cfg.unityGameId || UNITY_TEST_IDS.gameId; }
function getUnityInterstitialId() { return cfg.unityInterstitialId || UNITY_TEST_IDS.interstitialPlacementId; }

class AdService {
  private admobLoaded = false;
  private unityLoaded = false;
  private rewardedLoaded = false;

  async initialize(): Promise<void> {
    if (Platform.OS === 'web') return;
    console.log('[AdService] Ad stack ready (Yodo1 primary, Unity fallback)');
    this.admobLoaded = true;
    this.unityLoaded = true;
    this.rewardedLoaded = true;
  }

  async showMiningInterstitial(onComplete: AdCallback, onSkip?: AdCallback): Promise<void> {
    console.log('[AdService] Mining interstitial — delegated to AdContext');
    return new Promise((resolve) => {
      setTimeout(() => { onComplete?.(); resolve(); }, 800);
    });
  }

  async showAdMobRewarded(onRewarded: RewardCallback): Promise<void> {
    console.log('[AdService] Rewarded — delegated to AdContext');
    return new Promise((resolve) => {
      setTimeout(() => { onRewarded(true); resolve(); }, 1000);
    });
  }

  async showAdMobInterstitial(onComplete?: AdCallback): Promise<void> {
    console.log('[AdService] Interstitial — delegated to AdContext');
    return new Promise((resolve) => {
      setTimeout(() => { onComplete?.(); resolve(); }, 500);
    });
  }

  getBannerAdId(): string { return getBannerId(); }
  isAdMobAvailable(): boolean { return Platform.OS !== 'web' && this.admobLoaded; }
  isUnityAvailable(): boolean { return Platform.OS !== 'web' && this.unityLoaded; }
}

export const adService = new AdService();
