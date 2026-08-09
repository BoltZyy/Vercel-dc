'use strict';

const { InteractionResponseType } = require('discord-interactions');

/* =========================================================================
 * /userinfo {user?} — info dasar akun: dibuat kapan, join server kapan,
 * role apa saja. Semua dari payload interaction, tanpa API call tambahan.
 * ========================================================================= */

// Discord Snowflake ID encode timestamp pembuatan akun di dalamnya.
const DISCORD_EPOCH = 1420070400000n;

function snowflakeToDate(snowflake) {
  const ms = (BigInt(snowflake) >> 22n) + DISCORD_EPOCH;
  return new Date(Number(ms));
}

function formatDate(date) {
  return `<t:${Math.floor(date.getTime() / 1000)}:F> (<t:${Math.floor(date.getTime() / 1000)}:R>)`;
}

async function handleUserinfo(interaction, res) {
  const options = interaction.data?.options || [];
  const userOpt = options.find((o) => o.name === 'user');
  const resolvedUsers = interaction.data?.resolved?.users || {};
  const resolvedMembers = interaction.data?.resolved?.members || {};

  let targetId;
  let targetUser;
  let targetMember;

  if (userOpt) {
    targetId = userOpt.value;
    targetUser = resolvedUsers[targetId];
    targetMember = resolvedMembers[targetId];
  } else {
    targetId = interaction.member?.user?.id || interaction.user?.id;
    targetUser = interaction.member?.user || interaction.user;
    targetMember = interaction.member;
  }

  if (!targetUser) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Tidak bisa menemukan user itu.' },
    });
    return;
  }

  const displayName = targetUser.global_name || targetUser.username;
  const createdAt = snowflakeToDate(targetId);

  const fields = [
    { name: 'Username', value: `\`${targetUser.username}\``, inline: true },
    { name: 'User ID', value: `\`${targetId}\``, inline: true },
    { name: 'Akun dibuat', value: formatDate(createdAt), inline: false },
  ];

  if (targetMember?.joined_at) {
    fields.push({ name: 'Join server', value: formatDate(new Date(targetMember.joined_at)), inline: false });
  }

  if (targetMember?.roles?.length) {
    fields.push({ name: `Roles (${targetMember.roles.length})`, value: targetMember.roles.map((r) => `<@&${r}>`).join(' '), inline: false });
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: `👤 ${displayName}`,
          color: 0x5865f2,
          thumbnail: targetUser.avatar
            ? { url: `https://cdn.discordapp.com/avatars/${targetId}/${targetUser.avatar}.png?size=256` }
            : undefined,
          fields,
        },
      ],
    },
  });
}

module.exports = { handleUserinfo };
