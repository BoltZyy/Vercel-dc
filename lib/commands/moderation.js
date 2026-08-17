'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { isOwner, getInvokerId } = require('../permissions');
const {
  blockUser,
  unblockUser,
  listBlockedUsers,
  isUserBlocked,
  setMaintenanceMode,
  isMaintenanceMode,
  clearConversation,
  clearAllConversationsInChannel,
  clearAllConversations,
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

/**
 * /reset {user?} {scope?}
 *
 * User biasa: tanpa opsi apa pun -> reset riwayat DIRI SENDIRI di
 *   channel ini. Opsi 'user' dan 'scope' ditolak (bukan Owner).
 *
 * Owner: opsi 'user' -> reset riwayat user tertentu di channel ini.
 *        opsi 'scope:channel' -> reset SEMUA user di channel ini.
 *        opsi 'scope:all' -> reset SEMUA riwayat di semua channel & user.
 *        tanpa opsi apa pun -> tetap reset riwayat Owner sendiri saja
 *        (perilaku default sama seperti user biasa, supaya /reset polos
 *        tidak pernah punya efek destruktif tak terduga).
 */
async function handleReset(interaction, res) {
  const channelId = interaction.channel_id;
  const invokerId = getInvokerId(interaction);
  const invokerIsOwner = isOwner(interaction);

  const options = interaction.data?.options || [];
  const userOpt = options.find((o) => o.name === 'user');
  const scopeOpt = options.find((o) => o.name === 'scope');
  const targetUserId = userOpt?.value;
  const scope = scopeOpt?.value; // 'channel' | 'all' | undefined

  // Non-owner: opsi user/scope sama sekali tidak boleh dipakai.
  if ((targetUserId || scope) && !invokerIsOwner) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❌ Opsi `user` dan `scope` khusus Owner. Pakai `/reset` tanpa opsi untuk reset riwayatmu sendiri.' },
    });
    return;
  }

  try {
    // Owner: scope 'all' -> wipe SEMUA riwayat di semua channel & user.
    if (invokerIsOwner && scope === 'all') {
      const count = await clearAllConversations();
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `🧹 **${count}** riwayat percakapan (semua user, semua channel) berhasil dihapus.` },
      });
      return;
    }

    // Owner: scope 'channel' -> wipe semua user DI CHANNEL INI.
    if (invokerIsOwner && scope === 'channel') {
      const count = await clearAllConversationsInChannel(channelId);
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `🧹 **${count}** riwayat percakapan di channel ini berhasil dihapus.` },
      });
      return;
    }

    // Owner: user tertentu -> reset riwayat USER ITU di channel ini.
    if (invokerIsOwner && targetUserId) {
      await clearConversation(channelId, targetUserId);
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `🧹 Riwayat percakapan <@${targetUserId}> di channel ini berhasil dihapus.` },
      });
      return;
    }

    // Default (user biasa ATAU owner tanpa opsi apa pun) -> reset diri sendiri.
    await clearConversation(channelId, invokerId);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '🧹 Riwayat percakapanmu di channel ini sudah direset.' },
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
