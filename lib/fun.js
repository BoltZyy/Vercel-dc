'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../permissions');
const { checkAndHandleOverdueLoan, formatZYC } = require('../trading');
const { executeGamble, playCoinflip, COINFLIP_PAYOUT_MULTIPLIER } = require('../gamblingEngine');

/* =========================================================================
 * /coinflip {bet} — REFACTORED: sekarang pakai saldo ZYC sungguhan
 * dengan house edge 5% (payout 1.9x, bukan 2x). /roll {dice} di bawah
 * TETAP format TTRPG lama (d20, 2d6, dst) — TIDAK diubah jadi judi,
 * sesuai keputusan: command judi angka baru ada di /dice terpisah
 * (lihat lib/commands/trading/dice.js).
 * ========================================================================= */

async function handleCoinflip(interaction, res) {
  const userId = getInvokerId(interaction);
  await checkAndHandleOverdueLoan(userId);

  const options = interaction.data?.options || [];
  const betOpt = options.find((o) => o.name === 'bet');

  const result = await executeGamble(userId, betOpt?.value, playCoinflip);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: result.error },
    });
    return;
  }

  const emoji = result.result === 'Heads' ? '🪙' : '🎯';
  const content = result.isWin
    ? `${emoji} **${result.result}**! Kamu menang 💵 **${formatZYC(result.payout)} ZYC** (${COINFLIP_PAYOUT_MULTIPLIER}x dari taruhan 💵 ${formatZYC(result.betAmount)} ZYC).`
    : `${emoji} **${result.result}**! Kamu kalah 💵 **${formatZYC(result.betAmount)} ZYC**.`;

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content },
  });
}

// Format dice standar TTRPG: "2d6", "d20", "1d100", dst.
const DICE_PATTERN = /^(\d{0,3})d(\d{1,4})$/i;

async function handleRoll(interaction, res) {
  const options = interaction.data?.options || [];
  const diceOpt = options.find((o) => o.name === 'dice');
  const diceInput = (diceOpt?.value || '1d6').trim();

  const match = diceInput.match(DICE_PATTERN);
  if (!match) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ Format tidak valid. Contoh yang benar: \`d20\`, \`2d6\`, \`1d100\`.` },
    });
    return;
  }

  const count = match[1] ? parseInt(match[1], 10) : 1;
  const sides = parseInt(match[2], 10);

  if (count < 1 || count > 100) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Jumlah dadu harus antara 1-100.' },
    });
    return;
  }
  if (sides < 2 || sides > 1000) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Jumlah sisi dadu harus antara 2-1000.' },
    });
    return;
  }

  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
  const total = rolls.reduce((a, b) => a + b, 0);
  const rollsText = rolls.length > 1 ? `[${rolls.join(', ')}] = ` : '';

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `🎲 **${diceInput}** → ${rollsText}**${total}**` },
  });
}

module.exports = { handleCoinflip, handleRoll };
