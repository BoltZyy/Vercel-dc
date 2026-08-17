'use strict';

const { askAI, splitMessage } = require('./aiEngine');
const { editOriginalInteractionResponse, sendFollowupMessage } = require('./discordApi');
const { getConversation, appendConversation, recordUsage } = require('./redis');
const { logErrorToChannel } = require('./errorLog');

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
 *                  Dukung 'mode' opsional (singkat/detail/kreatif).
 * - 'translate' -> system prompt override, TIDAK pakai/simpan history
 *                  (setiap terjemahan independen, tidak nyambung konteks).
 * - 'ringkas'   -> sama seperti translate, tapi system prompt beda.
 *
 * Setiap job sukses dicatat ke stats (jumlah panggilan + token kalau
 * gateway AI kirim field usage). Setiap job gagal dicatat ke channel
 * log error (kalau LOG_CHANNEL_ID dikonfigurasi).
 *
 * (/model, /avatar, /userinfo, /ping, dan command instan lain TIDAK lewat
 * modul ini — semua itu instan, dijawab langsung Type 4 di api/index.js
 * karena tidak butuh AI/deferred sama sekali.)
 * ========================================================================= */

const JOB_SYSTEM_PROMPTS = {
  translate: (targetLang) =>
    `Kamu adalah mesin penerjemah. Terjemahkan teks yang diberikan user ke dalam bahasa "${targetLang}". Balas HANYA dengan hasil terjemahan, tanpa penjelasan tambahan, tanpa tanda kutip pembuka/penutup.`,
  ringkas:
    'Kamu adalah asisten peringkas teks. Ringkas teks yang diberikan user menjadi beberapa poin inti yang jelas dan padat, dalam Bahasa Indonesia. Balas HANYA dengan hasil ringkasan.',
};

async function processAiJob({ token, channelId, userId, userMessage, isOwner, jobType = 'tanya', extra = {} }) {
  try {
    let result;

    if (jobType === 'translate') {
      const systemPromptOverride = JOB_SYSTEM_PROMPTS.translate(extra.targetLang || 'Inggris');
      // allowOwnerContext: false — /translate butuh output presisi
      // (cuma hasil terjemahan), sapaan owner akan mengalihkan model
      // dari tugas intinya. Lihat catatan di lib/aiEngine.js.
      result = await askAI({ userMessage, isOwner, history: [], systemPromptOverride, allowOwnerContext: false });
    } else if (jobType === 'ringkas') {
      // allowOwnerContext: true (default) — /ringkas tetap boleh ada
      // sapaan owner di depan, karena outputnya cukup panjang sehingga
      // tidak mendominasi/menggantikan hasil ringkasan itu sendiri.
      result = await askAI({ userMessage, isOwner, history: [], systemPromptOverride: JOB_SYSTEM_PROMPTS.ringkas });
    } else {
      const history = await getConversation(channelId, userId);
      result = await askAI({ userMessage, isOwner, history, mode: extra.mode });
    }

    const { text: replyText, usage } = result;
    const chunks = splitMessage(replyText);
    await editOriginalInteractionResponse(token, { content: chunks[0] });

    for (let i = 1; i < chunks.length; i++) {
      await sendFollowupMessage(token, { content: chunks[i] });
    }

    // History cuma relevan & disimpan untuk /tanya, bukan /translate atau /ringkas.
    if (jobType === 'tanya') {
      await appendConversation(channelId, userId, userMessage, replyText);
    }

    // Best-effort — kegagalan pencatatan stats tidak boleh menggagalkan
    // command yang sudah berhasil dijawab di atas.
    await recordUsage({
      userId,
      commandName: jobType,
      tokenCount: usage?.totalTokens,
    });
  } catch (err) {
    console.error(`[processAiJob:${jobType}] AI error:`, err.message);
    await editOriginalInteractionResponse(token, {
      content: '⚠️ Maaf, layanan AI sedang bermasalah. Coba lagi beberapa saat ya 🙏',
    }).catch(() => {});
    await logErrorToChannel({
      source: `processAiJob:${jobType}`,
      message: err.message,
      userId,
      channelId,
    });
  }
}

module.exports = { processAiJob };
