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

let customAdmobBannerId = '';
let customAdmobInterstitialId = '';
let customAdmobRewardedId = '';
let customUnityGameId = '';
let customUnityInterstitialId = '';

export function configureAds(config: {
  admobBannerId?: string;
  admobInterstitialId?: string;
  admobRewardedId?: string;
  unityGameId?: string;
  unityInterstitialPlacementId?: string;
}) {
  if (config.admobBannerId) customAdmobBannerId = config.admobBannerId;
  if (config.admobInterstitialId) customAdmobInterstitialId = config.admobInterstitialId;
  if (config.admobRewardedId) customAdmobRewardedId = config.admobRewardedId;
  if (config.unityGameId) customUnityGameId = config.unityGameId;
  if (config.unityInterstitialPlacementId) customUnityInterstitialId = config.unityInterstitialPlacementId;
}

function getBannerId() { return customAdmobBannerId || ADMOB_TEST_IDS.banner; }
function getInterstitialId() { return customAdmobInterstitialId || ADMOB_TEST_IDS.interstitial; }
function getRewardedId() { return customAdmobRewardedId || ADMOB_TEST_IDS.rewarded; }
function getUnityGameId() { return customUnityGameId || UNITY_TEST_IDS.gameId; }
function getUnityInterstitialId() { return customUnityInterstitialId || UNITY_TEST_IDS.interstitialPlacementId; }

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

  async showUnityInterstitial(onComplete: AdCallback, onSkip?: AdCallback): Promise<void> {
    console.log(`[AdService] Showing Unity Interstitial (placement: ${getUnityInterstitialId()})`);
    console.log(`[AdService] Unity Game ID: ${getUnityGameId()}`);

    return new Promise((resolve) => {
      setTimeout(() => {
        console.log('[AdService] Unity Interstitial completed');
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
