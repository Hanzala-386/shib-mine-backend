import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from './AuthContext';
import { pbAPI, type PBTransaction } from '@/lib/pocketbase';

export interface Transaction {
  id: string;
  type: string;
  amount: number;
  currency: 'SHIB' | 'PT';
  description: string;
  timestamp: number;
}

interface WalletContextValue {
  shibBalance: number;
  powerTokens: number;
  transactions: Transaction[];
  isLoading: boolean;
  addShib: (amount: number, description: string, type?: string) => Promise<void>;
  addPowerTokens: (amount: number, description: string, type?: string) => Promise<void>;
  spendPowerTokens: (amount: number, description: string, type?: string) => Promise<boolean>;
  refetch: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

function pbTxToLocal(tx: PBTransaction): Transaction {
  return {
    id: tx.id,
    type: tx.type,
    amount: tx.amount,
    currency: tx.currency as 'SHIB' | 'PT',
    description: tx.description,
    timestamp: new Date(tx.created).getTime(),
  };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const { user, firebaseUser } = useAuth();
  const [shibBalance, setShibBalance] = useState(0);
  const [powerTokens, setPowerTokens] = useState(10);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const pbId = user?.pbId;
  const uid = firebaseUser?.uid;

  useEffect(() => {
    if (pbId || uid) {
      fetchWallet();
    } else {
      setShibBalance(0);
      setPowerTokens(10);
      setTransactions([]);
      setIsLoading(false);
    }
  }, [pbId]);

  async function fetchWallet() {
    setIsLoading(true);
    try {
      if (pbId) {
        const pbUser = await pbAPI.getUserByUid(uid ?? '');
        if (pbUser) {
          setShibBalance(pbUser.shibBalance);
          setPowerTokens(pbUser.powerTokens);
          cacheWallet(pbUser.shibBalance, pbUser.powerTokens);
        }
        const txs = await pbAPI.getTransactions(pbId);
        setTransactions(txs.map(pbTxToLocal));
      } else {
        await loadCache();
      }
    } catch (e) {
      console.warn('[Wallet] PocketBase unavailable, using cache', e);
      await loadCache();
    } finally {
      setIsLoading(false);
    }
  }

  async function loadCache() {
    if (!uid) return;
    try {
      const raw = await AsyncStorage.getItem(`shib_wallet_${uid}`);
      if (raw) {
        const data = JSON.parse(raw);
        setShibBalance(data.shibBalance ?? 0);
        setPowerTokens(data.powerTokens ?? 10);
      } else {
        setPowerTokens(10);
      }
    } catch { }
  }

  function cacheWallet(shib: number, pt: number) {
    if (!uid) return;
    AsyncStorage.setItem(`shib_wallet_${uid}`, JSON.stringify({ shibBalance: shib, powerTokens: pt })).catch(() => { });
  }

  async function addShib(amount: number, description: string, type = 'mining_claim') {
    if (pbId) {
      try {
        const updated = await pbAPI.addShib(pbId, amount, description, type);
        setShibBalance(updated.shibBalance);
        cacheWallet(updated.shibBalance, powerTokens);
        const txs = await pbAPI.getTransactions(pbId);
        setTransactions(txs.map(pbTxToLocal));
        return;
      } catch (e) {
        console.warn('[Wallet] PocketBase addShib failed, using local', e);
      }
    }
    const newShib = shibBalance + amount;
    setShibBalance(newShib);
    cacheWallet(newShib, powerTokens);
  }

  async function addPowerTokens(amount: number, description: string, type = 'game_reward') {
    if (pbId) {
      try {
        const updated = await pbAPI.addPowerTokens(pbId, amount, description, type);
        setPowerTokens(updated.powerTokens);
        cacheWallet(shibBalance, updated.powerTokens);
        const txs = await pbAPI.getTransactions(pbId);
        setTransactions(txs.map(pbTxToLocal));
        return;
      } catch (e) {
        console.warn('[Wallet] PocketBase addPowerTokens failed, using local', e);
      }
    }
    const newPT = powerTokens + amount;
    setPowerTokens(newPT);
    cacheWallet(shibBalance, newPT);
  }

  async function spendPowerTokens(amount: number, description: string, type = 'mining_fee'): Promise<boolean> {
    if (powerTokens < amount) return false;

    if (pbId) {
      try {
        const success = await pbAPI.spendPowerTokens(pbId, amount, description, type);
        if (!success) return false;
        const newPT = powerTokens - amount;
        setPowerTokens(newPT);
        cacheWallet(shibBalance, newPT);
        return true;
      } catch (e) {
        console.warn('[Wallet] PocketBase spendPowerTokens failed, using local', e);
      }
    }
    const newPT = powerTokens - amount;
    setPowerTokens(newPT);
    cacheWallet(shibBalance, newPT);
    return true;
  }

  const value = useMemo(() => ({
    shibBalance, powerTokens, transactions, isLoading,
    addShib, addPowerTokens, spendPowerTokens, refetch: fetchWallet,
  }), [shibBalance, powerTokens, transactions, isLoading, pbId]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
