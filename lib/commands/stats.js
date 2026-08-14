'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { isOwner } = require('../permissions');
const { getStats } = require('../redis');

/* =========================================================================
 * /stats — ringkasan pemakaian command AI hari ini: total panggilan,
 * total token (kalau gateway AI kirim field usage), breakdown per
 * command, top user. Owner-only, instan (baca dari Redis).
 * ========================================================================= */

async function handleStats(interaction, res) {
  if (!isOwner(interaction)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❌ Command ini khusus Owner.' },
    });
    return;
  }

  const stats = await getStats();

  if (!stats) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Stats tidak tersedia (Redis tidak dikonfigurasi).' },
    });
    return;
  }

  const commandBreakdown =
    Object.entries(stats.byCommand)
      .map(([cmd, count]) => `\`/${cmd}\`: ${count}x`)
      .join(' • ') || '—';

  const topUsersText =
    stats.topUsers.map((u, i) => `${i + 1}. <@${u.userId}> — ${u.count}x panggilan`).join('\n') ||
    'Belum ada data.';

  const fields = [
    { name: 'Total Panggilan', value: `${stats.totalCalls}`, inline: true },
    {
      name: 'Total Token',
      value: stats.totalTokens > 0 ? `${stats.totalTokens.toLocaleString('id-ID')}` : 'Tidak tersedia*',
      inline: true,
    },
    { name: 'Breakdown Command', value: commandBreakdown, inline: false },
    { name: 'Top User (Panggilan)', value: topUsersText, inline: false },
  ];

  if (stats.topTokenUsers.length) {
    const topTokenText = stats.topTokenUsers
      .map((u, i) => `${i + 1}. <@${u.userId}> — ${u.tokens.toLocaleString('id-ID')} token`)
      .join('\n');
    fields.push({ name: 'Top User (Token)', value: topTokenText, inline: false });
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: `📊 Stats Bot — ${stats.day}`,
          color: 0x57f287,
          fields,
          footer: {
            text:
              stats.totalTokens > 0
                ? 'Data hari ini (UTC), reset otomatis tiap hari.'
                : '*Gateway AI kamu belum/tidak kirim field usage token — cuma jumlah panggilan yang tercatat.',
          },
        },
      ],
    },
  });
}

module.exports = { handleStats };
