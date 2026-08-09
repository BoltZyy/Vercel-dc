'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { CONFIG } = require('../config');
const { canUseSay, getInvokerId } = require('../permissions');
const { sendChannelMessage } = require('../discordApi');
const { logSayCommand } = require('../redis');

/* =========================================================================
 * /say {pesan} {channel?} — bot kirim pesan atas nama bot.
 * Akses: Owner (di server manapun) ATAU user dengan izin ManageMessages
 * di server tempat command dipanggil.
 * Logging dual: channel log privat (real-time) + Redis (permanen).
 * ========================================================================= */

async function handleSay(interaction, res) {
  if (!canUseSay(interaction)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❌ Kamu butuh izin **Manage Messages** untuk pakai command ini.' },
    });
    return;
  }

  const options = interaction.data?.options || [];
  const pesanOpt = options.find((o) => o.name === 'pesan');
  const channelOpt = options.find((o) => o.name === 'channel');
  const content = (pesanOpt?.value || '').trim();
  const targetChannelId = channelOpt?.value || interaction.channel_id;

  if (!content) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Isi pesan wajib diisi.' },
    });
    return;
  }

  const invokerId = getInvokerId(interaction);
  const invokerUsername =
    interaction.member?.user?.username || interaction.user?.username || 'unknown';

  try {
    await sendChannelMessage(targetChannelId, { content });
  } catch (err) {
    console.error('[handleSay] Failed to send message:', err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal mengirim pesan (cek permission bot di channel tujuan).' },
    });
    return;
  }

  // --- Dual logging: Redis (permanen) + channel log Discord (real-time) ---
  // Keduanya best-effort — kegagalan log TIDAK menggagalkan command utama,
  // karena pesan sudah terlanjur terkirim di atas.
  await logSayCommand({
    userId: invokerId,
    username: invokerUsername,
    channelId: targetChannelId,
    content,
  });

  if (CONFIG.LOG_CHANNEL_ID) {
    sendChannelMessage(CONFIG.LOG_CHANNEL_ID, {
      embeds: [
        {
          title: '📢 /say digunakan',
          color: 0xfee75c,
          fields: [
            { name: 'Oleh', value: `<@${invokerId}> (\`${invokerUsername}\`)`, inline: true },
            { name: 'Channel tujuan', value: `<#${targetChannelId}>`, inline: true },
            { name: 'Isi pesan', value: content.slice(0, 1000) },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    }).catch((err) => console.error('[handleSay] Failed to send log:', err.message));
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `✅ Pesan terkirim ke <#${targetChannelId}>.`, flags: 64 }, // 64 = EPHEMERAL
  });
}

module.exports = { handleSay };
