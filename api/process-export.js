const { augmentResponse } = require('../lib/resHelper');
'use strict';

const { processExportJob } = require('../lib/commands/exportChat');
const { verifyAndParseQStashRequest } = require('../lib/qstashVerify');

/* =========================================================================
 * /api/process-export — dipanggil QStash (bukan Discord langsung).
 * Sama seperti /api/process-status: baca Redis + build file + upload
 * balik ke Discord bisa >3 detik untuk riwayat panjang, jadi dipisah
 * dari request Discord awal — konsisten dengan pola /tanya dan /status.
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

  const verified = await verifyAndParseQStashRequest(req, 'process-export');
  if (!verified.ok) {
    res.status(verified.status).json({ error: verified.error });
    return;
  }

  const { token, channelId, targetUserId, format } = verified.payload || {};

  if (!token || !channelId || !targetUserId) {
    res.status(400).json({ error: 'Missing required job fields' });
    return;
  }

  try {
    await processExportJob({ token, channelId, targetUserId, format });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[process-export] Unhandled error:', err);
    res.status(500).json({ error: 'Processing failed' });
  }
};
