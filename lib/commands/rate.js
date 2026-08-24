'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId, isOwner } = require('../permissions');
const { publishAiJob } = require('../qstash');

/* =========================================================================
 * /rate {sesuatu} {mode?} — kasih rating 1-10 untuk apa pun yang diketik.
 *
 * mode:random (default) — instan, murni Math.random(), tanpa AI sama
 *   sekali, gratis, tidak kena rate-limit AI.
 * mode:ai — lewat QStash + gateway AI (sama pola dengan /tanya), jawaban
 *   lebih "kontekstual"/jenaka tapi pakai kuota & kena rate-limit AI.
 * ========================================================================= */

const FLAVOR_TEXTS = {
  low: ['Hmm, butuh perbaikan nih 😅', 'Masih jauh dari sempurna...', 'Ada usaha, tapi belum maksimal.'],
  mid: ['Lumayan lah!', 'Standar aman.', 'Not bad, not great.'],
  high: ['Keren banget! 🔥', 'Solid banget ini!', 'Wah, top tier!'],
};

function flavorFor(score) {
  const pool = score <= 3 ? FLAVOR_TEXTS.low : score <= 7 ? FLAVOR_TEXTS.mid : FLAVOR_TEXTS.high;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function handleRate(interaction, res) {
  const options = interaction.data?.options || [];
  const sesuatuOpt = options.find((o) => o.name === 'sesuatu');
  const modeOpt = options.find((o) => o.name === 'mode');

  const sesuatu = (sesuatuOpt?.value || '').trim();
  const mode = modeOpt?.value || 'random';

  if (!sesuatu) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Isi dulu apa yang mau dirating.' },
    });
    return;
  }

  if (mode === 'random') {
    const score = Math.floor(Math.random() * 11); // 0-10
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `📊 **${sesuatu}** → **${score}/10**\n${flavorFor(score)}` },
    });
    return;
  }

  // mode: ai — lewat QStash, sama pola dengan /tanya.
  const invokerId = getInvokerId(interaction);
  const invokerIsOwner = isOwner(interaction);

  const prompt = `Berikan rating 1-10 untuk "${sesuatu}" dengan gaya jenaka dan singkat (maksimal 2 kalimat). Format wajib: mulai dengan angka rating diikuti "/10", baru penjelasan singkat.`;

  try {
    await publishAiJob({
      token: interaction.token,
      channelId: interaction.channel_id,
      userId: invokerId,
      userMessage: prompt,
      isOwner: invokerIsOwner,
      jobType: 'tanya',
      extra: { mode: 'kreatif' },
    });
  } catch (err) {
    console.error('[handleRate] Failed to publish QStash job:', err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal memproses rating AI. Coba lagi beberapa saat ya 🙏' },
    });
    return;
  }

  res.status(200).json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
}

module.exports = { handleRate };
