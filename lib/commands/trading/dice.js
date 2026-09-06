'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const { checkAndHandleOverdueLoan, formatZYC } = require('../../trading');
const { executeGamble, playDice, DICE_PAYOUT_MULTIPLIER } = require('../../gamblingEngine');

/* =========================================================================
 * /dice {bet} {tebakan} — command BARU (bukan refactor /roll yang tetap
 * dipertahankan sebagai TTRPG dice, format "d20"/"2d6"). Tebak angka
 * 1-6, house edge 5%, payout fair 6x dikurangi jadi 5.7x.
 * ========================================================================= */

async function handleDice(interaction, res) {
  const userId = getInvokerId(interaction);
  await checkAndHandleOverdueLoan(userId);

  const options = interaction.data?.options || [];
  const betOpt = options.find((o) => o.name === 'bet');
  const tebakanOpt = options.find((o) => o.name === 'tebakan');

  const guessedNumber = tebakanOpt?.value;
  if (!Number.isInteger(guessedNumber) || guessedNumber < 1 || guessedNumber > 6) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Tebakan harus angka 1-6.' },
    });
    return;
  }

  const result = await executeGamble(userId, betOpt?.value, playDice, [guessedNumber]);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: result.error },
    });
    return;
  }

  const content = result.isWin
    ? `🎲 Dadu jatuh di **${result.rolled}** — TEBAKANMU BENAR! Menang 💵 **${formatZYC(result.payout)} ZYC** (${DICE_PAYOUT_MULTIPLIER}x dari taruhan 💵 ${formatZYC(result.betAmount)} ZYC).`
    : `🎲 Dadu jatuh di **${result.rolled}**, tebakanmu ${guessedNumber}. Kamu kalah 💵 **${formatZYC(result.betAmount)} ZYC**.`;

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content },
  });
}

module.exports = { handleDice };
