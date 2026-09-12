'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { isOwner, getInvokerId } = require('../permissions');
const { setDevBypass } = require('../devHelper');

/* =========================================================================
 * /bypass mode:[on/off] target:[user?] — Owner-only. Toggle dev bypass
 * untuk diri sendiri ATAU user lain (misal akun kedua buat testing).
 * ========================================================================= */

async function handleBypass(interaction, res) {
  if (!isOwner(interaction)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⛔ Command ini khusus Owner.', flags: 64 }, // 64 = EPHEMERAL
    });
    return;
  }

  const invokerId = getInvokerId(interaction);
  const options = interaction.data?.options || [];
  const modeOpt = options.find((o) => o.name === 'mode');
  const targetOpt = options.find((o) => o.name === 'target');

  const targetUserId = targetOpt?.value || invokerId;
  const mode = modeOpt?.value;

  if (mode !== 'on' && mode !== 'off') {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Mode harus `on` atau `off`.', flags: 64 },
    });
    return;
  }

  try {
    await setDevBypass(targetUserId, mode === 'on');
  } catch (err) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Sistem tidak tersedia (Redis tidak dikonfigurasi).', flags: 64 },
    });
    return;
  }

  const targetLabel = targetUserId === invokerId ? 'kamu' : `<@${targetUserId}>`;
  const content = mode === 'on'
    ? `✅ Dev bypass **AKTIF** untuk ${targetLabel} — cooldown stamina, overdue loan check, dan limit order akan diabaikan.`
    : `✅ Dev bypass **NONAKTIF** untuk ${targetLabel}.`;

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: 64 },
  });
}

module.exports = { handleBypass };
