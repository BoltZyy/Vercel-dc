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
 * skipPenalty (default false) — dipakai item shop BANK_PASSCARD (lihat
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
};
