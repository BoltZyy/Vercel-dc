'use strict';

const { getBalance, adjustBalance, adjustAssetQuantity, cleanInteger } = require('./trading');
const { getRedis } = require('./redis');

/* =========================================================================
 * GACHA ENGINE — money sink + sumber utility item & Founder Shares.
 * Rate breakdown FINAL (lihat percakapan klarifikasi):
 *   Common   50% : Cash Drop kecil (1.000 - 3.500 ZYC)
 *   Uncommon 30% : Cash Drop besar (8.000 - 15.000 ZYC) ATAU consumable dasar
 *   Rare     15% : Consumable Pass (INSIDER_PASS/ADVANCED_PASSCARD) ATAU Shop Title acak
 *   Epic/JP   5% : dipecah lagi jadi 2.00% Cash Jackpot murni + 1.00%/1.00%/1.00%
 *                  untuk masing-masing NEXUS_SHARE/VALK_SHARE/NEO_SHARE
 *
 * Harga: 4.000 ZYC/pull, flat untuk 1x/5x/10x (tanpa diskon multi-pull).
 *
 * ASUMSI yang diambil (bukan disebutkan eksplisit di spesifikasi, wajar
 * dan mudah diubah kalau salah):
 *   - "Random Shop Titles (Kosmetik)" di tier Rare = acak dari 4 item
 *     cosmetic yang SUDAH ADA di shopItems.js (COLOR_GOLD, COLOR_NEON,
 *     TITLE_WHALE, TITLE_SURVIVOR) — bukan item cosmetic baru khusus gacha.
 *   - "Consumable dasar" di tier Uncommon = acak dari INSIDER_PASS/
 *     ADVANCED_PASSCARD (satu-satunya consumable yang ada saat ini).
 * ========================================================================= */

const GACHA_COST_PER_PULL = 4000;
const GACHA_PULL_OPTIONS = {
  '1': 1,
  '5': 5,
  '10': 10,
};

const RARE_COSMETIC_POOL = ['COLOR_GOLD', 'COLOR_NEON', 'TITLE_WHALE', 'TITLE_SURVIVOR'];
const UNCOMMON_CONSUMABLE_POOL = ['INSIDER_PASS', 'ADVANCED_PASSCARD'];

function getTodayDateString(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
}

function ecosystemVolumeKey(dateString) {
  return `trading:ecosystem-volume:${dateString}`;
}

/**
 * recordEcosystemVolume — akumulasi volume trading harian (4 aset
 * NORA/VOLT/KRYN/PLUM), dipakai kalkulasi "Bonus Volume Ekosistem" di
 * yield dividen Founder Shares. Dipanggil dari executeBuy/executeSell
 * di lib/trading.js — lihat catatan di sana kenapa dibungkus try/catch
 * SENDIRI di titik panggilnya (transaksi trading utama tidak boleh
 * gagal gara-gara tracking volume ini gagal).
 *
 * TTL 2 hari — dividen cuma butuh data "kemarin", tidak perlu riwayat
 * volume tersimpan lebih lama dari itu di key harian ini.
 */
async function recordEcosystemVolume(amount) {
  const redis = getRedis();
  if (!redis) return;
  const today = getTodayDateString();
  const cleaned = cleanInteger(amount);
  if (cleaned <= 0) return;
  await redis.incrby(ecosystemVolumeKey(today), cleaned);
  await redis.expire(ecosystemVolumeKey(today), 2 * 24 * 60 * 60);
}

/**
 * getEcosystemVolumeForDate — baca volume utk 1 tanggal spesifik
 * (dipakai job dividen membaca volume "kemarin"). Return 0 kalau tidak
 * ada data (bukan null — volume 0 valid, beda dengan "gagal baca").
 */
async function getEcosystemVolumeForDate(dateString) {
  const redis = getRedis();
  if (!redis) return 0;
  const raw = await redis.get(ecosystemVolumeKey(dateString));
  return raw ? cleanInteger(raw) : 0;
}

function getYesterdayDateString(now = Date.now()) {
  return getTodayDateString(now - 24 * 60 * 60 * 1000);
}

const SHARE_YIELD_CONFIG = {
  NEXUS_SHARE: { baseYield: 20000, volumeMultiplier: 0.015, label: 'Laba Tech' },
  VALK_SHARE: { baseYield: 10000, volumeMultiplier: 0.0075, label: 'Laba Industri' },
  NEO_SHARE: { baseYield: 5000, volumeMultiplier: 0.0025, label: 'Laba Retail' },
};

/**
 * calculateShareYield — fungsi MURNI. Formula: Laba Base TETAP per
 * lembar + (volume ekosistem KEMARIN * multiplier share), dikali
 * jumlah lembar yang dimiliki. Gampang di-unit-test tanpa Redis.
 */
function calculateShareYield(shareId, quantity, ecosystemVolumeYesterday) {
  const config = SHARE_YIELD_CONFIG[shareId];
  if (!config || quantity <= 0) return 0;
  const perShareYield = config.baseYield + ecosystemVolumeYesterday * config.volumeMultiplier;
  return cleanInteger(perShareYield * quantity);
}

function dividendLogKey(userId, dateString) {
  return `trading:dividend-log:${userId}:${dateString}`;
}

/**
 * payDailyDividends — orchestrator dipanggil QStash Schedule harian
 * (00:00 WIB). Menghitung yield SEMUA user yang punya share, kredit ke
 * cash masing-masing, dan catat dividend-log untuk idempotency (kalau
 * job kebetulan retry di hari yang sama, tidak bayar dobel).
 *
 * userIds HARUS di-supply oleh caller (endpoint job) — fungsi ini
 * TIDAK melakukan SCAN sendiri (dipisah supaya gampang di-unit-test
 * dengan daftar user kecil, tanpa perlu scan Redis sungguhan).
 */
async function payDailyDividends(userIds) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');

  const today = getTodayDateString();
  const yesterday = getYesterdayDateString();
  const ecosystemVolumeYesterday = await getEcosystemVolumeForDate(yesterday);

  const results = [];

  for (const userId of userIds) {
    // Idempotency: kalau sudah pernah dibayar hari ini, skip (jangan
    // bayar dobel kalau job retry).
    const alreadyPaid = await redis.get(dividendLogKey(userId, today));
    if (alreadyPaid) {
      results.push({ userId, skipped: true, reason: 'already_paid_today' });
      continue;
    }

    const shares = await getUserShares(userId);
    if (!shares || Object.keys(shares).length === 0) {
      continue; // user tanpa share sama sekali, tidak perlu dicatat apa pun
    }

    let totalDividend = 0;
    const breakdown = [];
    for (const shareId of SHARE_IDS) {
      const qty = shares[shareId] || 0;
      if (qty <= 0) continue;
      const yieldAmount = calculateShareYield(shareId, qty, ecosystemVolumeYesterday);
      totalDividend += yieldAmount;
      breakdown.push({ shareId, quantity: qty, yieldAmount });
    }

    if (totalDividend <= 0) continue;

    await adjustBalance(userId, totalDividend);
    await redis.set(dividendLogKey(userId, today), totalDividend, { ex: 7 * 24 * 60 * 60 });

    results.push({ userId, skipped: false, totalDividend, breakdown });
  }

  return { ok: true, ecosystemVolumeYesterday, paidCount: results.filter((r) => !r.skipped).length, results };
}

const SHARE_IDS = ['NEXUS_SHARE', 'VALK_SHARE', 'NEO_SHARE'];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * rollGachaTier — fungsi MURNI, tentukan tier + reward SATU pull
 * berdasarkan Math.random(). Tidak menyentuh Redis sama sekali —
 * gampang di-unit-test untuk verifikasi distribusi probabilitas.
 *
 * Return shape: { tier, rewardType, ...detail }
 *   rewardType: 'cash' | 'consumable' | 'cosmetic' | 'share'
 */
function rollGachaTier() {
  const roll = Math.random();

  // Epic/Jackpot: 5% total, dipecah 2% cash + 1%/1%/1% per share.
  // Batas kumulatif dari 0: [0, 0.02) cash, [0.02,0.03) NEXUS,
  // [0.03,0.04) VALK, [0.04,0.05) NEO.
  if (roll < 0.02) {
    return { tier: 'epic', rewardType: 'cash', amount: 100000 };
  }
  if (roll < 0.03) {
    return { tier: 'epic', rewardType: 'share', shareId: 'NEXUS_SHARE' };
  }
  if (roll < 0.04) {
    return { tier: 'epic', rewardType: 'share', shareId: 'VALK_SHARE' };
  }
  if (roll < 0.05) {
    return { tier: 'epic', rewardType: 'share', shareId: 'NEO_SHARE' };
  }

  // Rare: 15% (kumulatif sampai 0.20). Split 50/50 antara consumable
  // pass dan shop title kosmetik acak (tidak dispesifikasikan rasio
  // pastinya di dalam tier ini, jadi dibagi rata sebagai asumsi wajar).
  if (roll < 0.125) {
    return { tier: 'rare', rewardType: 'consumable', itemId: pickRandom(UNCOMMON_CONSUMABLE_POOL) };
  }
  if (roll < 0.20) {
    return { tier: 'rare', rewardType: 'cosmetic', itemId: pickRandom(RARE_COSMETIC_POOL) };
  }

  // Uncommon: 30% (kumulatif sampai 0.50). Split cash besar vs consumable
  // dasar — sama seperti Rare, dibagi rata karena tidak ada rasio pasti
  // yang dispesifikasikan.
  if (roll < 0.35) {
    return { tier: 'uncommon', rewardType: 'cash', amount: randomInt(8000, 15000) };
  }
  if (roll < 0.50) {
    return { tier: 'uncommon', rewardType: 'consumable', itemId: pickRandom(UNCOMMON_CONSUMABLE_POOL) };
  }

  // Common: 50% sisanya (0.50 - 1.00).
  return { tier: 'common', rewardType: 'cash', amount: randomInt(1000, 3500) };
}

function shareBuffTitleKey(userId) {
  return `trading:buff-title:${userId}`;
}

function sharesKey(userId) {
  return `trading:shares:${userId}`;
}

const SHARE_TO_BUFF_TITLE = {
  NEXUS_SHARE: 'TECH_ARCHON',
  VALK_SHARE: 'TITAN_VANGUARD',
  NEO_SHARE: 'SYNDICATE_BOSS',
};

/**
 * BUFF_TITLES — definisi statis 3 buff title dari Founder Shares.
 * BEDA dari shopItems.js: ini TIDAK BISA dibeli, cuma didapat dari
 * gacha (via kepemilikan share) dan slotnya TERPISAH dari Shop Title
 * kosmetik (trading:cosmetics:{userId}) — lihat trading:buff-title:
 * {userId} di docs/redis-schema-phase2.md Bagian #4.
 *
 * Efek buff (Pass Saver, Auction Tax Cut, dst) DIBACA dari sini oleh
 * command/engine lain yang relevan — misal getSavingsRate() di
 * bankEngine.js sudah membaca title 'SYNDICATE_BOSS' langsung dari key
 * Redis (bukan dari objek ini), tapi deskripsi efeknya didokumentasikan
 * di sini sebagai satu sumber kebenaran untuk /inventory & /portfolio.
 */
const BUFF_TITLES = {
  TECH_ARCHON: {
    id: 'TECH_ARCHON',
    name: '⚡ Tech Archon',
    requiredShare: 'NEXUS_SHARE',
    description: 'Pass Saver (15% chance item consumable tidak hangus saat dipakai) & Gacha Cashback 5%.',
  },
  TITAN_VANGUARD: {
    id: 'TITAN_VANGUARD',
    name: '🚀 Titan Vanguard',
    requiredShare: 'VALK_SHARE',
    description: 'Pajak lelang P2P turun 10%→5% & Bonus +10% yield/harga jual saat pasar Bullish.',
  },
  SYNDICATE_BOSS: {
    id: 'SYNDICATE_BOSS',
    name: '☕ Syndicate Boss',
    requiredShare: 'NEO_SHARE',
    description: 'Bunga Tabungan Reguler +0.5%/hari & Diskon biaya buka lelang P2P 1.500→1.000 ZYC.',
  },
};

function getBuffTitle(titleId) {
  if (!titleId) return null;
  return BUFF_TITLES[titleId.toUpperCase()] || null;
}

/**
 * grantShare — tambah 1 lembar share ke kepemilikan user (permanen,
 * TIDAK PERNAH dikurangi — tidak ada mekanisme jual). TIDAK otomatis
 * meng-equip buff title terkait — itu tetap manual via /equip (lihat
 * catatan terbuka #2 di docs/redis-schema-phase2.md, akan diselesaikan
 * saat command /equip ditulis). HANYA memastikan title itu ADA di
 * "koleksi ter-unlock" user (dicek dari trading:shares saat /equip).
 */
async function grantShare(userId, shareId) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  const newQty = await redis.hincrby(sharesKey(userId), shareId, 1);
  return cleanInteger(newQty);
}

/**
 * executeSingleGachaPull — orchestrator SATU pull: roll tier, eksekusi
 * reward-nya (kredit cash / tambah item / tambah share), return detail
 * untuk ditampilkan. TIDAK memotong biaya — itu tanggung jawab
 * executeGachaPulls (dipotong SEKALI di depan untuk seluruh batch).
 */
async function executeSingleGachaPull(userId) {
  const result = rollGachaTier();

  if (result.rewardType === 'cash') {
    await adjustBalance(userId, result.amount);
    return { ...result, description: `💵 ${result.amount.toLocaleString('id-ID')} ZYC` };
  }

  if (result.rewardType === 'consumable' || result.rewardType === 'cosmetic') {
    const redis = getRedis();
    await redis.hincrby(`trading:inventory:${userId}`, result.itemId, 1);
    return { ...result, description: `Item: ${result.itemId}` };
  }

  if (result.rewardType === 'share') {
    const newQty = await grantShare(userId, result.shareId);
    return { ...result, description: `🏆 ${result.shareId} (total dimiliki: ${newQty}x)`, totalOwned: newQty };
  }

  return result;
}

/**
 * executeGachaPulls — orchestrator BATCH (1x/5x/10x). Validasi saldo
 * SEKALIGUS untuk seluruh batch di depan (all-or-nothing terhadap
 * validasi), potong biaya sekali, baru eksekusi tiap pull satu-satu.
 */
async function executeGachaPulls(userId, pullCount) {
  if (!GACHA_PULL_OPTIONS[String(pullCount)]) {
    return { ok: false, error: '⚠️ Jumlah pull tidak valid. Pilih 1x, 5x, atau 10x.' };
  }

  const totalCost = GACHA_COST_PER_PULL * pullCount;
  const balance = await getBalance(userId);
  if (balance === null) return { ok: false, error: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' };
  if (balance < totalCost) {
    return { ok: false, error: `⚠️ Saldo tidak cukup. Butuh 💵 ${totalCost.toLocaleString('id-ID')} ZYC untuk ${pullCount}x pull, saldo kamu 💵 ${balance.toLocaleString('id-ID')} ZYC.` };
  }

  await adjustBalance(userId, -totalCost);

  const results = [];
  for (let i = 0; i < pullCount; i++) {
    const pullResult = await executeSingleGachaPull(userId);
    results.push(pullResult);
  }

  return { ok: true, totalCost, pullCount, results };
}

/**
 * getUserShares — kepemilikan share user, { shareId: qty }. Field yang
 * tidak pernah didapat tidak muncul sebagai key (sama seperti
 * getInventory di trading.js).
 */
async function getUserShares(userId) {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.hgetall(sharesKey(userId));
  const result = {};
  for (const key of Object.keys(raw || {})) {
    result[key] = cleanInteger(raw[key]);
  }
  return result;
}

/**
 * getEquippedBuffTitle — buff title yang sedang aktif, atau null kalau
 * belum equip apa pun.
 */
async function getEquippedBuffTitle(userId) {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get(shareBuffTitleKey(userId));
  return raw || null;
}

/**
 * equipBuffTitle — pasang buff title, WAJIB sudah punya minimal 1
 * lembar share terkait (dicek dari trading:shares:{userId}, BUKAN dari
 * riwayat "pernah dapat" — kalau suatu saat share bisa hilang/dijual,
 * cek ini otomatis ikut valid, meski saat ini share memang permanen
 * tidak bisa dijual).
 */
async function equipBuffTitle(userId, titleId) {
  const title = getBuffTitle(titleId);
  if (!title) return { ok: false, error: '⚠️ Buff title tidak dikenal.' };

  const shares = await getUserShares(userId);
  if (shares === null) return { ok: false, error: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' };

  if ((shares[title.requiredShare] || 0) <= 0) {
    return { ok: false, error: `⚠️ Kamu belum punya **${title.requiredShare}**. Dapatkan dari \`/gacha\` untuk unlock title ini.` };
  }

  const redis = getRedis();
  await redis.set(shareBuffTitleKey(userId), title.id);
  return { ok: true, title };
}

/**
 * unequipBuffTitle — lepas buff title aktif (tidak equip apa pun).
 */
async function unequipBuffTitle(userId) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  await redis.del(shareBuffTitleKey(userId));
}

/**
 * getAllUserIdsWithShares — SCAN semua key trading:shares:* untuk
 * dapat daftar userId yang PERNAH punya minimal 1 share. Dipakai
 * endpoint job dividen harian supaya tidak perlu SCAN manual di sana.
 * Pola SCAN sama seperti clearAllConversations di lib/redis.js.
 */
async function getAllUserIdsWithShares() {
  const redis = getRedis();
  if (!redis) return [];

  const userIds = [];
  let cursor = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: 'trading:shares:*', count: 100 });
    cursor = Number(nextCursor);
    for (const key of keys) {
      const userId = key.replace('trading:shares:', '');
      userIds.push(userId);
    }
  } while (cursor !== 0);

  return userIds;
}

module.exports = {
  GACHA_COST_PER_PULL,
  GACHA_PULL_OPTIONS,
  SHARE_IDS,
  SHARE_TO_BUFF_TITLE,
  BUFF_TITLES,
  getBuffTitle,
  rollGachaTier,
  grantShare,
  executeSingleGachaPull,
  executeGachaPulls,
  getUserShares,
  getEquippedBuffTitle,
  equipBuffTitle,
  unequipBuffTitle,
  recordEcosystemVolume,
  getEcosystemVolumeForDate,
  getTodayDateString,
  getYesterdayDateString,
  SHARE_YIELD_CONFIG,
  calculateShareYield,
  payDailyDividends,
  getAllUserIdsWithShares,
};
