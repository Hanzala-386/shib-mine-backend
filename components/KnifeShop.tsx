import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, Image,
  FlatList, ActivityIndicator, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useWallet } from '@/context/WalletContext';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { getApiUrl } from '@/lib/query-client';
import Colors from '@/constants/colors';

const BASE = getApiUrl() + '/game/';
const KNIFE_PRICE = 200;

export interface SkinDef {
  id: string;
  name: string;
  uri: string;
  isFree: boolean;
}

export const SKINS: SkinDef[] = [
  { id: 'knife_1', name: 'Classic',  uri: `${BASE}Knives/Knife.png`,           isFree: true  },
  { id: 'knife_2', name: 'Shadow',   uri: `${BASE}Knives/item knife-01.png`,   isFree: false },
  { id: 'knife_3', name: 'Chrome',   uri: `${BASE}Knives/item knife-02.png`,   isFree: false },
  { id: 'knife_4', name: 'Rustic',   uri: `${BASE}Knives/item knife-03.png`,   isFree: false },
  { id: 'knife_5', name: 'Jade',     uri: `${BASE}Knives/item knife-04.png`,   isFree: false },
  { id: 'knife_6', name: 'Kunai',    uri: `${BASE}Kunai-1.png`,                isFree: false },
];

interface KnifeShopProps {
  visible: boolean;
  equippedId: string;
  onClose: () => void;
  onEquip: (skinId: string) => void;
}

export default function KnifeShop({ visible, equippedId, onClose, onEquip }: KnifeShopProps) {
  const { pbUser, refreshBalance } = useAuth();
  const { powerTokens } = useWallet();
  const [purchasedItems, setPurchasedItems] = useState<string[]>(['knife_1']);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const pbId = pbUser?.pbId;

  const loadItems = useCallback(async () => {
    if (!pbId) return;
    setFetching(true);
    try {
      const res = await api.shopGetItems(pbId);
      const items = Array.isArray(res.purchasedItems) ? res.purchasedItems : [];
      setPurchasedItems(['knife_1', ...items.filter((i: string) => i !== 'knife_1')]);
    } catch {
      setPurchasedItems(['knife_1']);
    } finally {
      setFetching(false);
    }
  }, [pbId]);

  useEffect(() => {
    if (visible && pbId) loadItems();
  }, [visible, pbId]);

  async function handleBuy(skin: SkinDef) {
    if (!pbId) return;
    if (powerTokens < KNIFE_PRICE) {
      Alert.alert('Not enough PT', `You need ${KNIFE_PRICE} Power Tokens to unlock this knife.`);
      return;
    }
    const idx = SKINS.findIndex(s => s.id === skin.id);
    if (idx > 0 && !purchasedItems.includes(SKINS[idx - 1].id)) {
      Alert.alert('Locked', `Unlock "${SKINS[idx - 1].name}" first.`);
      return;
    }
    setLoadingId(skin.id);
    try {
      const res = await api.shopBuyKnife(pbId, skin.id);
      const items = Array.isArray(res.purchasedItems) ? res.purchasedItems : [];
      setPurchasedItems(['knife_1', ...items.filter((i: string) => i !== 'knife_1')]);
      await refreshBalance();
      onEquip(skin.id);
    } catch (e: any) {
      Alert.alert('Purchase failed', e.message || 'Please try again.');
    } finally {
      setLoadingId(null);
    }
  }

  function renderSkin({ item, index }: { item: SkinDef; index: number }) {
    const isOwned    = item.isFree || purchasedItems.includes(item.id);
    const isEquipped = equippedId === item.id;
    const prevOwned  = index === 0 || purchasedItems.includes(SKINS[index - 1].id);
    const isLocked   = !isOwned && !prevOwned;
    const isBuying   = loadingId === item.id;

    return (
      <View style={[styles.skinCard, isEquipped && styles.skinCardEquipped]}>
        <View style={styles.skinImgWrap}>
          <Image source={{ uri: item.uri }} style={styles.skinImg} resizeMode="contain" />
          {isLocked && (
            <View style={styles.lockOverlay}>
              <Ionicons name="lock-closed" size={22} color="rgba(255,255,255,0.7)" />
            </View>
          )}
        </View>
        <Text style={styles.skinName}>{item.name}</Text>

        {isEquipped ? (
          <View style={styles.equippedBadge}>
            <Text style={styles.equippedText}>Equipped</Text>
          </View>
        ) : isOwned ? (
          <Pressable style={styles.equipBtn} onPress={() => onEquip(item.id)}>
            <Text style={styles.equipBtnText}>Equip</Text>
          </Pressable>
        ) : isLocked ? (
          <View style={styles.lockedBadge}>
            <Ionicons name="lock-closed" size={11} color={Colors.textMuted} />
            <Text style={styles.lockedText}>Locked</Text>
          </View>
        ) : (
          <Pressable
            style={[styles.buyBtn, isBuying && { opacity: 0.6 }]}
            onPress={() => handleBuy(item)}
            disabled={isBuying}
          >
            {isBuying
              ? <ActivityIndicator size="small" color="#000" />
              : <>
                  <Ionicons name="flash" size={12} color="#000" />
                  <Text style={styles.buyBtnText}>{KNIFE_PRICE} PT</Text>
                </>
            }
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" transparent presentationStyle="overFullScreen">
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Ionicons name="storefront" size={22} color={Colors.gold} />
            <Text style={styles.title}>Knife Shop</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={24} color={Colors.textMuted} />
            </Pressable>
          </View>

          <View style={styles.ptBar}>
            <Ionicons name="flash" size={14} color={Colors.gold} />
            <Text style={styles.ptText}>{powerTokens} PT available</Text>
          </View>

          {fetching ? (
            <ActivityIndicator size="large" color={Colors.gold} style={{ marginTop: 40 }} />
          ) : (
            <FlatList
              data={SKINS}
              renderItem={renderSkin}
              keyExtractor={i => i.id}
              numColumns={3}
              contentContainerStyle={styles.grid}
              scrollEnabled={false}
            />
          )}

          <Text style={styles.hint}>Knives must be unlocked in order</Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#120800',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 20,
    paddingBottom: 32,
    borderTopWidth: 1,
    borderTopColor: 'rgba(244,196,48,0.2)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    gap: 10,
    marginBottom: 12,
  },
  title: {
    flex: 1,
    fontFamily: 'Inter_700Bold',
    fontSize: 20,
    color: Colors.gold,
  },
  ptBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 20,
    marginBottom: 16,
    backgroundColor: 'rgba(244,196,48,0.1)',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.2)',
  },
  ptText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 14,
    color: Colors.gold,
  },
  grid: {
    paddingHorizontal: 12,
    gap: 10,
  },
  skinCard: {
    flex: 1,
    margin: 6,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    gap: 8,
  },
  skinCardEquipped: {
    borderColor: Colors.gold,
    backgroundColor: 'rgba(244,196,48,0.08)',
  },
  skinImgWrap: {
    width: 52,
    height: 72,
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  skinImg: {
    width: 52,
    height: 72,
  },
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skinName: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 11,
    color: Colors.text,
    textAlign: 'center',
  },
  equippedBadge: {
    backgroundColor: Colors.gold,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  equippedText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 10,
    color: '#000',
  },
  equipBtn: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  equipBtnText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 11,
    color: Colors.text,
  },
  buyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: Colors.gold,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  buyBtnText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 11,
    color: '#000',
  },
  lockedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  lockedText: {
    fontFamily: 'Inter_500Medium',
    fontSize: 10,
    color: Colors.textMuted,
  },
  hint: {
    fontFamily: 'Inter_400Regular',
    fontSize: 11,
    color: Colors.textMuted,
    textAlign: 'center',
    marginTop: 8,
  },
});
