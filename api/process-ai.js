'use strict';

const { processAiJob } = require('../lib/commands');
const { verifyAndParseQStashRequest } = require('../lib/qstashVerify');

/* =========================================================================
 * /api/process-ai — dipanggil QStash (bukan Discord langsung).
 *
 * Ini request HTTP independen yang terpisah total dari request pertama
 * Discord -> /api. Karena request ini "hidup" untuk melayani dirinya
 * sendiri, kita bisa dengan aman `await` proses AI yang lama tanpa
 * takut function dibekukan sebelum tuntas — beda dengan kalau kita coba
 * lanjut proses di background setelah response Discord awal terkirim.
 *
 * WAJIB verifikasi signature QStash di sini, supaya endpoint ini tidak
 * bisa dipanggil sembarang orang untuk memicu pemrosesan AI/biaya API
 * tanpa izin.
 * ========================================================================= */

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

  const verified = await verifyAndParseQStashRequest(req, 'process-ai');
  if (!verified.ok) {
    res.status(verified.status).json({ error: verified.error });
    return;
  }

  const { token, channelId, userId, userMessage, isOwner, jobType, extra } = verified.payload || {};

  if (!token || !userMessage) {
    res.status(400).json({ error: 'Missing required job fields' });
    return;
  }

  // Proses AI sepenuhnya di-await di sini — request ini independen,
  // aman untuk berjalan sampai tuntas sebelum response dikirim.
  try {
    await processAiJob({ token, channelId, userId, userMessage, isOwner, jobType, extra });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[process-ai] Unhandled error:', err);
    res.status(500).json({ error: 'Processing failed' });
  }
};
