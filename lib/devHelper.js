'use strict';

const { getRedis } = require('./redis');
const { CONFIG } = require('./config');

/* =========================================================================
 * DEV BYPASS MODE — toggle testing untuk Owner SAJA, supaya bisa uji
 * command trading tanpa terhalang batasan waktu/limit berikut:
 *   - Overdue loan check (work.js, bank.js, posisi.js)
 *   - Stamina cooldown /work (work.js)
 *   - maxOrderQuantity /posisi (posisi.js)
 *   - Cooldown 15 menit /leak (shop.js) — dihilangkan SEPENUHNYA
 *   - Cooldown 24 jam /bank-claim (bank.js) — dilewati, TAPI bunga
 *     tetap dihitung JUJUR dari waktu yang sudah lewat (proporsional,
 *     bukan dipaksa penuh) — lihat calculateSavingsInterestPrecise()
 *     di lib/bankEngine.js. Ini SENGAJA supaya bypass tidak jadi celah
 *     cetak uang tak terbatas meski cooldown-nya dihilangkan.
 *   - Lock period + limit 2x/hari ADVANCED_PASSCARD di /bank-withdraw
 *     TIER_DEPOSIT — bypass TIDAK konsumsi item, TIDAK kena limit
 *     harian, tapi tetap tunduk pada matematika bunga yang sama
 *     seperti penggunaan passcard sungguhan.
 *
 * CATATAN PENTING: sistem proyek ini pakai SATU CONFIG.OWNER_ID (bukan
 * array/multi-owner) — konsisten dengan isOwner() di lib/permissions.js
 * yang dipakai semua command Owner lain. isDevBypassed() DENGAN SENGAJA
 * cuma cek satu ID ini, bukan bikin sistem multi-owner baru.
 *
 * Bypass BUKAN otomatis untuk Owner — harus diaktifkan eksplisit lewat
 * /bypass mode:on (lihat lib/commands/bypass.js), dan Owner bisa
 * mengaktifkan/menonaktifkan bypass untuk USER LAIN juga (misal akun
 * kedua buat testing), bukan cuma untuk dirinya sendiri.
 *
 * PENTING: fungsi ini TIDAK PERNAH dipanggil dari dalam lib/trading.js
 * — trading.js sengaja dibiarkan murni tanpa tahu-menahu soal dev mode.
 * Semua pengecekan bypass terjadi di command LAYER (lib/commands/**),
 * SEBELUM memanggil fungsi trading.js/bankEngine.js/leakEngine.js.
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
