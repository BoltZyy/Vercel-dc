'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { canUseSay, getInvokerId } = require('../permissions');
const { sendDirectMessage } = require('../discordApi');
const { logAuditEvent } = require('../redis');

/* =========================================================================
 * /warn {user} {alasan} — catat peringatan + kirim DM ke user berisi
 * alasan dan konsekuensi umum. TANPA sistem counter/ambang batas
 * otomatis (setiap warn dicatat & dikirim independen, tidak ada logic
 * "3x warn = auto-block").
 *
 * Akses: Owner ATAU user dengan izin ManageMessages di server ini
 * (dipakai ulang canUseSay dari permissions.js — logic-nya identik
 * dengan yang dipakai /say, meski nama fungsinya spesifik ke situ).
 * ========================================================================= */

async function handleWarn(interaction, res) {
  if (!canUseSay(interaction)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❌ Command ini khusus Owner atau moderator (izin Manage Messages).' },
    });
    return;
  }

  const options = interaction.data?.options || [];
  const userOpt = options.find((o) => o.name === 'user');
  const alasanOpt = options.find((o) => o.name === 'alasan');

  const targetId = userOpt?.value;
  const alasan = (alasanOpt?.value || '').trim();

  if (!targetId || !alasan) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Target user dan alasan wajib diisi.' },
    });
    return;
  }

  const moderatorId = getInvokerId(interaction);
  const channelId = interaction.channel_id;

  let dmSent = true;
  try {
    await sendDirectMessage(targetId, {
      embeds: [
        {
          title: '⚠️ Kamu Mendapat Peringatan',
          color: 0xfee75c,
          description: [
            `Kamu menerima peringatan dari moderator di server tempat kamu berinteraksi dengan bot ini.`,
            '',
            `**Alasan:** ${alasan}`,
            '',
            '**Konsekuensi:** Pelanggaran berulang dapat berujung pada pemblokiran akses ke fitur bot ini, atau tindakan moderasi lain dari pihak server. Mohon perhatikan aturan yang berlaku.',
          ].join('\n'),
          timestamp: new Date().toISOString(),
        },
      ],
    });
  } catch (err) {
    // DM gagal itu WAJAR (user bisa menonaktifkan DM dari member server di
    // privacy setting Discord) — bukan bug, dan TIDAK BOLEH menggagalkan
    // command /warn secara keseluruhan. Tetap lanjut catat & beri tahu
    // moderator bahwa DM gagal terkirim.
    dmSent = false;
    console.error('[handleWarn] Failed to send DM:', err.message);
  }

  await logAuditEvent('warn', {
    userId: targetId,
    moderatorId,
    channelId,
    reason: alasan,
    dmSent,
  });

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: `⚠️ <@${targetId}> telah diberi peringatan. Alasan: ${alasan}${
        dmSent ? '' : '\n_(DM gagal terkirim — kemungkinan user menonaktifkan DM dari member server)_'
      }`,
    },
  });
}

module.exports = { handleWarn };
