const { augmentResponse } = require('../lib/resHelper');
'use strict';

const { verifyAndParseQStashRequest } = require('../lib/qstashVerify');
const { payDailyDividends, getAllUserIdsWithShares } = require('../lib/gachaEngine');
const { logErrorToChannel } = require('../lib/errorLog');

/* =========================================================================
 * /api/process-dividend — dipanggil QStash SCHEDULE (cron harian jam
 * 00:00 WIB / 17:00 UTC, di-setup SEKALI lewat
 * scripts/setup-dividend-schedule.js dari Termux, BUKAN otomatis jalan
 * begitu kode di-deploy).
 *
 * Sama seperti process-price-update.js: Schedule TIDAK mengirim body
 * sama sekali, jadi verifyAndParseQStashRequest sudah menangani body
 * kosong -> payload {} (lihat lib/qstashVerify.js).
 *
 * Membayar dividen harian ke SEMUA user yang punya minimal 1 Founder
 * Share. Idempotent — kalau job ini kebetulan retry di hari yang sama
 * (misal gagal network di tengah jalan), payDailyDividends() sendiri
 * sudah skip user yang sudah dibayar (trading:dividend-log).
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

  const verified = await verifyAndParseQStashRequest(req, 'process-dividend');
  if (!verified.ok) {
    res.status(verified.status).json({ error: verified.error });
    return;
  }

  try {
    const userIds = await getAllUserIdsWithShares();
    const result = await payDailyDividends(userIds);

    console.log(`[process-dividend] Dividen dibayar ke ${result.paidCount} user (volume kemarin: ${result.ecosystemVolumeYesterday} ZYC)`);

    res.status(200).json({ ok: true, paidCount: result.paidCount });
  } catch (err) {
    console.error('[process-dividend] Unhandled error:', err);
    await logErrorToChannel({
      source: 'process-dividend',
      message: err.message,
    }).catch(() => {});
    res.status(500).json({ error: 'Processing failed' });
  }
};
