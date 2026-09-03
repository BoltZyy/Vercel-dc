const { augmentResponse } = require('../lib/resHelper');
'use strict';

const { verifyAndParseQStashRequest } = require('../lib/qstashVerify');
const { triggerMarketEventFlow } = require('../lib/trading');
const { editOriginalInteractionResponse } = require('../lib/discordApi');
const { logErrorToChannel } = require('../lib/errorLog');

/* =========================================================================
 * /api/process-market-event-trigger — dipanggil QStash (bukan Discord
 * langsung), SEGERA setelah /market-event dipanggil (bukan delay).
 *
 * Menjalankan triggerMarketEventFlow() (kirim pengumuman T-1 menit +
 * publish delay job kedua ke /api/process-market-event yang nanti
 * benar-benar mengubah harga di T+1 menit) — dipisah dari command asli
 * karena network call ganda ini berisiko >3 detik kalau dijalankan
 * langsung di request pertama Discord.
 *
 * BUKAN untuk dikelirukan dengan /api/process-market-event (endpoint
 * lain yang dipanggil 60 DETIK KEMUDIAN untuk benar-benar mengubah
 * harga + eksekusi order pending).
 * ========================================================================= */

module.exports.config = {
  api: {
    bodyParser: false,
  },
};

module.exports = async (req, res) => {
  augmentResponse(res);
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const verified = await verifyAndParseQStashRequest(req, 'process-market-event-trigger');
  if (!verified.ok) {
    res.status(verified.status).json({ error: verified.error });
    return;
  }

  const { token, eventType, targetAssets } = verified.payload || {};
  if (!token || !eventType) {
    res.status(400).json({ error: 'Missing required job fields' });
    return;
  }

  try {
    const result = await triggerMarketEventFlow(eventType, targetAssets);

    if (!result.ok) {
      await editOriginalInteractionResponse(token, { content: `⚠️ ${result.error}` });
      res.status(200).json({ ok: false });
      return;
    }

    await editOriginalInteractionResponse(token, {
      content: `✅ Event **${result.eventData.label}** dijadwalkan. Pengumuman terkirim, harga akan berubah dalam 1 menit.`,
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[process-market-event-trigger] Unhandled error:', err);
    await editOriginalInteractionResponse(token, {
      content: '⚠️ Gagal memicu event. Coba lagi beberapa saat ya 🙏',
    }).catch(() => {});
    await logErrorToChannel({ source: 'process-market-event-trigger', message: err.message });
    res.status(500).json({ error: 'Processing failed' });
  }
};
