'use strict';

const { sendChannelMessage } = require('../lib/discordApi');
const { verifyAndParseQStashRequest } = require('../lib/qstashVerify');
const { logErrorToChannel } = require('../lib/errorLog');

/* =========================================================================
 * /api/process-remind — dipanggil QStash SETELAH delay yang diminta user
 * di /remind selesai (bisa menit hingga hari kemudian). TIDAK pakai
 * interaction token (sudah pasti kadaluarsa untuk delay >15 menit) —
 * kirim reminder pakai sendChannelMessage (Bot Token biasa, tidak pernah
 * expired) langsung ke channel tempat /remind dipanggil.
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

  const verified = await verifyAndParseQStashRequest(req, 'process-remind');
  if (!verified.ok) {
    res.status(verified.status).json({ error: verified.error });
    return;
  }

  const { userId, channelId, message } = verified.payload || {};

  if (!userId || !channelId || !message) {
    res.status(400).json({ error: 'Missing required job fields' });
    return;
  }

  try {
    await sendChannelMessage(channelId, {
      content: `⏰ <@${userId}>, ini pengingat yang kamu minta:\n> ${message}`,
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[process-remind] Unhandled error:', err);
    await logErrorToChannel({
      source: 'process-remind',
      message: err.message,
      userId,
      channelId,
    });
    res.status(500).json({ error: 'Processing failed' });
  }
};
