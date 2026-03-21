import PocketBase from 'pocketbase';

export const POCKETBASE_URL = 'https://api.webcod.in';

export const pb = new PocketBase(POCKETBASE_URL);

pb.autoCancellation(false);

/* ── PocketBase record shapes (snake_case matches actual PB field names) ── */

export interface PBUser {
  id: string;
  firebase_uid: string;
  email: string;
  display_name: string;
  referral_code: string;
  referred_by?: string;
  referral_balance: number;
  referral_earnings: number;
  shib_balance: number;
  power_tokens: number;
  total_claims: number;
  total_wins: number;
  active_booster_multiplier: number;
  booster_expiry: string;
  fraud_attempts: number;
  is_verified: boolean;
  status: string;
  created: string;
}

export interface PBMiningSession {
  id: string;
  userId: string;
  startTime: string;
  duration: number;
  multiplier: number;
  status: 'mining' | 'ready_to_claim' | 'claimed';
  reward: number;
}

export interface PBSettings {
  id: string;
  miningEntryFee: number;
  baseMiningRate: number;
  boosterCost2x: number;
  boosterCost4x: number;
  boosterCost6x: number;
  boosterCost10x: number;
  admobAppId: string;
  admobBannerId: string;
  admobInterstitialId: string;
  admobRewardedId: string;
  unityGameId: string;
  unityInterstitialPlacementId: string;
  binanceFeePercent: number;
  bep20FlatFee: number;
  minTier1: number;
  minTier2: number;
  minTier3: number;
}

export interface PBTransaction {
  id: string;
  userId: string;
  type: string;
  amount: number;
  currency: string;
  description: string;
  created: string;
}

export class PocketBaseAPI {
  async createUser(data: {
    firebase_uid: string;
    email: string;
    display_name: string;
    referral_code: string;
    referred_by?: string;
  }): Promise<PBUser> {
    try {
      return await pb.collection('users').create({
        ...data,
        shib_balance: 100,
        power_tokens: 500,
        referral_balance: 0,
        referral_earnings: 0,
        total_claims: 0,
        total_wins: 0,
        fraud_attempts: 0,
        is_verified: false,
        status: 'active',
        active_booster_multiplier: 1,
        booster_expiry: '',
      });
    } catch (e: any) {
      if (e?.status === 400 && e?.data?.firebase_uid) {
        return await pb.collection('users').getFirstListItem(`firebase_uid="${data.firebase_uid}"`);
      }
      throw e;
    }
  }

  async getUserByFirebaseUid(firebaseUid: string): Promise<PBUser | null> {
    try {
      return await pb.collection('users').getFirstListItem(`firebase_uid="${firebaseUid}"`);
    } catch {
      return null;
    }
  }

  async updateUser(id: string, data: Partial<PBUser>): Promise<PBUser> {
    return await pb.collection('users').update(id, data);
  }

  async addShib(id: string, amount: number, description: string, type: string): Promise<PBUser> {
    const user = await pb.collection('users').getOne<PBUser>(id);
    const updated = await pb.collection('users').update<PBUser>(id, {
      shib_balance: user.shib_balance + amount,
      total_claims: type === 'mining_claim' ? user.total_claims + 1 : user.total_claims,
    });
    await this.recordTransaction(user.id, type, amount, 'SHIB', description);
    return updated;
  }

  async addPowerTokens(id: string, amount: number, description: string, type: string): Promise<PBUser> {
    const user = await pb.collection('users').getOne<PBUser>(id);
    const updated = await pb.collection('users').update<PBUser>(id, {
      power_tokens: user.power_tokens + amount,
      total_wins: type === 'game_reward' ? user.total_wins + 1 : user.total_wins,
    });
    await this.recordTransaction(user.id, type, amount, 'PT', description);
    return updated;
  }

  async spendPowerTokens(id: string, amount: number, description: string, type: string): Promise<boolean> {
    try {
      const user = await pb.collection('users').getOne<PBUser>(id);
      if (user.power_tokens < amount) return false;
      await pb.collection('users').update(id, { power_tokens: user.power_tokens - amount });
      await this.recordTransaction(user.id, type, -amount, 'PT', description);
      return true;
    } catch {
      return false;
    }
  }

  async recordTransaction(
    userId: string,
    type: string,
    amount: number,
    currency: string,
    description: string,
  ): Promise<void> {
    try {
      await pb.collection('transactions').create({ userId, type, amount, currency, description });
    } catch { }
  }

  async getTransactions(userId: string): Promise<PBTransaction[]> {
    try {
      const res = await pb.collection('transactions').getList<PBTransaction>(1, 50, {
        filter: `userId="${userId}"`,
        sort: '-created',
      });
      return res.items;
    } catch {
      return [];
    }
  }

  async startMiningSession(userId: string, multiplier: number, miningRate: number): Promise<PBMiningSession> {
    await pb.collection('mining_sessions').getList(1, 50, {
      filter: `userId="${userId}" && status="mining"`,
    }).then(async (res) => {
      for (const s of res.items) {
        await pb.collection('mining_sessions').update(s.id, { status: 'claimed' });
      }
    }).catch(() => { });

    return await pb.collection('mining_sessions').create<PBMiningSession>({
      userId,
      startTime: new Date().toISOString(),
      duration: 3600000,
      multiplier,
      status: 'mining',
      reward: Math.floor(miningRate * multiplier),
    });
  }

  async getActiveMiningSession(userId: string): Promise<PBMiningSession | null> {
    try {
      return await pb.collection('mining_sessions').getFirstListItem<PBMiningSession>(
        `userId="${userId}" && (status="mining" || status="ready_to_claim")`
      );
    } catch {
      return null;
    }
  }

  async claimMiningSession(sessionId: string, userId: string, reward: number): Promise<void> {
    await pb.collection('mining_sessions').update(sessionId, { status: 'claimed' });
    await this.addShib(userId, reward, 'Mining session reward', 'mining_claim');

    try {
      const user = await pb.collection('users').getOne<PBUser>(userId);
      if (user.referred_by) {
        const referrer = await pb.collection('users').getFirstListItem<PBUser>(
          `referral_code="${user.referred_by}"`
        );
        if (referrer) {
          const commission = Math.floor(reward * 0.1);
          await pb.collection('users').update(referrer.id, {
            shib_balance: referrer.shib_balance + commission,
            referral_earnings: referrer.referral_earnings + commission,
            referral_balance: referrer.referral_balance + commission,
          });
          await this.recordTransaction(
            referrer.id, 'referral_bonus', commission, 'SHIB',
            `10% referral commission from ${user.display_name}`
          );
        }
      }
    } catch { }
  }

  async getSettings(): Promise<PBSettings | null> {
    try {
      const res = await pb.collection('settings').getList<PBSettings>(1, 1);
      return res.items[0] ?? null;
    } catch {
      return null;
    }
  }

  async updateSettings(id: string, data: Partial<PBSettings>): Promise<PBSettings> {
    return await pb.collection('settings').update<PBSettings>(id, data);
  }

  async getUserByReferralCode(code: string): Promise<PBUser | null> {
    try {
      return await pb.collection('users').getFirstListItem<PBUser>(`referral_code="${code}"`);
    } catch {
      return null;
    }
  }
}

export const pbAPI = new PocketBaseAPI();
