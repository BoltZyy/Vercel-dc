'use strict';

const { verifyAndParseQStashRequest } = require('../lib/qstashVerify');
const { getPrice, setPrice, triggerMarketEventFlow, EVENT_TYPES } = require('../lib/trading');
const { ASSET_CODES, getAssetDefinition } = require('../lib/tradingAssets');
const { CONFIG } = require('../lib/config');
const { logErrorToChannel } = require('../lib/errorLog');

/* =========================================================================
 * /api/process-price-update — dipanggil QStash SCHEDULE (cron recurring,
 * di-setup SEKALI lewat scripts/setup-price-schedule.js dari Termux, BUKAN
 * otomatis jalan begitu kode di-deploy).
 *
 * Menjalankan random walk harga normal (BUKAN event) untuk semua aset:
 * harga baru = harga lama * (1 + acak antara -volatility s/d +volatility),
 * dengan trendBias sebagai pergeseran tambahan (dipakai KRYN buat efek
 * "musim" bullish/bearish jangka panjang).
 * ========================================================================= */

module.exports.config = {
  api: {
    bodyParser: false,
  },
};

function randomWalkStep(currentPrice, volatility, trendBias) {
  const randomFactor = (Math.random() * 2 - 1) * volatility;
  const changePercent = randomFactor + trendBias;
  return currentPrice * (1 + changePercent);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const verified = await verifyAndParseQStashRequest(req, 'process-price-update');
  if (!verified.ok) {
    res.status(verified.status).json({ error: verified.error });
    return;
  }

  try {
    const updates = {};
    for (const code of ASSET_CODES) {
      const def = getAssetDefinition(code);
      const currentPrice = await getPrice(code);
      const newPrice = randomWalkStep(currentPrice, def.volatility, def.trendBias);
      updates[code] = await setPrice(code, newPrice);
    }

    console.log('[process-price-update] Prices updated:', JSON.stringify(updates));

    // Random trigger event otomatis — TERPISAH dari random walk harga di
    // atas. Kalau kena (RANDOM_EVENT_CHANCE, default 15%), event dipicu
    // via triggerMarketEventFlow (fungsi SAMA dengan /market-event manual)
    // — jadi harga aset yang BARU SAJA di-update di atas akan berubah
    // LAGI sekali lagi nanti (60 detik dari sekarang) via event terpisah.
    // Ini bukan bug — event memang dimaksudkan sebagai lapisan pergerakan
    // TAMBAHAN di atas random walk normal, bukan pengganti.
    let eventTriggered = null;
    if (Math.random() < CONFIG.RANDOM_EVENT_CHANCE) {
      const randomType = Math.random() < 0.5 ? 'BULLISH' : 'BEARISH';
      const eventResult = await triggerMarketEventFlow(randomType, null); // null = semua aset
      if (eventResult.ok) {
        eventTriggered = eventResult.eventData;
        console.log('[process-price-update] Random event triggered:', eventTriggered.label);
      } else {
        console.error('[process-price-update] Random event trigger failed:', eventResult.error);
      }
    }

    res.status(200).json({ ok: true, updates, eventTriggered });
  } catch (err) {
    console.error('[process-price-update] Unhandled error:', err);
    await logErrorToChannel({ source: 'process-price-update', message: err.message });
    res.status(500).json({ error: 'Processing failed' });
  }
};
