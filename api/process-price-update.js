const { augmentResponse } = require('../lib/resHelper');
'use strict';

const { verifyAndParseQStashRequest } = require('../lib/qstashVerify');
const { getPrice, setPrice, triggerMarketEventFlow, EVENT_TYPES } = require('../lib/trading');
const { ASSET_CODES, getAssetDefinition } = require('../lib/tradingAssets');
const { CONFIG } = require('../lib/config');
const { logErrorToChannel } = require('../lib/errorLog');

/* =========================================================================
 * /api/process-price-update — dipanggil QStash SCHEDULE
 * ========================================================================= */

// Note: bodyParser bawaan Vercel dibiarkan aktif agar req.body ter-parse 
// dengan benar saat masuk ke verifikasi QStash signature.

function randomWalkStep(currentPrice, volatility, trendBias) {
  const randomFactor = (Math.random() * 2 - 1) * volatility;
  const changePercent = randomFactor + trendBias;
  return currentPrice * (1 + changePercent);
}

module.exports = async (req, res) => {
  augmentResponse(res);
  
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Verifikasi signature dari QStash
  const verified = await verifyAndParseQStashRequest(req, 'process-price-update');
  if (!verified.ok) {
    console.error('[process-price-update] Verification failed:', verified.error);
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

    // Random trigger event otomatis
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
