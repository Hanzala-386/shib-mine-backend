import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from './AuthContext';

export interface Transaction {
  id: string;
  type: 'mining_claim' | 'game_reward' | 'booster_purchase' | 'referral_bonus' | 'mining_fee';
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
  addShib: (amount: number, description: string, type?: Transaction['type']) => Promise<void>;
  addPowerTokens: (amount: number, description: string, type?: Transaction['type']) => Promise<void>;
  spendPowerTokens: (amount: number, description: string, type?: Transaction['type']) => Promise<boolean>;
  refetch: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

function generateId(): string {
  return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const { firebaseUser } = useAuth();
  const [shibBalance, setShibBalance] = useState(0);
  const [powerTokens, setPowerTokens] = useState(10);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);

  const uid = firebaseUser?.uid;
  const storageKey = uid ? `shib_wallet_${uid}` : null;

  useEffect(() => {
    if (uid) {
      setInitialized(false);
      loadWallet();
    } else {
      setShibBalance(0);
      setPowerTokens(10);
      setTransactions([]);
    }
  }, [uid]);

  async function loadWallet() {
    if (!storageKey) return;
    try {
      const raw = await AsyncStorage.getItem(storageKey);
      if (raw) {
        const data = JSON.parse(raw);
        setShibBalance(data.shibBalance ?? 0);
        setPowerTokens(data.powerTokens ?? 10);
        setTransactions(data.transactions ?? []);
        setInitialized(true);
      } else {
        setShibBalance(0);
        setPowerTokens(10);
        setTransactions([]);
        setInitialized(true);
        await AsyncStorage.setItem(storageKey, JSON.stringify({ shibBalance: 0, powerTokens: 10, transactions: [] }));
      }
    } catch (e) {
      console.error('Error loading wallet', e);
    } finally {
      setIsLoading(false);
    }
  }

  async function saveWallet(shib: number, pt: number, txs: Transaction[]) {
    if (!storageKey) return;
    await AsyncStorage.setItem(storageKey, JSON.stringify({ shibBalance: shib, powerTokens: pt, transactions: txs }));
  }

  async function addShib(amount: number, description: string, type: Transaction['type'] = 'mining_claim') {
    const tx: Transaction = { id: generateId(), type, amount, currency: 'SHIB', description, timestamp: Date.now() };
    const newShib = shibBalance + amount;
    const newTxs = [tx, ...transactions].slice(0, 100);
    setShibBalance(newShib);
    setTransactions(newTxs);
    await saveWallet(newShib, powerTokens, newTxs);
  }

  async function addPowerTokens(amount: number, description: string, type: Transaction['type'] = 'game_reward') {
    const tx: Transaction = { id: generateId(), type, amount, currency: 'PT', description, timestamp: Date.now() };
    const newPT = powerTokens + amount;
    const newTxs = [tx, ...transactions].slice(0, 100);
    setPowerTokens(newPT);
    setTransactions(newTxs);
    await saveWallet(shibBalance, newPT, newTxs);
  }

  async function spendPowerTokens(amount: number, description: string, type: Transaction['type'] = 'booster_purchase'): Promise<boolean> {
    if (powerTokens < amount) return false;
    const tx: Transaction = { id: generateId(), type, amount: -amount, currency: 'PT', description, timestamp: Date.now() };
    const newPT = powerTokens - amount;
    const newTxs = [tx, ...transactions].slice(0, 100);
    setPowerTokens(newPT);
    setTransactions(newTxs);
    await saveWallet(shibBalance, newPT, newTxs);
    return true;
  }

  const refetch = loadWallet;

  const value = useMemo(() => ({
    shibBalance, powerTokens, transactions, isLoading,
    addShib, addPowerTokens, spendPowerTokens, refetch,
  }), [shibBalance, powerTokens, transactions, isLoading]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
