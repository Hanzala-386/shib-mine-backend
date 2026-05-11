import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const MINING_REMINDER_ID_KEY = 'shib_mining_reminder_notif_id';

export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

export async function notifyMiningComplete(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '⚡ Mining Complete!',
        body: 'Your rewards are ready! 🚀 Collect your coins now and start a new session.',
        sound: true,
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[Notifications] Failed to send mining complete:', e);
  }
}

// Schedules a local push notification 24 hours from now reminding the user to claim.
// Cancels any previously scheduled reminder first (idempotent).
export async function scheduleMiningReminder(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;

    // Cancel any existing reminder before scheduling a new one
    await cancelMiningReminder();

    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: '⏳ Rewards Waiting!',
        body: 'Your mining rewards are waiting! Claim them now to start your next session.',
        sound: true,
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 24 * 60 * 60, repeats: false },
    });
    await AsyncStorage.setItem(MINING_REMINDER_ID_KEY, id).catch(() => {});
  } catch (e) {
    console.warn('[Notifications] Failed to schedule mining reminder:', e);
  }
}

// Cancels the 24-hour mining reminder (call on successful claim).
export async function cancelMiningReminder(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const id = await AsyncStorage.getItem(MINING_REMINDER_ID_KEY);
    if (id) {
      await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
      await AsyncStorage.removeItem(MINING_REMINDER_ID_KEY).catch(() => {});
    }
  } catch { /* non-critical */ }
}

// Fires an immediate push when a withdrawal is cancelled by admin.
export async function notifyWithdrawalCancelled(reason?: string): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;
    const body = reason
      ? `Reason: ${reason}`
      : 'Please contact support if you have any questions.';
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '❌ Withdrawal Cancelled',
        body,
        sound: true,
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[Notifications] Failed to send withdrawal cancelled:', e);
  }
}

// Fires an immediate push for a new personal bell-icon notification.
export async function notifyPersonalNotification(title: string, message: string): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body: message,
        sound: true,
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[Notifications] Failed to send personal notification:', e);
  }
}
