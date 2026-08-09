'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { isOwner } = require('../permissions');
const {
  blockUser,
  unblockUser,
  listBlockedUsers,
  isUserBlocked,
  setMaintenanceMode,
  isMaintenanceMode,
  clearConversation,
} = require('../redis');

/* =========================================================================
 * COMMAND OWNER-ONLY: /block /unblock /blocklist /maintenance /reset
 * Semua instan (tidak panggil AI), dijawab langsung Type 4.
 * ========================================================================= */

function ownerOnlyReject(res) {
  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: '❌ Command ini khusus Owner.' },
  });
}

async function handleBlock(interaction, res) {
  if (!isOwner(interaction)) return ownerOnlyReject(res);

  const options = interaction.data?.options || [];
  const userOpt = options.find((o) => o.name === 'user');
  const reasonOpt = options.find((o) => o.name === 'alasan');
  const targetId = userOpt?.value;

  if (!targetId) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Target user wajib diisi.' },
    });
    return;
  }

  try {
    await blockUser(targetId, reasonOpt?.value || 'No reason provided');
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `🚫 <@${targetId}> berhasil diblokir.${reasonOpt?.value ? ` Alasan: ${reasonOpt.value}` : ''}` },
    });
  } catch (err) {
    console.error('[handleBlock] error:', err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal memblokir user (Redis tidak dikonfigurasi atau error).' },
    });
  }
}

async function handleUnblock(interaction, res) {
  if (!isOwner(interaction)) return ownerOnlyReject(res);

  const options = interaction.data?.options || [];
  const userOpt = options.find((o) => o.name === 'user');
  const targetId = userOpt?.value;

  if (!targetId) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Target user wajib diisi.' },
    });
    return;
  }

  try {
    const wasBlocked = await isUserBlocked(targetId);
    await unblockUser(targetId);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: wasBlocked
          ? `✅ <@${targetId}> berhasil dibuka blokirnya.`
          : `ℹ️ <@${targetId}> memang tidak sedang diblokir.`,
      },
    });
  } catch (err) {
    console.error('[handleUnblock] error:', err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal membuka blokir user (Redis tidak dikonfigurasi atau error).' },
    });
  }
}

async function handleBlocklist(interaction, res) {
  if (!isOwner(interaction)) return ownerOnlyReject(res);

  const entries = await listBlockedUsers();

  if (!entries.length) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '✅ Tidak ada user yang sedang diblokir.' },
    });
    return;
  }

  const lines = entries
    .slice(0, 25)
    .map((e) => `• <@${e.userId}> — ${e.reason || 'No reason'} (${e.blockedAt ? new Date(e.blockedAt).toLocaleString('id-ID') : '?'})`);

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: `🚫 Blocklist (${entries.length} user)`,
          color: 0xed4245,
          description: lines.join('\n'),
        },
      ],
    },
  });
}

async function handleMaintenance(interaction, res) {
  if (!isOwner(interaction)) return ownerOnlyReject(res);

  const options = interaction.data?.options || [];
  const stateOpt = options.find((o) => o.name === 'status');

  if (!stateOpt) {
    const current = await isMaintenanceMode();
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `🛠️ Maintenance mode saat ini: **${current ? 'ON' : 'OFF'}**` },
    });
    return;
  }

  try {
    const enabled = stateOpt.value === 'on';
    await setMaintenanceMode(enabled);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `🛠️ Maintenance mode diubah ke: **${enabled ? 'ON' : 'OFF'}**` },
    });
  } catch (err) {
    console.error('[handleMaintenance] error:', err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal mengubah maintenance mode (Redis tidak dikonfigurasi atau error).' },
    });
  }
}

async function handleReset(interaction, res) {
  const channelId = interaction.channel_id;
  try {
    await clearConversation(channelId);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '🧹 Riwayat percakapan di channel ini sudah direset.' },
    });
  } catch (err) {
    console.error('[handleReset] error:', err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal reset riwayat (Redis tidak dikonfigurasi atau error).' },
    });
  }
}

module.exports = { handleBlock, handleUnblock, handleBlocklist, handleMaintenance, handleReset };
