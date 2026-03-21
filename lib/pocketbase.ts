import PocketBase from 'pocketbase';

export const POCKETBASE_URL = 'https://api.webcod.in';

export const pb = new PocketBase(POCKETBASE_URL);

pb.autoCancellation(false);

export interface PBUser {
  id: string;
  uid: string;
  email: string;
  username: string;
  displayName: string;
  referralCode: string;
  referredBy?: string;
  shibBalance: number;
  powerTokens: number;
  totalClaims: number;
  totalWins: number;
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
    uid: string;
    email: string;
    username: string;
    displayName: string;
    referralCode: string;
    referredBy?: string;
  }): Promise<PBUser> {
    try {
      return await pb.collection('users').create({
        ...data,
        shibBalance: 0,
        powerTokens: 10,
        totalClaims: 0,
        totalWins: 0,
      });
    } catch (e: any) {
      if (e?.status === 400 && e?.data?.uid) {
        return await pb.collection('users').getFirstListItem(`uid="${data.uid}"`);
      }
      throw e;
    }
  }

  async getUserByUid(uid: string): Promise<PBUser | null> {
    try {
      return await pb.collection('users').getFirstListItem(`uid="${uid}"`);
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
      shibBalance: user.shibBalance + amount,
      totalClaims: type === 'mining_claim' ? user.totalClaims + 1 : user.totalClaims,
    });
    await this.recordTransaction(user.id, type, amount, 'SHIB', description);
    return updated;
  }

  async addPowerTokens(id: string, amount: number, description: string, type: string): Promise<PBUser> {
    const user = await pb.collection('users').getOne<PBUser>(id);
    const updated = await pb.collection('users').update<PBUser>(id, {
      powerTokens: user.powerTokens + amount,
      totalWins: type === 'game_reward' ? user.totalWins + 1 : user.totalWins,
    });
    await this.recordTransaction(user.id, type, amount, 'PT', description);
    return updated;
  }

  async spendPowerTokens(id: string, amount: number, description: string, type: string): Promise<boolean> {
    try {
      const user = await pb.collection('users').getOne<PBUser>(id);
      if (user.powerTokens < amount) return false;
      await pb.collection('users').update(id, { powerTokens: user.powerTokens - amount });
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
      if (user.referredBy) {
        const referrer = await pb.collection('users').getFirstListItem<PBUser>(
          `referralCode="${user.referredBy}"`
        );
        if (referrer) {
          const commission = Math.floor(reward * 0.1);
          await pb.collection('users').update(referrer.id, {
            shibBalance: referrer.shibBalance + commission,
          });
          await this.recordTransaction(
            referrer.id, 'referral_bonus', commission, 'SHIB',
            `10% referral commission from ${user.username}`
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
      return await pb.collection('users').getFirstListItem<PBUser>(`referralCode="${code}"`);
    } catch {
      return null;
    }
  }
}

export const pbAPI = new PocketBaseAPI();
