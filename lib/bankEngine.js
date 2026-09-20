'use strict';

const { getRedis } = require('./redis');
const { getBalance, adjustBalance, cleanInteger, cleanNumber } = require('./trading');

/* =========================================================================
 * BANK & STAKING ENGINE
 *
 * Bunga dihitung TANPA cronjob — murni dari selisih timestamp
 * (Date.now() - depositedAt) tiap kali user memanggil /bank status atau
 * /bank withdraw. Ini konsisten dengan pola checkAndHandleOverdueLoan()
 * di trading.js (juga timestamp-based, bukan cron).
 *
 * MODEL BUNGA: SIMPLE INTEREST LINEAR per HARI PENUH berlalu (bukan
 * compound/majemuk). Asumsi ini SENGAJA dipilih supaya predictable dan
 * gampang di-audit manual — sejalan dengan prinsip "logika game tetap
 * simpel" yang sudah ditetapkan. Kalau mau compound, tinggal ubah
 * calculateInterest() saja, tidak menyentuh bagian lain.
 *
 *   bunga = modal * dailyRate * jumlah_hari_PENUH_berlalu
 *
 * Hari belum genap 24 jam TIDAK dihitung sama sekali (bukan pro-rata).
 *
 * Struktur Redis: SATU deposit aktif per user (bukan multi-tier
 * bersamaan) — key trading:bank:{userId}, Hash:
 *   { bankId, principal, depositedAt, lockDurationMs }
 * ========================================================================= */

const BANK_TIERS = {
  CENTRAL_RESERVE: {
    id: 'CENTRAL_RESERVE',
    name: '🏦 Central ZYC Reserve',
    dailyRate: 0.015, // 1.5%/hari
    lockDurationMs: 0, // bebas withdraw kapan saja
    earlyWithdrawPenalty: null,
  },
  KRYNITHIAN_COMMERCIAL: {
    id: 'KRYNITHIAN_COMMERCIAL',
    name: '🏛️ Krynithian Commercial',
    dailyRate: 0.04, // 4.0%/hari
    lockDurationMs: 2 * 24 * 60 * 60 * 1000, // 48 jam
    earlyWithdrawPenalty: { type: 'principal_cut', rate: 0.10 }, // potong 10% modal
  },
  VOLT_APEX_NEOBANK: {
    id: 'VOLT_APEX_NEOBANK',
    name: '⚡ Volt Apex Neo-Bank',
    dailyRate: 0.08, // 8.0%/hari
    lockDurationMs: 3 * 24 * 60 * 60 * 1000, // 72 jam
    earlyWithdrawPenalty: { type: 'principal_cut_plus_forfeit_interest', rate: 0.20 }, // potong 20% modal + bunga hangus
  },
};

const BANK_TIER_IDS = Object.keys(BANK_TIERS);
const DAY_MS = 24 * 60 * 60 * 1000;

function getBankTier(bankId) {
  if (!bankId) return null;
  return BANK_TIERS[bankId.toUpperCase()] || null;
}

/**
 * calculateInterest — fungsi MURNI (tanpa I/O), gampang di-unit-test.
 * Mengembalikan { daysElapsed, interest } berdasarkan HARI PENUH yang
 * sudah berlalu sejak depositedAt.
 */
function calculateInterest(tier, principal, depositedAt, now = Date.now()) {
  const elapsedMs = Math.max(0, now - depositedAt);
  const daysElapsed = Math.floor(elapsedMs / DAY_MS);
  const interest = cleanInteger(principal * tier.dailyRate * daysElapsed);
  return { daysElapsed, interest };
}

/**
 * isLockExpired — cek apakah durasi lock sudah lewat. Tier dengan
 * lockDurationMs 0 (Central Reserve) selalu true (bebas kapan saja).
 */
function isLockExpired(tier, depositedAt, now = Date.now()) {
  if (tier.lockDurationMs === 0) return true;
  return now - depositedAt >= tier.lockDurationMs;
}

/**
 * calculateEarlyWithdrawPenalty — fungsi MURNI. Mengembalikan
 * { principalAfterPenalty, interestAfterPenalty, penaltyDescription }.
 * Dipanggil HANYA kalau lock belum expired.
 */
function calculateEarlyWithdrawPenalty(tier, principal, interest) {
  if (!tier.earlyWithdrawPenalty) {
    // Tier tanpa lock (Central Reserve) tidak akan pernah masuk sini
    // karena isLockExpired() selalu true untuknya, tapi dijaga sebagai
    // fallback aman.
    return { principalAfterPenalty: principal, interestAfterPenalty: interest, penaltyDescription: 'Tanpa penalti.' };
  }

  const { type, rate } = tier.earlyWithdrawPenalty;
  const principalCut = cleanInteger(principal * rate);
  const principalAfterPenalty = principal - principalCut;

  if (type === 'principal_cut') {
    return {
      principalAfterPenalty,
      interestAfterPenalty: interest, // bunga yang sudah terkumpul tetap dapat
      penaltyDescription: `Potong ${rate * 100}% dari modal (💵 ${principalCut.toLocaleString('id-ID')} ZYC hangus).`,
    };
  }

  // principal_cut_plus_forfeit_interest — Volt Apex: modal dipotong DAN
  // seluruh bunga yang sudah terkumpul hangus total.
  return {
    principalAfterPenalty,
    interestAfterPenalty: 0,
    penaltyDescription: `Potong ${rate * 100}% dari modal (💵 ${principalCut.toLocaleString('id-ID')} ZYC hangus) + seluruh bunga terkumpul (💵 ${interest.toLocaleString('id-ID')} ZYC) hangus.`,
  };
}

function bankKey(userId) {
  return `trading:bank:${userId}`;
}

const PASSCARD_DAILY_LIMIT = 2;

function passcardUsageKey(userId) {
  return `trading:passcard-usage:${userId}`;
}

function getTodayDateString(now = Date.now()) {
  // Dipakai sebagai "kunci hari" sederhana — reset otomatis begitu
  // tanggal kalender UTC berganti, tanpa perlu cron/TTL presisi jam.
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * getPasscardUsageToday — baca berapa kali passcard sudah dipakai HARI
 * INI (UTC). Otomatis reset ke 0 kalau tanggal tersimpan beda dari
 * hari ini — TIDAK butuh cron, cukup dibandingkan saat dibaca.
 */
async function getPasscardUsageToday(userId) {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.hgetall(passcardUsageKey(userId));
  const today = getTodayDateString();
  if (!raw || raw.date !== today) {
    return { count: 0, date: today };
  }
  return { count: cleanInteger(raw.count), date: raw.date };
}

/**
 * incrementPasscardUsage — tambah 1 pemakaian passcard hari ini. Kalau
 * hari sudah berganti sejak pemakaian terakhir, otomatis mulai ulang
 * dari 1 (bukan menumpuk dari hari sebelumnya).
 */
async function incrementPasscardUsage(userId) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  const today = getTodayDateString();
  const usage = await getPasscardUsageToday(userId);
  const newCount = usage.date === today ? usage.count + 1 : 1;
  await redis.hset(passcardUsageKey(userId), { count: newCount, date: today });
  return newCount;
}

/**
 * getActiveDeposit — ambil deposit aktif user, atau null kalau tidak ada.
 * Field numerik sudah di-cleanInteger.
 */
async function getActiveDeposit(userId) {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.hgetall(bankKey(userId));
  if (!raw || !raw.bankId) return null;
  return {
    bankId: raw.bankId,
    principal: cleanInteger(raw.principal),
    depositedAt: cleanInteger(raw.depositedAt),
  };
}

/**
 * depositToBank — buat deposit baru. Menolak kalau user SUDAH punya
 * deposit aktif (1 deposit aktif per user, sesuai keputusan desain).
 */
async function depositToBank(userId, bankId, amount) {
  const tier = getBankTier(bankId);
  if (!tier) return { ok: false, error: '⚠️ Bank tidak dikenal. Cek `/bank list` untuk pilihan yang valid.' };

  const cleanAmount = cleanInteger(amount);
  if (cleanAmount <= 0) return { ok: false, error: '⚠️ Jumlah deposit harus lebih dari 0.' };

  const existing = await getActiveDeposit(userId);
  if (existing) {
    return { ok: false, error: `⚠️ Kamu sudah punya deposit aktif di **${getBankTier(existing.bankId)?.name || existing.bankId}**. Tarik dulu (\`/bank withdraw\`) sebelum deposit baru.` };
  }

  const balance = await getBalance(userId);
  if (balance === null) return { ok: false, error: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' };
  if (balance < cleanAmount) {
    return { ok: false, error: `⚠️ Saldo tidak cukup. Saldo kamu 💵 ${balance.toLocaleString('id-ID')} ZYC.` };
  }

  const redis = getRedis();
  await adjustBalance(userId, -cleanAmount);
  await redis.hset(bankKey(userId), {
    bankId: tier.id,
    principal: cleanAmount,
    depositedAt: Date.now(),
  });

  return { ok: true, tier, amount: cleanAmount };
}

/**
 * getDepositStatus — snapshot lengkap deposit aktif user (untuk /bank
 * status), termasuk kalkulasi bunga real-time dan status lock.
 */
async function getDepositStatus(userId) {
  const deposit = await getActiveDeposit(userId);
  if (!deposit) return { ok: false, error: '⚠️ Kamu tidak punya deposit aktif. Pakai `/bank deposit` dulu.' };

  const tier = getBankTier(deposit.bankId);
  if (!tier) {
    // Data korup (bankId tidak dikenal, mis. tier dihapus dari katalog) —
    // tetap tampilkan apa adanya tanpa menghitung bunga, jangan crash.
    return { ok: false, error: '⚠️ Data deposit kamu tidak dikenali sistem. Hubungi Owner.' };
  }

  const now = Date.now();
  const { daysElapsed, interest } = calculateInterest(tier, deposit.principal, deposit.depositedAt, now);
  const lockExpired = isLockExpired(tier, deposit.depositedAt, now);
  const unlockAt = tier.lockDurationMs === 0 ? null : deposit.depositedAt + tier.lockDurationMs;

  return {
    ok: true,
    tier,
    principal: deposit.principal,
    daysElapsed,
    interest,
    totalIfWithdrawNow: deposit.principal + interest,
    lockExpired,
    unlockAt,
  };
}

/**
 * withdrawFromBank — tarik modal + bunga. Kalau lock belum expired,
 * kenakan penalti sesuai tier lalu tetap proses withdraw (bukan
 * ditolak) — user tetap bisa withdraw kapan saja, hanya rugi penalti.
 *
 * skipPenalty (default false) — dipakai item shop ADVANCED_PASSCARD (lihat
 * lib/commands/trading/bank.js): kalau true, penalti early withdraw
 * SAMA SEKALI tidak dihitung (diperlakukan seolah lock sudah selesai)
 * — user dapat modal + bunga PENUH meski lock belum habis. Rate limit
 * "maks 2x pakai per hari" dan pengurangan stok item passcard itu
 * sendiri BUKAN tanggung jawab fungsi ini — itu dicek & dieksekusi di
 * command layer SEBELUM memanggil withdrawFromBank(..., true).
 */
async function withdrawFromBank(userId, skipPenalty = false) {
  const deposit = await getActiveDeposit(userId);
  if (!deposit) return { ok: false, error: '⚠️ Kamu tidak punya deposit aktif.' };

  const tier = getBankTier(deposit.bankId);
  if (!tier) return { ok: false, error: '⚠️ Data deposit kamu tidak dikenali sistem. Hubungi Owner.' };

  const now = Date.now();
  const { daysElapsed, interest } = calculateInterest(tier, deposit.principal, deposit.depositedAt, now);
  const lockExpired = skipPenalty ? true : isLockExpired(tier, deposit.depositedAt, now);

  let finalPrincipal = deposit.principal;
  let finalInterest = interest;
  let penaltyDescription = null;

  if (!lockExpired) {
    const penalty = calculateEarlyWithdrawPenalty(tier, deposit.principal, interest);
    finalPrincipal = penalty.principalAfterPenalty;
    finalInterest = penalty.interestAfterPenalty;
    penaltyDescription = penalty.penaltyDescription;
  }

  const totalPayout = cleanInteger(finalPrincipal + finalInterest);

  const redis = getRedis();
  if (!redis) return { ok: false, error: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' };

  await adjustBalance(userId, totalPayout);
  await redis.del(bankKey(userId));

  return {
    ok: true,
    tier,
    principal: deposit.principal,
    daysElapsed,
    interestEarned: interest,
    totalPayout,
    wasEarlyWithdraw: !lockExpired,
    penaltyDescription,
    usedPasscard: skipPenalty,
  };
}

/* =========================================================================
 * REKENING TABUNGAN REGULER — sistem TERPISAH dari deposito bertingkat
 * di atas (BANK_TIERS). Tanpa lock, top-up/withdraw bebas kapan saja,
 * tapi bunga HARUS diklaim manual (/bank-claim, cooldown 24 jam) — tidak
 * auto-credit seperti dividen shares.
 *
 * Struktur Redis (lihat docs/redis-schema-phase2.md Bagian #2):
 *   trading:savings:{userId}        -> Hash { balance, lastAccrualAt, accruedInterest }
 *   trading:savings-claim:{userId}  -> Hash { lastClaimAt }
 *
 * KRISTALISASI BUNGA: setiap kali balance berubah (top-up ATAU withdraw),
 * bunga yang sudah "matang" dari principal LAMA dihitung dulu dan
 * dipindah ke accruedInterest, BARU principal (balance) diubah — supaya
 * principal yang dipakai kalkulasi bunga besok selalu representasi
 * akurat dari saldo yang benar-benar mengendap di periode itu, bukan
 * tercampur dengan saldo baru yang belum genap sehari.
 * ========================================================================= */

const REGULAR_SAVINGS_BASE_RATE = 0.005; // 0.5%/hari
const REGULAR_SAVINGS_CLAIM_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 jam

const HOUR_MS = 60 * 60 * 1000;

/**
 * calculateSavingsInterestPrecise — SAMA seperti calculateInterest(),
 * tapi presisi JAM (bukan hari penuh dibulatkan ke bawah). Dipakai
 * KHUSUS untuk Rekening Reguler (bukan deposito bertingkat, yang tetap
 * pakai calculateInterest() hari-penuh sesuai desain awal) — karena
 * rekening reguler bisa top-up/withdraw/klaim kapan saja, presisi jam
 * lebih adil daripada dibulatkan ke hari (yang berarti < 24 jam = 0).
 *
 * PENTING: fungsi ini dipakai baik untuk klaim NORMAL maupun BYPASS —
 * bukan cuma untuk bypass. Untuk klaim normal ini tidak mengubah
 * perilaku praktis (cooldown 24 jam tetap menghalangi klaim sebelum
 * waktunya, jadi user normal tetap efektif dapat ~1 hari penuh setiap
 * klaim) — TAPI kalau bypass aktif dan klaim dipanggil sebelum 24 jam,
 * hasilnya PROPORSIONAL jujur (misal 3 jam = 3/24 dari bunga harian),
 * BUKAN dipaksa jadi 0 (kalau pakai calculateInterest lama) atau
 * dipaksa jadi bunga 1 hari penuh (yang berarti mencetak uang).
 */
function calculateSavingsInterestPrecise(dailyRate, principal, lastAccrualAt, now = Date.now()) {
  const elapsedMs = Math.max(0, now - lastAccrualAt);
  const elapsedHours = elapsedMs / HOUR_MS;
  const interest = cleanInteger(principal * dailyRate * (elapsedHours / 24));
  return { elapsedHours, interest };
}

function savingsKey(userId) {
  return `trading:savings:${userId}`;
}

function savingsClaimKey(userId) {
  return `trading:savings-claim:${userId}`;
}

/**
 * getSavingsRate — rate harian efektif untuk 1 user, memperhitungkan
 * buff Syndicate Boss (+0.5% jadi 1.0%/hari) KALAU sedang di-equip.
 *
 * CATATAN: trading:buff-title:{userId} adalah bagian dari sistem Buff
 * Title (Bagian #4 — Gacha & Founder Shares) yang BELUM DIBANGUN saat
 * fungsi ini ditulis. Fungsi ini sengaja SUDAH membaca key itu sekarang
 * — karena key tidak akan pernah ada isinya sebelum Bagian #4 selesai,
 * hasilnya otomatis fallback ke rate dasar untuk SEMUA user sampai
 * mekanisme /equip sungguhan menulis ke key tersebut. Tidak perlu
 * diedit ulang nanti, cukup pastikan Bagian #4 menulis nilai yang benar
 * ('SYNDICATE_BOSS') ke key ini saat di-equip.
 */
async function getSavingsRate(userId) {
  const redis = getRedis();
  if (!redis) return REGULAR_SAVINGS_BASE_RATE;
  try {
    const buffTitle = await redis.get(`trading:buff-title:${userId}`);
    if (buffTitle === 'SYNDICATE_BOSS') {
      return REGULAR_SAVINGS_BASE_RATE + 0.005; // 1.0%/hari total
    }
    return REGULAR_SAVINGS_BASE_RATE;
  } catch (err) {
    console.error('[BankEngine] getSavingsRate failed:', err.message);
    return REGULAR_SAVINGS_BASE_RATE; // fail-safe ke rate dasar, jangan pernah throw di sini
  }
}

/**
 * getSavingsAccount — baca state rekening reguler user, atau null kalau
 * user belum pernah top-up sama sekali (beda dengan "ada tapi 0" —
 * belum pernah dibuat vs balance habis adalah dua hal berbeda untuk UX
 * pesan error yang lebih jelas).
 */
async function getSavingsAccount(userId) {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.hgetall(savingsKey(userId));
  if (!raw || raw.balance === undefined) return null;
  return {
    balance: cleanInteger(raw.balance),
    lastAccrualAt: cleanInteger(raw.lastAccrualAt),
    accruedInterest: cleanInteger(raw.accruedInterest || 0),
  };
}

/**
 * crystallizeSavingsInterest — hitung bunga yang sudah matang dari
 * principal SAAT INI (sebelum diubah), pindahkan ke accruedInterest,
 * majukan lastAccrualAt ke sekarang. Dipanggil di AWAL setiap operasi
 * yang mengubah balance (top-up/withdraw) DAN di awal klaim (supaya
 * klaim juga menangkap bunga hari berjalan, bukan cuma yang sudah
 * ter-kristalisasi dari operasi sebelumnya).
 *
 * TIDAK melakukan I/O tulis sendiri — mengembalikan state BARU yang
 * harus ditulis oleh caller bersamaan dengan perubahan lain (supaya
 * tidak ada write Redis ganda yang terpisah untuk 1 operasi logis).
 */
function crystallizeSavingsInterest(account, now = Date.now()) {
  const rate = account.rate; // di-inject oleh caller, lihat pemanggil di bawah
  // Pakai formula PRESISI JAM (bukan calculateInterest hari-penuh) —
  // lihat komentar calculateSavingsInterestPrecise() untuk alasannya.
  const { interest } = calculateSavingsInterestPrecise(rate, account.balance, account.lastAccrualAt, now);
  return {
    balance: account.balance,
    lastAccrualAt: now,
    accruedInterest: account.accruedInterest + interest,
  };
}

/**
 * depositToSavings — top-up rekening reguler. Membuat rekening baru
 * kalau belum ada (lastAccrualAt = now, tidak ada bunga yang perlu
 * dikristalisasi karena principal sebelumnya 0).
 */
async function depositToSavings(userId, amount) {
  const cleanAmount = cleanInteger(amount);
  if (cleanAmount <= 0) return { ok: false, error: '⚠️ Jumlah deposit harus lebih dari 0.' };

  const balance = await getBalance(userId);
  if (balance === null) return { ok: false, error: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' };
  if (balance < cleanAmount) {
    return { ok: false, error: `⚠️ Saldo tidak cukup. Saldo kamu 💵 ${balance.toLocaleString('id-ID')} ZYC.` };
  }

  const redis = getRedis();
  const now = Date.now();
  const existing = await getSavingsAccount(userId);
  const rate = await getSavingsRate(userId);

  let newState;
  if (!existing) {
    newState = { balance: cleanAmount, lastAccrualAt: now, accruedInterest: 0 };
  } else {
    const crystallized = crystallizeSavingsInterest({ ...existing, rate }, now);
    newState = { ...crystallized, balance: existing.balance + cleanAmount };
  }

  await adjustBalance(userId, -cleanAmount);
  await redis.hset(savingsKey(userId), newState);

  return { ok: true, amount: cleanAmount, newBalance: newState.balance };
}

/**
 * withdrawFromSavings — tarik SEBAGIAN ATAU SELURUH principal (bukan
 * bunga — accruedInterest tetap tersimpan menunggu /bank-claim). Tanpa
 * lock, tanpa penalti, bisa kapan saja.
 */
async function withdrawFromSavings(userId, amount) {
  const existing = await getSavingsAccount(userId);
  if (!existing) return { ok: false, error: '⚠️ Kamu tidak punya Rekening Tabungan Reguler aktif.' };

  const cleanAmount = cleanInteger(amount);
  if (cleanAmount <= 0) return { ok: false, error: '⚠️ Jumlah withdraw harus lebih dari 0.' };
  if (cleanAmount > existing.balance) {
    return { ok: false, error: `⚠️ Saldo tabungan tidak cukup. Saldo kamu 💵 ${existing.balance.toLocaleString('id-ID')} ZYC.` };
  }

  const redis = getRedis();
  const now = Date.now();
  const rate = await getSavingsRate(userId);
  const crystallized = crystallizeSavingsInterest({ ...existing, rate }, now);
  const newBalance = crystallized.balance - cleanAmount;

  await adjustBalance(userId, cleanAmount);

  if (newBalance <= 0 && crystallized.accruedInterest <= 0) {
    // Rekening benar-benar kosong (principal habis DAN tidak ada bunga
    // menunggu diklaim) — hapus key sekalian, bukan simpan hash isi 0.
    await redis.del(savingsKey(userId));
  } else {
    await redis.hset(savingsKey(userId), { ...crystallized, balance: newBalance });
  }

  return { ok: true, amount: cleanAmount, newBalance: Math.max(0, newBalance) };
}

/**
 * getSavingsStatus — snapshot untuk ditampilkan user (semacam /bank
 * status, tapi untuk rekening reguler). TIDAK menulis apa pun ke Redis
 * — kristalisasi cuma dihitung untuk tampilan, state asli tidak
 * berubah sampai user benar-benar top-up/withdraw/claim.
 */
async function getSavingsStatus(userId) {
  const existing = await getSavingsAccount(userId);
  if (!existing) return { ok: false, error: '⚠️ Kamu tidak punya Rekening Tabungan Reguler aktif. Pakai `/bank-deposit type:REGULAR` dulu.' };

  const rate = await getSavingsRate(userId);
  const { interest: pendingInterest } = calculateSavingsInterestPrecise(rate, existing.balance, existing.lastAccrualAt, Date.now());

  return {
    ok: true,
    balance: existing.balance,
    accruedInterest: existing.accruedInterest,
    pendingInterest, // bunga hari berjalan yang BELUM dikristalisasi ke accruedInterest
    totalClaimable: existing.accruedInterest + pendingInterest,
    rate,
  };
}

/**
 * claimSavingsInterest — klaim manual SELURUH bunga terkumpul
 * (accruedInterest + bunga hari berjalan yang baru dikristalisasi) ke
 * cash. Cooldown 24 jam sejak klaim terakhir, KECUALI bypassCooldown
 * true (dipakai ADVANCED_PASSCARD — lihat command layer).
 */
async function claimSavingsInterest(userId, bypassCooldown = false) {
  const existing = await getSavingsAccount(userId);
  if (!existing) return { ok: false, error: '⚠️ Kamu tidak punya Rekening Tabungan Reguler aktif.' };

  const redis = getRedis();
  if (!redis) return { ok: false, error: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' };

  if (!bypassCooldown) {
    const claimData = await redis.hgetall(savingsClaimKey(userId));
    const lastClaimAt = claimData?.lastClaimAt ? cleanInteger(claimData.lastClaimAt) : 0;
    const elapsedMs = Date.now() - lastClaimAt;
    if (elapsedMs < REGULAR_SAVINGS_CLAIM_COOLDOWN_MS) {
      const nextClaimAt = lastClaimAt + REGULAR_SAVINGS_CLAIM_COOLDOWN_MS;
      return { ok: false, error: `⚠️ Klaim bunga masih cooldown. Bisa klaim lagi <t:${Math.floor(nextClaimAt / 1000)}:R>.`, onCooldown: true, nextClaimAt };
    }
  }

  const now = Date.now();
  const rate = await getSavingsRate(userId);
  const crystallized = crystallizeSavingsInterest({ ...existing, rate }, now);
  const totalClaim = cleanInteger(crystallized.accruedInterest);

  if (totalClaim <= 0) {
    return { ok: false, error: '⚠️ Tidak ada bunga untuk diklaim saat ini.' };
  }

  await adjustBalance(userId, totalClaim);
  await redis.hset(savingsKey(userId), { balance: crystallized.balance, lastAccrualAt: now, accruedInterest: 0 });
  await redis.hset(savingsClaimKey(userId), { lastClaimAt: now });

  return { ok: true, claimedAmount: totalClaim, usedPasscard: bypassCooldown };
}

module.exports = {
  BANK_TIERS,
  BANK_TIER_IDS,
  getBankTier,
  calculateInterest,
  isLockExpired,
  calculateEarlyWithdrawPenalty,
  getActiveDeposit,
  depositToBank,
  getDepositStatus,
  withdrawFromBank,
  PASSCARD_DAILY_LIMIT,
  getPasscardUsageToday,
  incrementPasscardUsage,
  REGULAR_SAVINGS_BASE_RATE,
  REGULAR_SAVINGS_CLAIM_COOLDOWN_MS,
  getSavingsRate,
  getSavingsAccount,
  depositToSavings,
  withdrawFromSavings,
  getSavingsStatus,
  claimSavingsInterest,
  calculateSavingsInterestPrecise,
};
