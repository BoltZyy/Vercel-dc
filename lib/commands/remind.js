'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../permissions');
const { publishRemindJob } = require('../qstash');
const { parseReminderTime } = require('../timeParser');

/* =========================================================================
 * /remind {waktu} {pesan} — jadwalkan pengingat via QStash delay. TIDAK
 * pakai interaction token untuk kirim reminder-nya nanti (token cuma
 * valid ~15 menit, reminder bisa sampai 30 hari ke depan) — sebagai
 * gantinya, job menyimpan channelId & userId, dan pengiriman reminder
 * nanti pakai sendChannelMessage (Bot Token biasa) via
 * api/process-remind.js.
 *
 * Instan di request pertama (cuma publish job + validasi), TIDAK butuh
 * deferred — publish ke QStash biasanya <1 detik.
 * ========================================================================= */

async function handleRemind(interaction, res) {
  const options = interaction.data?.options || [];
  const waktuOpt = options.find((o) => o.name === 'waktu');
  const pesanOpt = options.find((o) => o.name === 'pesan');

  const waktuInput = (waktuOpt?.value || '').trim();
  const pesanInput = (pesanOpt?.value || '').trim();

  if (!waktuInput || !pesanInput) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Isi `waktu` dan `pesan` keduanya ya.' },
    });
    return;
  }

  const parsed = parseReminderTime(waktuInput);
  if (!parsed.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ ${parsed.error}` },
    });
    return;
  }

  const invokerId = getInvokerId(interaction);
  const channelId = interaction.channel_id;

  try {
    await publishRemindJob(
      { userId: invokerId, channelId, message: pesanInput },
      parsed.delaySeconds
    );
  } catch (err) {
    console.error('[handleRemind] Failed to publish QStash job:', err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal menjadwalkan reminder. Coba lagi beberapa saat ya 🙏' },
    });
    return;
  }

  const targetTimestamp = Math.floor(parsed.targetDate.getTime() / 1000);
  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: `⏰ Oke, aku akan ingatkan kamu <t:${targetTimestamp}:R> (<t:${targetTimestamp}:f>):\n> ${pesanInput}`,
    },
  });
}

module.exports = { handleRemind };
