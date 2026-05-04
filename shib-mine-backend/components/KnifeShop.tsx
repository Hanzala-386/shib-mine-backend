import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, Image,
  FlatList, ActivityIndicator, Alert, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useWallet } from '@/context/WalletContext';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { getApiUrl } from '@/lib/query-client';
import Colors from '@/constants/colors';

// ── /game route on server maps to public/game/Knife hit Template/ ────────────
const BASE = `${getApiUrl()}/game/`;
const KNIFE_PRICE = 200;

export interface SkinDef {
  id: string;
  name: string;
  uri: string;
  isFree: boolean;
}

export const SKINS: SkinDef[] = [
  { id: 'knife_1',  name: 'Classic',  uri: `${BASE}Knives/Knife.png`,              isFree: true  },
  { id: 'knife_2',  name: 'Blade II', uri: `${BASE}Knives/item%20knife-01.png`,     isFree: false },
  { id: 'knife_3',  name: 'Blade III',uri: `${BASE}Knives/item%20knife-02.png`,     isFree: false },
  { id: 'knife_4',  name: 'Blade IV', uri: `${BASE}Knives/item%20knife-03.png`,     isFree: false },
  { id: 'knife_5',  name: 'Blade V',  uri: `${BASE}Knives/item%20knife-04.png`,     isFree: false },
  { id: 'knife_6',  name: 'Blade VI', uri: `${BASE}Knives/item%20knife-05.png`,     isFree: false },
  { id: 'knife_7',  name: 'Blade VII',uri: `${BASE}Knives/item%20knife-06.png`,     isFree: false },
  { id: 'knife_8',  name: 'Kunai',    uri: `${BASE}Kunai-1.png`,                    isFree: false },
  { id: 'knife_9',  name: 'Blade IX', uri: `${BASE}Knives/item%20knife-07.png`,     isFree: false },
  { id: 'knife_10', name: 'Blade X',  uri: `${BASE}Knives/item%20knife-08.png`,     isFree: false },
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
      Alert.alert('Not enough PT', `You need ${KNIFE_PRICE} Power Tokens.`);
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
      Alert.alert('Purchase failed', e.message || 'Try again.');
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
      <View style={[styles.card, isEquipped && styles.cardEquipped]}>
        {/* Knife image */}
        <View style={styles.imgBox}>
          <Image
            source={{ uri: item.uri }}
            style={styles.knifeImg}
            resizeMode="contain"
          />
          {isLocked && (
            <View style={styles.lockOverlay}>
              <Ionicons name="lock-closed" size={18} color="rgba(255,255,255,0.8)" />
            </View>
          )}
        </View>

        <Text style={styles.skinName} numberOfLines={1}>{item.name}</Text>

        {isEquipped ? (
          <View style={styles.equippedTag}><Text style={styles.equippedTagText}>✓ Equipped</Text></View>
        ) : isOwned ? (
          <Pressable style={styles.equipBtn} onPress={() => onEquip(item.id)}>
            <Text style={styles.equipBtnText}>Equip</Text>
          </Pressable>
        ) : isLocked ? (
          <View style={styles.lockedTag}>
            <Ionicons name="lock-closed" size={9} color={Colors.textMuted} />
            <Text style={styles.lockedTagText}>Locked</Text>
          </View>
        ) : (
          <Pressable
            style={[styles.buyBtn, isBuying && { opacity: 0.6 }]}
            onPress={() => handleBuy(item)}
            disabled={isBuying}
          >
            {isBuying
              ? <ActivityIndicator size="small" color="#000" />
              : <Text style={styles.buyBtnText}>⚡ {KNIFE_PRICE} PT</Text>
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
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>🔪  Knife Shop</Text>
            <Pressable onPress={onClose} hitSlop={14}>
              <Ionicons name="close" size={22} color={Colors.textMuted} />
            </Pressable>
          </View>

          {/* PT balance */}
          <View style={styles.ptRow}>
            <Ionicons name="flash" size={14} color={Colors.gold} />
            <Text style={styles.ptText}>{powerTokens} PT available</Text>
          </View>

          {fetching ? (
            <ActivityIndicator size="large" color={Colors.gold} style={{ marginVertical: 40 }} />
          ) : (
            <FlatList
              data={SKINS}
              renderItem={renderSkin}
              keyExtractor={i => i.id}
              numColumns={3}
              contentContainerStyle={styles.grid}
              scrollEnabled={true}
            />
          )}

          <Text style={styles.seqHint}>Sequential unlock · 200 PT each</Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#0d1a17',
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingTop: 18, paddingBottom: 28,
    borderTopWidth: 1, borderTopColor: 'rgba(244,196,48,0.2)',
    maxHeight: '82%',
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, marginBottom: 10,
  },
  title: { fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.gold },
  ptRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginHorizontal: 20, marginBottom: 14,
    backgroundColor: 'rgba(244,196,48,0.1)',
    paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: 12, borderWidth: 1, borderColor: 'rgba(244,196,48,0.2)',
  },
  ptText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.gold },
  grid: { paddingHorizontal: 10, paddingBottom: 8 },
  card: {
    flex: 1, margin: 5, alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 14, paddingVertical: 12, paddingHorizontal: 6,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)',
    gap: 7,
  },
  cardEquipped: { borderColor: Colors.gold, backgroundColor: 'rgba(244,196,48,0.08)' },
  imgBox: { width: 46, height: 70, alignItems: 'center', justifyContent: 'center', position: 'relative' },
  knifeImg: { width: 46, height: 70 },
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 6, alignItems: 'center', justifyContent: 'center',
  },
  skinName: { fontFamily: 'Inter_600SemiBold', fontSize: 10, color: Colors.text, textAlign: 'center' },
  equippedTag: { backgroundColor: Colors.gold, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  equippedTagText: { fontFamily: 'Inter_700Bold', fontSize: 9, color: '#000' },
  equipBtn: {
    backgroundColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
  equipBtnText: { fontFamily: 'Inter_600SemiBold', fontSize: 10, color: Colors.text },
  buyBtn: { backgroundColor: Colors.gold, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  buyBtnText: { fontFamily: 'Inter_700Bold', fontSize: 10, color: '#000' },
  lockedTag: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  lockedTagText: { fontFamily: 'Inter_500Medium', fontSize: 9, color: Colors.textMuted },
  seqHint: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted, textAlign: 'center', marginTop: 8 },
});
