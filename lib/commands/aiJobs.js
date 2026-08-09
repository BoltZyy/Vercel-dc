'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { CONFIG } = require('../config');
const { getInvokerId } = require('../permissions');
const { publishAiJob } = require('../qstash');

/* =========================================================================
 * /translate {teks} {bahasa} dan /ringkas {teks}
 * Sama seperti /tanya: butuh panggil AI (bisa lama), jadi TIDAK diproses
 * langsung di request pertama — cuma publish job ke QStash lalu balas
 * deferred (Type 5). Eksekusi sesungguhnya terjadi di /api/process-ai
 * lewat processAiJob() dengan jobType yang sesuai.
 * ========================================================================= */

async function queueTranslate(interaction, res) {
  const options = interaction.data?.options || [];
  const teksOpt = options.find((o) => o.name === 'teks');
  const bahasaOpt = options.find((o) => o.name === 'bahasa');
  const userMessage = (teksOpt?.value || '').trim();
  const targetLang = (bahasaOpt?.value || 'Inggris').trim();

  if (!userMessage) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Isi teks yang mau diterjemahkan.' },
    });
    return;
  }

  await queueGenericAiJob(interaction, res, {
    jobType: 'translate',
    userMessage,
    extra: { targetLang },
  });
}

async function queueRingkas(interaction, res) {
  const options = interaction.data?.options || [];
  const teksOpt = options.find((o) => o.name === 'teks');
  const userMessage = (teksOpt?.value || '').trim();

  if (!userMessage) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Isi teks yang mau diringkas.' },
    });
    return;
  }

  await queueGenericAiJob(interaction, res, { jobType: 'ringkas', userMessage, extra: {} });
}

async function queueGenericAiJob(interaction, res, { jobType, userMessage, extra }) {
  const invokerId = getInvokerId(interaction);
  const isOwner = invokerId === CONFIG.OWNER_ID;

  try {
    await publishAiJob({
      token: interaction.token,
      channelId: interaction.channel_id,
      userMessage,
      isOwner,
      jobType,
      extra,
    });
  } catch (err) {
    console.error(`[queueGenericAiJob:${jobType}] Failed to publish QStash job:`, err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal menjadwalkan proses AI. Coba lagi beberapa saat ya 🙏' },
    });
    return;
  }

  res.status(200).json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
}

module.exports = { queueTranslate, queueRingkas };
