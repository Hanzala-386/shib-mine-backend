import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface User {
  id: string;
  email: string;
  displayName: string;
  referralCode: string;
  referredBy?: string;
  createdAt: number;
}

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  signUp: (email: string, password: string, displayName: string, referralCode?: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  updateUser: (updates: Partial<User>) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function generateId(): string {
  return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

function generateReferralCode(): string {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadUser();
  }, []);

  async function loadUser() {
    try {
      const stored = await AsyncStorage.getItem('shib_current_user');
      if (stored) {
        setUser(JSON.parse(stored));
      }
    } catch (e) {
      console.error('Error loading user', e);
    } finally {
      setIsLoading(false);
    }
  }

  async function signUp(email: string, password: string, displayName: string, referralCode?: string) {
    const allUsersRaw = await AsyncStorage.getItem('shib_all_users');
    const allUsers: Record<string, { email: string; password: string; user: User }> = allUsersRaw ? JSON.parse(allUsersRaw) : {};

    if (allUsers[email.toLowerCase()]) {
      throw new Error('An account with this email already exists.');
    }

    const newUser: User = {
      id: generateId(),
      email: email.toLowerCase(),
      displayName,
      referralCode: generateReferralCode(),
      referredBy: referralCode?.toUpperCase(),
      createdAt: Date.now(),
    };

    allUsers[email.toLowerCase()] = { email: email.toLowerCase(), password, user: newUser };
    await AsyncStorage.setItem('shib_all_users', JSON.stringify(allUsers));
    await AsyncStorage.setItem('shib_current_user', JSON.stringify(newUser));
    setUser(newUser);
  }

  async function signIn(email: string, password: string) {
    const allUsersRaw = await AsyncStorage.getItem('shib_all_users');
    const allUsers: Record<string, { email: string; password: string; user: User }> = allUsersRaw ? JSON.parse(allUsersRaw) : {};

    const record = allUsers[email.toLowerCase()];
    if (!record) throw new Error('No account found with this email.');
    if (record.password !== password) throw new Error('Incorrect password.');

    await AsyncStorage.setItem('shib_current_user', JSON.stringify(record.user));
    setUser(record.user);
  }

  async function signOut() {
    await AsyncStorage.removeItem('shib_current_user');
    setUser(null);
  }

  async function updateUser(updates: Partial<User>) {
    if (!user) return;
    const updated = { ...user, ...updates };

    const allUsersRaw = await AsyncStorage.getItem('shib_all_users');
    const allUsers: Record<string, { email: string; password: string; user: User }> = allUsersRaw ? JSON.parse(allUsersRaw) : {};
    if (allUsers[user.email]) {
      allUsers[user.email].user = updated;
      await AsyncStorage.setItem('shib_all_users', JSON.stringify(allUsers));
    }
    await AsyncStorage.setItem('shib_current_user', JSON.stringify(updated));
    setUser(updated);
  }

  const value = useMemo(() => ({
    user, isLoading, signUp, signIn, signOut, updateUser,
  }), [user, isLoading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
