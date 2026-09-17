const { augmentResponse } = require('../lib/resHelper');
'use strict';

const { verifyAndParseQStashRequest } = require('../lib/qstashVerify');
const { processGachaJob } = require('../lib/commands/trading/gacha');

/* =========================================================================
 * /api/process-gacha — dipanggil QStash (bukan Discord langsung).
 *
 * Menangani batch gacha 5x/10x yang loop I/O Redis-nya (baca+tulis
 * saldo/inventory/shares PER PULL, sekuensial demi konsistensi data)
 * berisiko melewati limit 3 detik interaksi Discord kalau dieksekusi
 * di request pertama. Request ini independen dan tidak terikat limit
 * itu — konsisten dengan pola /api/process-ai dan /api/process-status.
 *
 * Sengaja TIPIS: semua logic (termasuk kirim pesan error ke Discord
 * lewat editOriginalInteractionResponse) ada di processGachaJob()
 * (lib/commands/trading/gacha.js) — pola sama seperti processAiJob()
 * di lib/commands.js, supaya endpoint API cuma jadi pembungkus
 * verifikasi signature + status HTTP.
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

  const verified = await verifyAndParseQStashRequest(req, 'process-gacha');
  if (!verified.ok) {
    res.status(verified.status).json({ error: verified.error });
    return;
  }

  const { token, userId, pullCount } = verified.payload || {};

  if (!token || !userId || !pullCount) {
    res.status(400).json({ error: 'Missing required job fields' });
    return;
  }

  try {
    await processGachaJob({ token, userId, pullCount });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[process-gacha] Unhandled error:', err);
    res.status(500).json({ error: 'Processing failed' });
  }
};

