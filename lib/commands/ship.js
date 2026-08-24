'use strict';

const { InteractionResponseType } = require('discord-interactions');

/* =========================================================================
 * /ship {user1} {user2} — persentase "kecocokan" random dua user, dengan
 * progress bar visual (karakter blok) dan warna embed sesuai persentase.
 * Instan, murni deterministic-hash dari kombinasi ID, tanpa AI/Redis.
 * ========================================================================= */

const FILLED_BLOCK = '█';
const EMPTY_BLOCK = '░';
const BAR_LENGTH = 10;

function buildProgressBar(percentage) {
  const filledCount = Math.round((percentage / 100) * BAR_LENGTH);
  return FILLED_BLOCK.repeat(filledCount) + EMPTY_BLOCK.repeat(BAR_LENGTH - filledCount);
}

function colorFor(percentage) {
  if (percentage < 30) return 0xed4245; // merah
  if (percentage < 70) return 0xfee75c; // kuning
  return 0xeb459e; // pink (love)
}

function flavorFor(percentage) {
  if (percentage < 20) return 'Hmm, mungkin lebih cocok jadi rival 😅';
  if (percentage < 40) return 'Ada potensi, tapi masih perlu usaha lebih.';
  if (percentage < 60) return 'Lumayan seimbang nih!';
  if (percentage < 80) return 'Wih, chemistry-nya kerasa! 💕';
  if (percentage < 100) return 'Perfect match! Cocok banget! 💘';
  return 'SOULMATE SEJATI! 💯🔥';
}

async function handleShip(interaction, res) {
  const options = interaction.data?.options || [];
  const user1Opt = options.find((o) => o.name === 'user1');
  const user2Opt = options.find((o) => o.name === 'user2');

  const user1Id = user1Opt?.value;
  const user2Id = user2Opt?.value;

  if (!user1Id || !user2Id) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Pilih dua user yang mau di-ship.' },
    });
    return;
  }

  // Seed sederhana dari kombinasi 2 ID supaya hasil KONSISTEN untuk
  // pasangan yang sama (bukan acak ulang tiap kali dipanggil) — lebih
  // memuaskan untuk fitur "kecocokan" yang sifatnya seharusnya tetap.
  const combined = [user1Id, user2Id].sort().join('');
  let seed = 0;
  for (let i = 0; i < combined.length; i++) {
    seed = (seed * 31 + combined.charCodeAt(i)) % 1000000007;
  }
  const percentage = seed % 101; // 0-100

  const bar = buildProgressBar(percentage);
  const color = colorFor(percentage);
  const flavor = flavorFor(percentage);

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: '💘 Ship-o-Meter',
          color,
          description: [
            `<@${user1Id}> × <@${user2Id}>`,
            '',
            `\`${bar}\` **${percentage}%**`,
            '',
            flavor,
          ].join('\n'),
        },
      ],
    },
  });
}

module.exports = { handleShip };
