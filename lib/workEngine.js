'use strict';

const { getRedis } = require('./redis');
const { adjustBalance, cleanInteger } = require('./trading');

/* =========================================================================
 * WORK ENGINE — sistem stamina regen berbasis timestamp (bukan cron),
 * sama filosofinya dengan bankEngine.js: hitung ulang tiap kali dipanggil
 * dari selisih waktu, bukan proses background.
 *
 * STAMINA: maksimal 5 charge, regen 1 charge/120 detik. Disimpan sebagai
 * SATU timestamp "lastRegenAt" + "charges" tersisa di Redis — bukan
 * riwayat tiap regen satu-satu (state minimal, sesuai prinsip "logika
 * game tetap simpel").
 *
 * Model regen: setiap kali dibaca, hitung berapa banyak interval 120
 * detik sudah lewat sejak lastRegenAt, tambahkan ke charges (dibatasi
 * max 5), lalu majukan lastRegenAt sejumlah interval yang sudah
 * "dicairkan" itu (BUKAN di-reset ke now — supaya sisa waktu pecahan
 * interval tidak hilang percuma).
 * ========================================================================= */

const MAX_STAMINA = 5;
const REGEN_INTERVAL_MS = 120 * 1000; // 2 menit

const JOBS = {
  // --- Low risk: gaji pasti ---
  streamer: { id: 'streamer', name: '📺 Streamer Discord / VTuber', risk: 'low', minPay: 20, maxPay: 50 },
  mekanik: { id: 'mekanik', name: '🔧 Mekanik (Service Motor / Rakit PC)', risk: 'low', minPay: 20, maxPay: 50 },
  kurir: { id: 'kurir', name: '📦 Kurir (Antar Paket / Makanan)', risk: 'low', minPay: 20, maxPay: 50 },

  // --- High risk: spekulasi ---
  joki: { id: 'joki', name: '🎮 Joki', risk: 'high', successChance: 0.7, successMin: 60, successMax: 90, failMin: 5, failMax: 10 },
  calo: { id: 'calo', name: '🎫 Calo', risk: 'high', successChance: 0.5, successMin: 80, successMax: 120, failMin: 0, failMax: 0 },

  // --- Meme & unik ---
  'admin-fstyle': { id: 'admin-fstyle', name: '📱 Admin Freestyle (Meme Page)', risk: 'meme', minPay: 15, maxPay: 60 },
  'ternak-akun': { id: 'ternak-akun', name: '🌾 Ternak Akun (Berburu Airdrop)', risk: 'meme', minPay: 10, maxPay: 100 },
};

const JOB_IDS = Object.keys(JOBS);

function getJob(jobId) {
  if (!jobId) return null;
  return JOBS[jobId.toLowerCase()] || null;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * calculateStamina — fungsi MURNI. Diberi state lama (charges,
 * lastRegenAt) dan waktu sekarang, kembalikan state BARU setelah regen
 * dihitung. TIDAK menyentuh Redis sama sekali — gampang di-unit-test.
 */
function calculateStamina(charges, lastRegenAt, now = Date.now()) {
  if (charges >= MAX_STAMINA) {
    // Sudah penuh — tidak ada regen yang perlu dihitung, lastRegenAt
    // dimajukan ke now supaya tidak menumpuk "hutang" interval saat
    // suatu saat dipakai dan charges turun lagi.
    return { charges: MAX_STAMINA, lastRegenAt: now };
  }

  const elapsedMs = Math.max(0, now - lastRegenAt);
  const intervalsElapsed = Math.floor(elapsedMs / REGEN_INTERVAL_MS);

  if (intervalsElapsed <= 0) {
    return { charges, lastRegenAt };
  }

  const newCharges = Math.min(MAX_STAMINA, charges + intervalsElapsed);
  // Majukan lastRegenAt sejumlah interval yang SUDAH dicairkan saja —
  // sisa waktu pecahan (misal baru 90 dari 120 detik) TETAP tersimpan,
  // tidak hangus. Kalau charges sudah mentok MAX sebelum semua interval
  // "terpakai", sisa waktu berjalan dianggap hangus (wajar -- stamina
  // penuh tidak regen lebih lanjut).
  const cappedIntervals = newCharges - charges; // berapa interval yang benar2 dipakai naik
  const advancedMs = cappedIntervals * REGEN_INTERVAL_MS;
  const newLastRegenAt = newCharges >= MAX_STAMINA ? now : lastRegenAt + advancedMs;

  return { charges: newCharges, lastRegenAt: newLastRegenAt };
}

/**
 * getNextChargeEta — kapan (timestamp) charge berikutnya akan terisi,
 * dihitung dari state SETELAH calculateStamina() dipanggil. null kalau
 * stamina sudah penuh (tidak ada "berikutnya" untuk ditunggu).
 */
function getNextChargeEta(charges, lastRegenAt) {
  if (charges >= MAX_STAMINA) return null;
  return lastRegenAt + REGEN_INTERVAL_MS;
}

function staminaKey(userId) {
  return `trading:stamina:${userId}`;
}

/**
 * getStaminaState — baca state stamina user dari Redis, jalankan
 * calculateStamina() untuk regen real-time, TULIS BALIK hasil regen
 * (supaya pembacaan berikutnya mulai dari baseline yang benar), lalu
 * kembalikan state final.
 *
 * User baru (belum pernah /work) otomatis dapat MAX_STAMINA penuh.
 */
async function getStaminaState(userId) {
  const redis = getRedis();
  if (!redis) return null;

  const raw = await redis.hgetall(staminaKey(userId));
  const now = Date.now();

  if (!raw || raw.charges === undefined) {
    // User baru — mulai dengan stamina penuh.
    await redis.hset(staminaKey(userId), { charges: MAX_STAMINA, lastRegenAt: now });
    return { charges: MAX_STAMINA, lastRegenAt: now };
  }

  const oldCharges = cleanInteger(raw.charges);
  const oldLastRegenAt = cleanInteger(raw.lastRegenAt);
  const { charges, lastRegenAt } = calculateStamina(oldCharges, oldLastRegenAt, now);

  // Cuma tulis balik kalau ada perubahan — hemat 1 write Redis kalau
  // belum ada interval yang lewat sama sekali.
  if (charges !== oldCharges || lastRegenAt !== oldLastRegenAt) {
    await redis.hset(staminaKey(userId), { charges, lastRegenAt });
  }

  return { charges, lastRegenAt };
}

/**
 * consumeStamina — kurangi 1 charge. HARUS dipanggil setelah
 * getStaminaState() memastikan charges > 0. Tidak melakukan pengecekan
 * ulang di sini supaya tidak ada 2 sumber kebenaran soal validasi.
 */
/**
 * consumeStamina — kurangi 1 charge. HARUS dipanggil setelah
 * getStaminaState() memastikan charges > 0 DAN sudah menulis balik
 * lastRegenAt yang konsisten ke Redis. Fungsi ini SENGAJA tidak
 * menyentuh lastRegenAt sama sekali — hanya hincrby charges — supaya
 * baseline regen charge berikutnya tetap dihitung dari titik yang
 * sudah benar (baik itu dari regen alami maupun dari full reset saat
 * charges sudah MAX_STAMINA di calculateStamina()).
 */
async function consumeStamina(userId) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  const newCharges = await redis.hincrby(staminaKey(userId), 'charges', -1);
  return cleanInteger(newCharges);
}

/**
 * calculatePayout — fungsi MURNI, tidak menyentuh Redis. Mengembalikan
 * { amount, outcome, isSuccess } sesuai jenis pekerjaan.
 */
function calculatePayout(job) {
  if (job.risk === 'low' || job.risk === 'meme') {
    const amount = randomInt(job.minPay, job.maxPay);
    return { amount, outcome: 'normal', isSuccess: true };
  }

  // High risk: joki & calo, masing-masing punya successChance sendiri.
  const roll = Math.random();
  const isSuccess = roll < job.successChance;
  if (isSuccess) {
    const amount = randomInt(job.successMin, job.successMax);
    return { amount, outcome: 'success', isSuccess: true };
  }
  const amount = job.failMax > 0 ? randomInt(job.failMin, job.failMax) : 0;
  return { amount, outcome: 'fail', isSuccess: false };
}

/**
 * executeWork — orchestrator penuh: cek stamina, potong 1 charge,
 * hitung payout, kreditkan ke saldo. All-or-nothing: kalau stamina
 * tidak cukup, TIDAK ada saldo yang berubah sama sekali.
 */
async function executeWork(userId, jobId) {
  const job = getJob(jobId);
  if (!job) return { ok: false, error: '⚠️ Pekerjaan tidak dikenal. Cek pilihan yang tersedia di `/work`.' };

  const staminaState = await getStaminaState(userId);
  if (staminaState === null) return { ok: false, error: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' };

  if (staminaState.charges <= 0) {
    const eta = getNextChargeEta(staminaState.charges, staminaState.lastRegenAt);
    return { ok: false, error: `⚠️ Stamina kamu habis (0/${MAX_STAMINA}). Charge berikutnya <t:${Math.floor(eta / 1000)}:R>.`, outOfStamina: true, eta };
  }

  const newCharges = await consumeStamina(userId);
  const { amount, outcome, isSuccess } = calculatePayout(job);

  if (amount > 0) {
    await adjustBalance(userId, amount);
  }

  return { ok: true, job, amount, outcome, isSuccess, remainingStamina: Math.max(0, newCharges) };
}

module.exports = {
  MAX_STAMINA,
  REGEN_INTERVAL_MS,
  JOBS,
  JOB_IDS,
  getJob,
  calculateStamina,
  getNextChargeEta,
  getStaminaState,
  calculatePayout,
  executeWork,
};
