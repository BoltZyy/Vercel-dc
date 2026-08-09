'use strict';

const { InteractionResponseType } = require('discord-interactions');

/* =========================================================================
 * /ping — cek bot hidup & ukur latency kasar (waktu terima interaction
 * sampai response dikirim). Instan, tidak butuh AI/Redis.
 * ========================================================================= */

async function handlePing(interaction, res, receivedAt) {
  const latencyMs = Date.now() - receivedAt;
  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `🏓 Pong! (${latencyMs}ms)` },
  });
}

module.exports = { handlePing };
