'use strict';

/* =========================================================================
 * KATALOG SHOP — single source of truth untuk semua item yang bisa dibeli
 * lewat /shop-buy. Pola file ini SENGAJA mengikuti tradingAssets.js: data
 * statis + helper murni di sini, logic Redis/eksekusi tetap di tempat lain
 * (lib/trading.js / lib/commands/trading/shop.js) — supaya "apa syaratnya"
 * tetap terpisah dari "bagaimana caranya dieksekusi".
 *
 * PRINSIP MONEY SINK: SEMUA item di sini PERMANEN begitu dibeli — tidak
 * ada mekanisme jual balik (tidak seperti aset trading NORA/VOLT/KRYN/
 * PLUM). ZYC yang dipakai checkout benar-benar lenyap dari peredaran
 * (adjustBalance saja, TIDAK pernah adjustBalance ke pihak lain).
 *
 * type menentukan KE HASH REDIS MANA item disimpan saat checkout:
 *   'consumable' -> trading:inventory:{userId}  (hincrby, berkurang saat dipakai)
 *   'luxury'     -> trading:inventory:{userId}  (hincrby, permanen, tidak pernah berkurang)
 *   'equipable'  -> trading:cosmetics:{userId}  (hset, slot tunggal per kategori kosmetik)
 *
 * requiresDebtFree / minReserveCash / requiredItems / requiredCategories
 * SEMUA optional — item tanpa syarat berarti "bebas dibeli asal cash cukup".
 * Validasinya sendiri (bukan datanya) hidup di validateShopPurchase() di
 * bawah, murni function tanpa I/O supaya gampang di-unit-test manual
 * (node -e) sebelum disambungkan ke Redis di command layer.
 * ========================================================================= */

const SHOP_ITEMS = {
  /* ----------------------------------------------------------------------
   * A. UTILITAS & CONSUMABLES
   * -------------------------------------------------------------------- */
  LEAK_TOKEN: {
    id: 'LEAK_TOKEN',
    name: '🕵️ Sinyal Orang Dalam',
    price: 5000,
    category: 'utility',
    type: 'consumable',
  },

  /* ----------------------------------------------------------------------
   * B. KOSMETIK PROFIL (Social Flexing)
   * -------------------------------------------------------------------- */
  COLOR_GOLD: {
    id: 'COLOR_GOLD',
    name: '🎨 Tema Eclair Gold',
    price: 15000,
    category: 'cosmetic',
    type: 'equipable',
    cosmeticSlot: 'color',
    cosmeticValue: 'f1c40f',
  },
  COLOR_NEON: {
    id: 'COLOR_NEON',
    name: '🎨 Tema Cyber Neon',
    price: 15000,
    category: 'cosmetic',
    type: 'equipable',
    cosmeticSlot: 'color',
    cosmeticValue: '00ffe1',
  },
  TITLE_WHALE: {
    id: 'TITLE_WHALE',
    name: '🐋 Gelar: Zypto Whale',
    price: 25000,
    category: 'cosmetic',
    type: 'equipable',
    cosmeticSlot: 'title',
    cosmeticValue: '🐋 Zypto Whale',
  },
  TITLE_SURVIVOR: {
    id: 'TITLE_SURVIVOR',
    name: '📉 Gelar: Bear Market Survivor',
    price: 25000,
    category: 'cosmetic',
    type: 'equipable',
    cosmeticSlot: 'title',
    cosmeticValue: '📉 Bear Market Survivor',
  },

  /* ----------------------------------------------------------------------
   * C. SUPERCAR & HYPERCAR
   * -------------------------------------------------------------------- */
  LAMBORGHINI_HURACAN: {
    id: 'LAMBORGHINI_HURACAN',
    name: '🚗 Lamborghini Huracán',
    price: 800000,
    category: 'supercar',
    type: 'luxury',
  },
  LAMBORGHINI_REVUELTO: {
    id: 'LAMBORGHINI_REVUELTO',
    name: '🚗 Lamborghini Revuelto',
    price: 1500000,
    category: 'supercar',
    type: 'luxury',
  },
  FERRARI_ROMA: {
    id: 'FERRARI_ROMA',
    name: '🏎️ Ferrari Roma',
    price: 900000,
    category: 'supercar',
    type: 'luxury',
    requiresDebtFree: true,
  },
  FERRARI_LAFERRARI: {
    id: 'FERRARI_LAFERRARI',
    name: '🏎️ Ferrari LaFerrari',
    price: 3000000,
    category: 'supercar',
    type: 'luxury',
    requiresDebtFree: true,
    requiredItems: ['FERRARI_ROMA'],
  },
  FERRARI_F80: {
    id: 'FERRARI_F80',
    name: '🏎️ Ferrari F80',
    price: 4500000,
    category: 'supercar',
    type: 'luxury',
    requiresDebtFree: true,
    requiredItems: ['FERRARI_ROMA'],
  },
  BUGATTI_CHIRON: {
    id: 'BUGATTI_CHIRON',
    name: '🏎️ Bugatti Chiron',
    price: 6000000,
    category: 'supercar',
    type: 'luxury',
    requiresDebtFree: true,
    minReserveCash: 0.15,
  },
  PAGANI_HUAYRA: {
    id: 'PAGANI_HUAYRA',
    name: '🏎️ Pagani Huayra',
    price: 7000000,
    category: 'supercar',
    type: 'luxury',
    requiresDebtFree: true,
    requiredCategories: ['property', 'fleet'],
  },
  KOENIGSEGG_JESKO: {
    id: 'KOENIGSEGG_JESKO',
    name: '🏎️ Koenigsegg Jesko',
    price: 7500000,
    category: 'supercar',
    type: 'luxury',
    requiresDebtFree: true,
    requiredCategories: ['property', 'fleet'],
  },

  /* ----------------------------------------------------------------------
   * D. SUPERBIKE / FLAGSHIP MOTORCYCLES
   * -------------------------------------------------------------------- */
  KAWASAKI_ZX25R: {
    id: 'KAWASAKI_ZX25R',
    name: '🏍️ Kawasaki ZX-25R',
    price: 60000,
    category: 'superbike',
    type: 'luxury',
  },
  HONDA_CBR1000RRR: {
    id: 'HONDA_CBR1000RRR',
    name: '🏍️ Honda CBR1000RR-R',
    price: 65000,
    category: 'superbike',
    type: 'luxury',
  },
  YAMAHA_R1: {
    id: 'YAMAHA_R1',
    name: '🏍️ Yamaha R1',
    price: 70000,
    category: 'superbike',
    type: 'luxury',
  },
  KAWASAKI_H2R: {
    id: 'KAWASAKI_H2R',
    name: '🏍️ Kawasaki Ninja H2R',
    price: 250000,
    category: 'superbike',
    type: 'luxury',
    requiresDebtFree: true,
    minReserveCash: 0.20,
    requiredItems: ['KAWASAKI_ZX25R', 'HONDA_CBR1000RRR', 'YAMAHA_R1'],
    requiredItemsMode: 'any',
  },
  HONDA_RC213VS: {
    id: 'HONDA_RC213VS',
    name: '🏍️ Honda RC213V-S',
    price: 400000,
    category: 'superbike',
    type: 'luxury',
    requiresDebtFree: true,
    requiredItems: ['HONDA_CBR1000RRR'],
  },
  YAMAHA_R1M: {
    id: 'YAMAHA_R1M',
    name: '🏍️ Yamaha R1M',
    price: 380000,
    category: 'superbike',
    type: 'luxury',
    requiresDebtFree: true,
    requiredItems: ['YAMAHA_R1'],
  },
  DUCATI_PANIGALE_V4S: {
    id: 'DUCATI_PANIGALE_V4S',
    name: '🏍️ Ducati Panigale V4 S',
    price: 300000,
    category: 'superbike',
    type: 'luxury',
  },
  DUCATI_SUPERLEGGERA_V4: {
    id: 'DUCATI_SUPERLEGGERA_V4',
    name: '🏍️ Ducati Superleggera V4',
    price: 900000,
    category: 'superbike',
    type: 'luxury',
    requiresDebtFree: true,
    requiredItems: ['DUCATI_PANIGALE_V4S'],
    requiredCategories: ['property'],
  },

  /* ----------------------------------------------------------------------
   * E. MOTORSPORT & RACE CARS
   * -------------------------------------------------------------------- */
  RALLY_LEGEND_WRC: {
    id: 'RALLY_LEGEND_WRC',
    name: '🏁 Rally Legend (WRC Classic)',
    price: 200000,
    category: 'motorsport',
    type: 'luxury',
  },
  FERRARI_FXXK: {
    id: 'FERRARI_FXXK',
    name: '🏁 Ferrari FXX-K',
    price: 5000000,
    category: 'motorsport',
    type: 'luxury',
    requiresDebtFree: true,
    requiredCategories: ['property'],
    minReserveCash: 0.20,
  },
  ASTON_MARTIN_VULCAN: {
    id: 'ASTON_MARTIN_VULCAN',
    name: '🏁 Aston Martin Vulcan',
    price: 5200000,
    category: 'motorsport',
    type: 'luxury',
    requiresDebtFree: true,
    requiredCategories: ['property'],
    minReserveCash: 0.20,
  },
  PAGANI_ZONDA_R: {
    id: 'PAGANI_ZONDA_R',
    name: '🏁 Pagani Zonda R',
    price: 5500000,
    category: 'motorsport',
    type: 'luxury',
    requiresDebtFree: true,
    requiredCategories: ['property'],
    minReserveCash: 0.20,
  },
  F1_CLASSIC_GP_CAR: {
    id: 'F1_CLASSIC_GP_CAR',
    name: '🏁 F1 Classic Grand Prix Car',
    price: 15000000,
    category: 'motorsport',
    type: 'luxury',
    requiresDebtFree: true,
    requiredItems: ['FERRARI_LAFERRARI', 'FERRARI_F80', 'BUGATTI_CHIRON', 'PAGANI_HUAYRA', 'KOENIGSEGG_JESKO'],
    requiredItemsMode: 'any',
  },

  /* ----------------------------------------------------------------------
   * F. PROPERTI, REAL ESTATE, & FLEET MEWAH
   * -------------------------------------------------------------------- */
  PENTHOUSE: {
    id: 'PENTHOUSE',
    name: '🏙️ Penthouse Pusat Kota',
    price: 500000,
    category: 'property',
    type: 'luxury',
  },
  SUPER_YACHT: {
    id: 'SUPER_YACHT',
    name: '🛥️ Super Yacht',
    price: 2000000,
    category: 'fleet',
    type: 'luxury',
    requiresDebtFree: true,
    minReserveCash: 0.10,
  },
  PRIVATE_JET: {
    id: 'PRIVATE_JET',
    name: '✈️ Private Jet',
    price: 10000000,
    category: 'fleet',
    type: 'luxury',
    requiresDebtFree: true,
    requiredCategories: ['property'],
  },
  EUROPEAN_CASTLE: {
    id: 'EUROPEAN_CASTLE',
    name: '🏰 Kastil Eropa',
    price: 20000000,
    category: 'property',
    type: 'luxury',
    requiresDebtFree: true,
  },
  PRIVATE_ISLAND: {
    id: 'PRIVATE_ISLAND',
    name: '🏝️ Pulau Pribadi',
    price: 25000000,
    category: 'property',
    type: 'luxury',
    requiresDebtFree: true,
  },

  /* ----------------------------------------------------------------------
   * G. FLEX-ART & COLLECTIBLES
   * -------------------------------------------------------------------- */
  DIAMOND_CROWN: {
    id: 'DIAMOND_CROWN',
    name: '👑 Mahkota Berlian',
    price: 1000000,
    category: 'art',
    type: 'luxury',
    minReserveCash: 0.10,
  },
  RARE_PAINTING: {
    id: 'RARE_PAINTING',
    name: '🖼️ Lukisan Rare',
    price: 1200000,
    category: 'art',
    type: 'luxury',
    minReserveCash: 0.10,
  },

  /* ----------------------------------------------------------------------
   * H. ULTIMATE FLEX
   * -------------------------------------------------------------------- */
  SPACE_STATION: {
    id: 'SPACE_STATION',
    name: '🛰️ Space Station',
    price: 100000000,
    category: 'ultimate',
    type: 'luxury',
    requiresDebtFree: true,
    requiredItems: ['PRIVATE_JET', 'SUPER_YACHT'],
    requiredItemsMode: 'any',
    requiredCategories: ['property'],
  },
};

const SHOP_ITEM_IDS = Object.keys(SHOP_ITEMS);

function getShopItem(itemId) {
  if (!itemId) return null;
  return SHOP_ITEMS[itemId.toUpperCase()] || null;
}

function getShopItemsByCategory(category) {
  return SHOP_ITEM_IDS.map((id) => SHOP_ITEMS[id]).filter((item) => item.category === category);
}

/**
 * validateShopPurchase — validator MURNI (tanpa I/O Redis), cukup diberi
 * snapshot data yang relevan. Mengembalikan { ok: true } kalau semua
 * syarat lolos, atau { ok: false, reason } dengan pesan tematik siap
 * pakai kalau ada yang gagal.
 *
 * Urutan pengecekan MENGIKUTI urutan yang diminta owner:
 *   1. Saldo cukup
 *   2. Debt-free
 *   3. Prerequisite items (requiredItems)
 *   4. Liquidity (minReserveCash)
 *   5. Category requirement (requiredCategories)
 *
 * @param {object} item - hasil getShopItem()
 * @param {object} ctx
 * @param {number} ctx.cash - saldo cash user SEBELUM checkout (sudah cleanInteger)
 * @param {number} ctx.loanAmount - sisa pinjaman aktif user (0 kalau tidak ada/lunas)
 * @param {object} ctx.inventory - hash trading:inventory:{userId} sudah di-cleanInteger tiap value, { ITEM_ID: qty }
 */
function validateShopPurchase(item, ctx) {
  const { cash, loanAmount, inventory } = ctx;

  // 1. Saldo cukup
  if (cash < item.price) {
    return {
      ok: false,
      reason: `⚠️ Saldo tidak cukup. Butuh 💵 ${item.price.toLocaleString('id-ID')} ZYC, saldo kamu 💵 ${cash.toLocaleString('id-ID')} ZYC.`,
    };
  }

  // 2. Debt-free
  if (item.requiresDebtFree && loanAmount > 0) {
    return {
      ok: false,
      reason: `❌ Dealer ${item.name} menolak transaksi! Pelunasan utangmu di pasar belum selesai.`,
    };
  }

  // 3. Prerequisite items — default mode 'all' (wajib punya SEMUA yang
  // disebut), kecuali item mengeset requiredItemsMode: 'any' (wajib punya
  // SALAH SATU saja, dipakai untuk kasus "model entry mana saja").
  if (item.requiredItems && item.requiredItems.length > 0) {
    const mode = item.requiredItemsMode === 'any' ? 'any' : 'all';
    const owns = (id) => (inventory?.[id] || 0) > 0;
    const satisfied = mode === 'any' ? item.requiredItems.some(owns) : item.requiredItems.every(owns);
    if (!satisfied) {
      const namesList = item.requiredItems.map((id) => getShopItem(id)?.name || id).join(', ');
      const joiner = mode === 'any' ? 'salah satu dari' : 'semua dari';
      return {
        ok: false,
        reason: `❌ Kamu belum memenuhi syarat kepemilikan. Wajib punya ${joiner}: ${namesList}.`,
      };
    }
  }

  // 4. Liquidity check — sisa saldo SETELAH checkout wajib >= price * minReserveCash.
  if (typeof item.minReserveCash === 'number' && item.minReserveCash > 0) {
    const remaining = cash - item.price;
    const requiredReserve = item.price * item.minReserveCash;
    if (remaining < requiredReserve) {
      return {
        ok: false,
        reason: `❌ Liquidity check gagal. Sisa saldo setelah beli minimal 💵 ${Math.ceil(requiredReserve).toLocaleString('id-ID')} ZYC (${item.minReserveCash * 100}% dari harga), sisa saldo kamu cuma akan 💵 ${remaining.toLocaleString('id-ID')} ZYC.`,
      };
    }
  }

  // 5. Category requirement — wajib punya minimal 1 item DARI SALAH SATU
  // kategori yang disebut (bukan wajib satu dari tiap kategori).
  if (item.requiredCategories && item.requiredCategories.length > 0) {
    const ownedCategories = new Set(
      Object.keys(inventory || {})
        .filter((id) => (inventory[id] || 0) > 0)
        .map((id) => getShopItem(id)?.category)
        .filter(Boolean)
    );
    const satisfied = item.requiredCategories.some((cat) => ownedCategories.has(cat));
    if (!satisfied) {
      return {
        ok: false,
        reason: `❌ Kamu wajib punya minimal 1 item dari kategori: ${item.requiredCategories.join(' atau ')}.`,
      };
    }
  }

  return { ok: true };
}

module.exports = {
  SHOP_ITEMS,
  SHOP_ITEM_IDS,
  getShopItem,
  getShopItemsByCategory,
  validateShopPurchase,
};
