'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getLeaderboard } = require('../redis');

/* =========================================================================
 * /leaderboard {periode?} {metric?} — top user pemakaian bot. Default:
 * sepanjang waktu (alltime), berdasarkan jumlah panggilan. Instan, baca
 * langsung dari Redis, tidak panggil AI.
 * ========================================================================= */

async function handleLeaderboard(interaction, res) {
  const options = interaction.data?.options || [];
  const periodeOpt = options.find((o) => o.name === 'periode');
  const metricOpt = options.find((o) => o.name === 'metric');

  const scope = periodeOpt?.value || 'alltime'; // 'alltime' | 'today'
  const metric = metricOpt?.value || 'calls'; // 'calls' | 'tokens'

  const result = await getLeaderboard({ scope, metric, limit: 10 });

  if (!result) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Leaderboard tidak tersedia (Redis tidak dikonfigurasi).' },
    });
    return;
  }

  if (!result.entries.length) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '📭 Belum ada data untuk leaderboard ini.' },
    });
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const unit = metric === 'tokens' ? 'token' : 'panggilan';
  const lines = result.entries.map((e, i) => {
    const rank = medals[i] || `${i + 1}.`;
    return `${rank} <@${e.userId}> — **${e.value.toLocaleString('id-ID')}** ${unit}`;
  });

  const scopeLabel = scope === 'today' ? 'Hari Ini' : 'Sepanjang Waktu';
  const metricLabel = metric === 'tokens' ? 'Token Terpakai' : 'Jumlah Panggilan';

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: `🏆 Leaderboard — ${scopeLabel} (${metricLabel})`,
          color: 0xfee75c,
          description: lines.join('\n'),
        },
      ],
    },
  });
}

module.exports = { handleLeaderboard };
