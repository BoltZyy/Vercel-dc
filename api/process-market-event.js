'use strict';

const { verifyAndParseQStashRequest } = require('../lib/qstashVerify');
const {
  applyEventToPrice,
  isAssetTargetedByEvent,
  executeOrderAtEventPrice,
} = require('../lib/trading');
const { ASSET_CODES } = require('../lib/tradingAssets');
const { getRedis } = require('../lib/redis');
const { sendChannelMessage } = require('../lib/discordApi');
const { CONFIG } = require('../lib/config');
const { logErrorToChannel } = require('../lib/errorLog');

/* =========================================================================
 * /api/process-market-event — dipanggil QStash TEPAT 60 detik setelah
 * event di-trigger (T+1 menit). Di sinilah harga BENERAN berubah, dan
 * semua order pending ("/posisi") yang relevan dieksekusi di harga
 * SETELAH event ini (bukan harga saat order dipasang).
 *
 * Base magnitude pergerakan harga: dikalikan eventSensitivity tiap aset
 * di applyEventToPrice() — jadi PLUM (sensitivity 2.0) bergerak 2x lebih
 * jauh dari NORA (sensitivity 0.5) untuk event yang sama.
 * ========================================================================= */

const BASE_EVENT_MAGNITUDE = 0.15; // 15% pergerakan dasar, sebelum dikali sensitivity aset

module.exports.config = {
  api: {
    bodyParser: false,
  },
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const verified = await verifyAndParseQStashRequest(req, 'process-market-event');
  if (!verified.ok) {
    res.status(verified.status).json({ error: verified.error });
    return;
  }

  const { eventData } = verified.payload || {};
  if (!eventData) {
    res.status(400).json({ error: 'Missing eventData in job payload' });
    return;
  }

  try {
    const affectedAssets = ASSET_CODES.filter((code) => isAssetTargetedByEvent(code, eventData));
    const priceChanges = {};
    for (const code of affectedAssets) {
      priceChanges[code] = await applyEventToPrice(code, eventData, BASE_EVENT_MAGNITUDE);
    }

    // Cari & eksekusi semua order pending untuk aset yang terdampak.
    // Order disimpan per user+aset (trading:order:{userId}:{asset}), jadi
    // SCAN key dengan pattern per aset untuk temukan semua user yang
    // punya order pending pada aset itu.
    const redis = getRedis();
    const executionSummary = [];

    if (redis) {
      for (const assetCode of affectedAssets) {
        const pattern = `trading:order:*:${assetCode}`;
        let cursor = 0;
        const userIdsWithOrder = [];

        do {
          const [nextCursor, keys] = await redis.scan(cursor, { match: pattern, count: 100 });
          cursor = Number(nextCursor);
          for (const key of keys) {
            const parts = key.split(':');
            const userId = parts[2];
            if (userId) userIdsWithOrder.push(userId);
          }
        } while (cursor !== 0);

        for (const userId of userIdsWithOrder) {
          const outcome = await executeOrderAtEventPrice(userId, assetCode);
          if (outcome.executed) {
            executionSummary.push({ userId, assetCode, ...outcome.result });
          } else if (outcome.cancelled) {
            executionSummary.push({ userId, assetCode, cancelled: true, reason: outcome.reason });
          }
        }
      }
    }

    const announcementChannelId = CONFIG.MARKET_ANNOUNCEMENT_CHANNEL_ID || CONFIG.LOG_CHANNEL_ID;
    if (announcementChannelId) {
      const priceLines = affectedAssets
        .map((code) => `**${code}**: 💵 ${priceChanges[code].toLocaleString('id-ID')} ZYC`)
        .join('\n');

      const executedCount = executionSummary.filter((e) => !e.cancelled).length;
      const cancelledCount = executionSummary.filter((e) => e.cancelled).length;

      await sendChannelMessage(announcementChannelId, {
        embeds: [
          {
            title: `💥 Event Terjadi: ${eventData.label}!`,
            color: eventData.direction > 0 ? 0x57f287 : 0xed4245,
            description: [
              `Harga bergerak drastis:`,
              priceLines,
              '',
              executedCount > 0 ? `✅ ${executedCount} posisi pending dieksekusi.` : '',
              cancelledCount > 0 ? `⚠️ ${cancelledCount} posisi dibatalkan (saldo/aset tidak cukup saat eksekusi).` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      }).catch((err) => console.error('[process-market-event] Failed to send result announcement:', err.message));
    }

    res.status(200).json({ ok: true, priceChanges, executionSummary });
  } catch (err) {
    console.error('[process-market-event] Unhandled error:', err);
    await logErrorToChannel({ source: 'process-market-event', message: err.message });
    res.status(500).json({ error: 'Processing failed' });
  }
};
