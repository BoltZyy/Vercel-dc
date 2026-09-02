'use strict';

/* =========================================================================
 * DEFINISI ASET TRADING — single source of truth untuk semua aset fiktif.
 * Ubah di sini kalau mau tambah/kurang aset, ganti volatilitas, atau ubah
 * batas kuantitas per order — tidak perlu sentuh file lain.
 *
 * volatility: seberapa besar pergerakan acak per update harga (persentase
 *   maksimum, dipakai random walk di lib/pricingEngine.js).
 * trendBias: kecenderungan arah jangka panjang. 0 = murni acak/netral,
 *   positif = cenderung naik, negatif = cenderung turun. Dipakai KRYN
 *   untuk simulasi "musim" bullish/bearish.
 * eventSensitivity: pengali dampak saat kena event pasar (1 = normal,
 *   >1 = lebih sensitif/bereaksi lebih keras dari aset lain).
 * maxOrderQuantity: batas atas unit per SATU order /posisi (bukan batas
 *   jumlah order — itu tetap 1 order per aset per user, diatur terpisah
 *   di lib/trading.js). Silakan disesuaikan sesuka hati per aset.
 * ========================================================================= */

const TRADING_ASSETS = {
  NORA: {
    name: 'Norium',
    emoji: '🟡',
    description: 'Stabil, volatilitas rendah — cocok buat yang main aman.',
    volatility: 0.02,
    trendBias: 0,
    eventSensitivity: 0.5,
    maxOrderQuantity: 50,
    startingPrice: 100,
  },
  VOLT: {
    name: 'Voltacoin',
    emoji: '⚡',
    description: 'Volatilitas tinggi — bisa melesat atau anjlok ekstrem dalam waktu singkat.',
    volatility: 0.12,
    trendBias: 0,
    eventSensitivity: 1.2,
    maxOrderQuantity: 15,
    startingPrice: 50,
  },
  KRYN: {
    name: 'Krynite',
    emoji: '📈',
    description: 'Punya "musim" — kecenderungan arah jangka panjang, naik/turun berkelanjutan.',
    volatility: 0.05,
    trendBias: 0.01,
    eventSensitivity: 1.0,
    maxOrderQuantity: 25,
    startingPrice: 75,
  },
  PLUM: {
    name: 'Plumeria',
    emoji: '🛢️',
    description: 'Tenang secara normal, tapi paling sensitif kalau ada event pasar besar.',
    volatility: 0.03,
    trendBias: 0,
    eventSensitivity: 2.0,
    maxOrderQuantity: 30,
    startingPrice: 120,
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
