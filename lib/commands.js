'use strict';

const { askAI, splitMessage } = require('./aiEngine');
const { editOriginalInteractionResponse, sendFollowupMessage } = require('./discordApi');
const { getConversation, appendConversation } = require('./redis');

/* =========================================================================
 * processAiJob — dipanggil dari api/process-ai.js, SAAT QStash mem-POST
 * balik job yang dipublish oleh api/index.js. Di sinilah AI benar-benar
 * dipanggil dan hasilnya di-PATCH ke Discord.
 *
 * Request ini independen dari request Discord awal, sehingga aman
 * di-`await` sepenuhnya tanpa risiko function dibekukan sebelum tuntas.
 *
 * jobType membedakan perilaku:
 * - 'tanya'     -> pakai conversation history, simpan balik ke history.
 * - 'translate' -> system prompt override, TIDAK pakai/simpan history
 *                  (setiap terjemahan independen, tidak nyambung konteks).
 * - 'ringkas'   -> sama seperti translate, tapi system prompt beda.
 *
 * (/model, /avatar, /userinfo, /ping, dan command moderasi TIDAK lewat
 * modul ini — semua itu instan, dijawab langsung Type 4 di api/index.js
 * karena tidak butuh AI/deferred sama sekali.)
 * ========================================================================= */

const JOB_SYSTEM_PROMPTS = {
  translate: (targetLang) =>
    `Kamu adalah mesin penerjemah. Terjemahkan teks yang diberikan user ke dalam bahasa "${targetLang}". Balas HANYA dengan hasil terjemahan, tanpa penjelasan tambahan, tanpa tanda kutip pembuka/penutup.`,
  ringkas:
    'Kamu adalah asisten peringkas teks. Ringkas teks yang diberikan user menjadi beberapa poin inti yang jelas dan padat, dalam Bahasa Indonesia. Balas HANYA dengan hasil ringkasan.',
};

async function processAiJob({ token, channelId, userMessage, isOwner, jobType = 'tanya', extra = {} }) {
  try {
    let replyText;

    if (jobType === 'translate') {
      const systemPromptOverride = JOB_SYSTEM_PROMPTS.translate(extra.targetLang || 'Inggris');
      replyText = await askAI({ userMessage, isOwner, history: [], systemPromptOverride });
    } else if (jobType === 'ringkas') {
      replyText = await askAI({ userMessage, isOwner, history: [], systemPromptOverride: JOB_SYSTEM_PROMPTS.ringkas });
    } else {
      const history = await getConversation(channelId);
      replyText = await askAI({ userMessage, isOwner, history });
    }

    const chunks = splitMessage(replyText);
    await editOriginalInteractionResponse(token, { content: chunks[0] });

    for (let i = 1; i < chunks.length; i++) {
      await sendFollowupMessage(token, { content: chunks[i] });
    }

    // History cuma relevan & disimpan untuk /tanya, bukan /translate atau /ringkas.
    if (jobType === 'tanya') {
      await appendConversation(channelId, userMessage, replyText);
    }
  } catch (err) {
    console.error(`[processAiJob:${jobType}] AI error:`, err.message);
    await editOriginalInteractionResponse(token, {
      content: '⚠️ Maaf, layanan AI sedang bermasalah. Coba lagi beberapa saat ya 🙏',
    }).catch(() => {});
  }
}

module.exports = { processAiJob };
