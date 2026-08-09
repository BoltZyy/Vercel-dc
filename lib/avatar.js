'use strict';

const { InteractionResponseType } = require('discord-interactions');

/* =========================================================================
 * /avatar {user?} — tampilkan avatar user (default: pemanggil sendiri).
 * Instan, tidak butuh AI/Redis — dijawab langsung Type 4.
 * ========================================================================= */

function buildAvatarUrl(userId, avatarHash, discriminator) {
  if (avatarHash) {
    const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=1024`;
  }
  // User belum pernah set avatar custom -> avatar default Discord.
  // Sistem username baru (tanpa discriminator #0000) pakai formula
  // berbeda dari sistem lama.
  const index =
    discriminator && discriminator !== '0'
      ? Number(discriminator) % 5
      : Number((BigInt(userId) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

async function handleAvatar(interaction, res) {
  const options = interaction.data?.options || [];
  const userOpt = options.find((o) => o.name === 'user');
  const resolvedUsers = interaction.data?.resolved?.users || {};

  let targetId;
  let targetUser;

  if (userOpt) {
    targetId = userOpt.value;
    targetUser = resolvedUsers[targetId];
  } else {
    targetId = interaction.member?.user?.id || interaction.user?.id;
    targetUser = interaction.member?.user || interaction.user;
  }

  if (!targetUser) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Tidak bisa menemukan user itu.' },
    });
    return;
  }

  const avatarUrl = buildAvatarUrl(targetId, targetUser.avatar, targetUser.discriminator);
  const displayName = targetUser.global_name || targetUser.username;

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: `🖼️ Avatar ${displayName}`,
          color: 0x5865f2,
          image: { url: avatarUrl },
        },
      ],
    },
  });
}

module.exports = { handleAvatar };
