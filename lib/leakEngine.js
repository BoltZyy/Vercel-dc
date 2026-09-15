'use strict';

const { getRedis } = require('./redis');
const { getActiveEvent, cleanInteger } = require('./trading');

/* =========================================================================
 * LEAK ENGINE — /leak dual-layer:
 *   1. Sentimen Makro (GRATIS, selalu tampil): event aktif asli
 *      (getActiveEvent(), jendela 5 menit) ATAU narasi konsolidasi kalau
 *      tidak ada event aktif saat ini. TIDAK PERNAH kosong/gagal.
 *   2. Alpha Intel Mikro (TERKUNCI): perlu 1x INSIDER_PASS untuk dibuka,
 *      isinya sama seperti makro tapi framing lebih spesifik/personal.
 *
 * Cooldown 15 menit PER-USER untuk memanggil /leak sama sekali (bukan
 * cuma untuk buka Alpha Intel) — disimpan sebagai timestamp compare,
 * konsisten dengan pola timestamp-based lain di proyek ini (stamina,
 * bunga bank), BUKAN TTL key Redis. INSIDER_PASS me-reset cooldown ini
 * ke 0 (boleh langsung pakai /leak lagi setelahnya).
 * ========================================================================= */

const LEAK_COOLDOWN_MS = 15 * 60 * 1000; // 15 menit

function leakCooldownKey(userId) {
  return `trading:leak-cooldown:${userId}`;
}

/**
 * getLeakCooldownStatus — cek apakah user masih dalam cooldown /leak.
 * Fungsi ini TIDAK menulis apa pun — cuma membaca & membandingkan.
 */
async function getLeakCooldownStatus(userId) {
  const redis = getRedis();
  if (!redis) return { onCooldown: false }; // fail-open kalau Redis tidak dikonfigurasi

  const raw = await redis.get(leakCooldownKey(userId));
  const lastLeakAt = raw ? cleanInteger(raw) : 0;
  const now = Date.now();
  const elapsedMs = now - lastLeakAt;

  if (elapsedMs < LEAK_COOLDOWN_MS) {
    const nextAvailableAt = lastLeakAt + LEAK_COOLDOWN_MS;
    return { onCooldown: true, nextAvailableAt };
  }
  return { onCooldown: false };
}

/**
 * markLeakUsed — catat waktu pemanggilan /leak SEKARANG sebagai baseline
 * cooldown baru. Dipanggil setiap kali /leak berhasil diproses (baik
 * cuma makro gratis, maupun sekalian buka Alpha Intel).
 */
async function markLeakUsed(userId) {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(leakCooldownKey(userId), Date.now());
}

/**
 * resetLeakCooldown — dipakai saat INSIDER_PASS dikonsumsi untuk bypass
 * cooldown. Menghapus key sepenuhnya (bukan cuma set ke 0) — user boleh
 * langsung pakai /leak lagi tanpa menunggu.
 */
async function resetLeakCooldown(userId) {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(leakCooldownKey(userId));
}

/**
 * getMacroSentiment — bagian GRATIS, SELALU berhasil, tidak pernah
 * kosong. Kalau ada event aktif (jendela 5 menit dari trading.js),
 * tampilkan itu apa adanya. Kalau tidak, tampilkan narasi konsolidasi
 * netral — BUKAN error, ini kondisi normal (~85% dari waktu, karena
 * event pasar cuma 15% peluang tiap 30 menit dan TTL-nya 5 menit).
 */
async function getMacroSentiment() {
  const activeEvent = await getActiveEvent();

  if (!activeEvent) {
    return {
      hasActiveEvent: false,
      headline: '📊 Pasar Global: Konsolidasi Stabil',
      body: 'Tidak ada pergerakan makro ekstrem saat ini. Semua aset bergerak dalam rentang wajar.',
    };
  }

  const direction = activeEvent.direction > 0 ? 'BULLISH 📈' : 'BEARISH 📉';
  const targets = activeEvent.targetAssets?.length ? activeEvent.targetAssets.join(', ') : 'seluruh pasar';
  return {
    hasActiveEvent: true,
    headline: `🌐 Sentimen Makro: ${direction}`,
    body: `Event pasar sedang aktif, memengaruhi **${targets}**. Volatilitas meningkat signifikan dalam beberapa menit ke depan.`,
  };
}

/**
 * getAlphaIntel — bagian TERKUNCI (butuh 1x INSIDER_PASS). Berbeda dari
 * makro: framing lebih spesifik/personal ("kamu dapat bocoran"), dan
 * secara eksplisit mengingatkan bahwa prediksi PUBLIK sengaja acak
 * (lihat generateRandomPrediction() di trading.js untuk /market-event),
 * sedangkan Alpha Intel ini berasal dari data event aktif sesungguhnya.
 */
async function getAlphaIntel() {
  const activeEvent = await getActiveEvent();

  if (!activeEvent) {
    return {
      hasActiveEvent: false,
      headline: '🕵️ Alpha Intel: Tidak Ada Sinyal',
      body: 'Belum ada indikasi pergerakan spesifik dari sumber internal saat ini. Coba lagi nanti.',
    };
  }

  const direction = activeEvent.direction > 0 ? '📈 NAIK' : '📉 TURUN';
  const targets = activeEvent.targetAssets?.length ? activeEvent.targetAssets.join(', ') : 'SEMUA aset';
  return {
    hasActiveEvent: true,
    headline: '🕵️ Alpha Intel: Sinyal Terkonfirmasi',
    body: `Sumber internal mengonfirmasi pergerakan **${direction}** pada **${targets}** akan terjadi dalam waktu dekat.\n_(Beda dengan prediksi pengumuman publik yang sengaja acak — ini berasal dari data event aktif sesungguhnya.)_`,
  };
}

module.exports = {
  LEAK_COOLDOWN_MS,
  getLeakCooldownStatus,
  markLeakUsed,
  resetLeakCooldown,
  getMacroSentiment,
  getAlphaIntel,
};
