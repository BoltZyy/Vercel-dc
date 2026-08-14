'use strict';

const { processStatusJob } = require('../lib/commands/status');
const { verifyAndParseQStashRequest } = require('../lib/qstashVerify');

/* =========================================================================
 * /api/process-status — dipanggil QStash (bukan Discord langsung).
 * Sama seperti /api/process-ai, tapi khusus job /status: melakukan 3
 * network check (Redis/QStash/gateway AI) yang totalnya bisa >3 detik,
 * jadi dipisah dari request Discord awal — konsisten dengan pola /tanya.
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

  const verified = await verifyAndParseQStashRequest(req, 'process-status');
  if (!verified.ok) {
    res.status(verified.status).json({ error: verified.error });
    return;
  }

  const { token } = verified.payload || {};

  if (!token) {
    res.status(400).json({ error: 'Missing required job fields' });
    return;
  }

  try {
    await processStatusJob({ token });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[process-status] Unhandled error:', err);
    res.status(500).json({ error: 'Processing failed' });
  }
};
