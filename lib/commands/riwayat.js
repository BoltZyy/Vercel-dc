'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getConversation } = require('../redis');

/* =========================================================================
 * /riwayat — lihat ringkasan riwayat percakapan AI yang tersimpan untuk
 * channel ini. Instan (baca langsung dari Redis), tidak panggil AI.
 * ========================================================================= */

async function handleRiwayat(interaction, res) {
  const channelId = interaction.channel_id;
  const history = await getConversation(channelId);

  if (!history.length) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '📭 Belum ada riwayat percakapan tersimpan di channel ini.' },
    });
    return;
  }

  const pairCount = Math.floor(history.length / 2);
  const preview = history
    .slice(-6) // 3 pasang terakhir maksimal
    .map((m) => {
      const label = m.role === 'user' ? '🙋 User' : '🤖 Bot';
      const text = m.content.length > 120 ? `${m.content.slice(0, 120)}...` : m.content;
      return `**${label}:** ${text}`;
    })
    .join('\n\n');

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: '🗂️ Riwayat Percakapan',
          color: 0x5865f2,
          description: `Tersimpan **${pairCount} pasang** pesan (user + bot) di channel ini.\n\n**3 terakhir:**\n${preview}`,
          footer: { text: 'Pakai /reset untuk menghapus riwayat ini.' },
        },
      ],
    },
  });
}

module.exports = { handleRiwayat };
