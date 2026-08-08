'use strict';

const { askAI, splitMessage } = require('./aiEngine');
const { editOriginalInteractionResponse, sendFollowupMessage } = require('./discordApi');
const { getConversation, appendConversation } = require('./redis');

/* =========================================================================
 * processTanyaJob — dipanggil dari api/process-ai.js, SAAT QStash
 * mem-POST balik job yang dipublish oleh api/index.js. Di sinilah AI
 * benar-benar dipanggil dan hasilnya di-PATCH ke Discord.
 *
 * Request ini independen dari request Discord awal, sehingga aman
 * di-`await` sepenuhnya tanpa risiko function dibekukan sebelum tuntas.
 *
 * (/model tidak lagi lewat modul ini — sudah dijawab langsung sebagai
 * Type 4 di api/index.js karena tidak butuh AI/deferred sama sekali.)
 * ========================================================================= */
async function processTanyaJob({ token, channelId, userMessage, isOwner }) {
  try {
    const history = await getConversation(channelId);
    const replyText = await askAI({ userMessage, isOwner, history });
    const chunks = splitMessage(replyText);

    await editOriginalInteractionResponse(token, { content: chunks[0] });

    for (let i = 1; i < chunks.length; i++) {
      await sendFollowupMessage(token, { content: chunks[i] });
    }

    await appendConversation(channelId, userMessage, replyText);
  } catch (err) {
    console.error('[processTanyaJob] AI error:', err.message);
    await editOriginalInteractionResponse(token, {
      content: '⚠️ Maaf, layanan AI sedang bermasalah. Coba lagi beberapa saat ya 🙏',
    }).catch(() => {});
  }
}

module.exports = { processTanyaJob };
