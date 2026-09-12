'use strict';

/* =========================================================================
 * DEFINISI ASET TRADING — single source of truth untuk semua aset fiktif.
 * Ubah di sini kalau mau tambah/kurang aset, ganti volatilitas, atau ubah
 * batas kuantitas per order — tidak perlu sentuh file lain.
 *
 * volatility: seberapa besar pergerakan acak per update harga (persentase
 *   maksimum, dipakai random walk di api/process-price-update.js).
 * trendBias: kecenderungan arah jangka panjang. 0 = murni acak/netral,
 *   positif = cenderung naik, negatif = cenderung turun.
 * eventSensitivity: pengali dampak saat kena event pasar (1 = normal,
 *   >1 = lebih sensitif/bereaksi lebih keras dari aset lain).
 * maxOrderQuantity: batas atas unit per SATU order /posisi (bukan batas
 *   jumlah order — itu tetap 1 order per aset per user, diatur terpisah
 *   di lib/trading.js). Silakan disesuaikan sesuka hati per aset.
 * minPrice / maxPrice: FLOOR & CEILING harga — random walk dan event
 *   pasar SELALU di-clamp ke rentang ini (lihat randomWalkStep() di
 *   api/process-price-update.js dan applyEventToPrice()/setPrice() di
 *   lib/trading.js). Ini memperbaiki bug lama di mana harga bisa
 *   turun tanpa batas mendekati/jadi 0 kalau random walk atau event
 *   bearish menekan harga berulang kali tanpa ada lantai yang wajar.
 * ========================================================================= */

const TRADING_ASSETS = {
  NORA: {
    name: 'Norium',
    emoji: '🟡',
    description: 'Stabil, volatilitas rendah — cocok buat yang main aman.',
    volatility: 0.03,
    trendBias: 0.001,
    eventSensitivity: 1.0,
    maxOrderQuantity: 100,
    startingPrice: 2500,
    minPrice: 250,
    maxPrice: 10000,
  },
  VOLT: {
    name: 'Voltacoin',
    emoji: '⚡',
    description: 'Volatilitas tinggi — bisa melesat atau anjlok ekstrem dalam waktu singkat.',
    volatility: 0.10,
    trendBias: -0.001,
    eventSensitivity: 2.0,
    maxOrderQuantity: 1000,
    startingPrice: 200,
    minPrice: 20,
    maxPrice: 1200,
  },
  KRYN: {
    name: 'Krynite',
    emoji: '📈',
    description: 'Punya "musim" — kecenderungan arah jangka panjang, naik/turun berkelanjutan.',
    volatility: 0.05,
    trendBias: 0,
    eventSensitivity: 1.2,
    maxOrderQuantity: 250,
    startingPrice: 1000,
    minPrice: 100,
    maxPrice: 5000,
  },
  PLUM: {
    name: 'Plumeria',
    emoji: '🛢️',
    description: 'Tenang secara normal, tapi paling sensitif kalau ada event pasar besar.',
    volatility: 0.07,
    trendBias: 0,
    eventSensitivity: 1.5,
    maxOrderQuantity: 500,
    startingPrice: 500,
    minPrice: 50,
    maxPrice: 2500,
  },
};

const ASSET_CODES = Object.keys(TRADING_ASSETS);

function isValidAssetCode(code) {
  return ASSET_CODES.includes((code || '').toUpperCase());
}

function getAssetDefinition(code) {
  return TRADING_ASSETS[(code || '').toUpperCase()] || null;
}

module.exports = { TRADING_ASSETS, ASSET_CODES, isValidAssetCode, getAssetDefinition };
