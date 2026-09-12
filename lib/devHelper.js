'use strict';

const { getRedis } = require('./redis');
const { CONFIG } = require('./config');

/* =========================================================================
 * DEV BYPASS MODE — toggle testing untuk Owner SAJA, supaya bisa uji
 * command trading tanpa terhalang cooldown stamina, overdue loan, atau
 * limit order.
 *
 * CATATAN PENTING: sistem proyek ini pakai SATU CONFIG.OWNER_ID (bukan
 * array/multi-owner) — konsisten dengan isOwner() di lib/permissions.js
 * yang dipakai semua 56 command Owner lain. isDevBypassed() DENGAN
 * SENGAJA cuma cek satu ID ini, bukan bikin sistem multi-owner baru.
 *
 * Bypass BUKAN otomatis untuk Owner — harus diaktifkan eksplisit lewat
 * /bypass mode:on (lihat lib/commands/bypass.js), dan Owner bisa
 * mengaktifkan/menonaktifkan bypass untuk USER LAIN juga (misal akun
 * kedua buat testing), bukan cuma untuk dirinya sendiri.
 *
 * PENTING: fungsi ini TIDAK PERNAH dipanggil dari dalam lib/trading.js
 * — trading.js sengaja dibiarkan murni tanpa tahu-menahu soal dev mode.
 * Semua pengecekan bypass terjadi di command LAYER (lib/commands/**),
 * SEBELUM memanggil fungsi trading.js — lihat integrasinya di
 * work.js, bank.js, dan posisi.js.
 * ========================================================================= */

function bypassKey(userId) {
  return `dev:bypass:${userId}`;
}

/**
 * isDevBypassed — true HANYA kalau userId === CONFIG.OWNER_ID DAN flag
 * Redis-nya aktif ('1'). Siapa pun selain Owner selalu false, tidak
 * peduli apa isi Redis-nya (mencegah orang lain mengaktifkan bypass
 * buat dirinya sendiri lewat cara lain di luar /bypass).
 */
async function isDevBypassed(userId) {
  if (userId !== CONFIG.OWNER_ID) return false;

  const redis = getRedis();
  if (!redis) return false;

  try {
    const flag = await redis.get(bypassKey(userId));
    return flag === '1';
  } catch (err) {
    console.error('[DevHelper] isDevBypassed failed:', err.message);
    return false; // gagal cek -> fail-safe ke false, JANGAN diam-diam bypass
  }
}

async function setDevBypass(userId, enabled) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');

  if (enabled) {
    await redis.set(bypassKey(userId), '1');
  } else {
    await redis.del(bypassKey(userId));
  }
}

module.exports = { isDevBypassed, setDevBypass };
