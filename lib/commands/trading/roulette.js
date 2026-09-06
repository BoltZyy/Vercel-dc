'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const { checkAndHandleOverdueLoan, formatZYC } = require('../../trading');
const { executeGamble, playRoulette, getRouletteChoice, ROULETTE_CHOICES } = require('../../gamblingEngine');

/* =========================================================================
 * /roulette {bet} {pilihan} — angka 0-36, pilihan red/black/odd/even
 * (dropdown wajib via choices di deploy-commands.js). Angka 0 SELALU
 * zonk untuk semua pilihan, terlepas dari apa yang dipilih user.
 * ========================================================================= */

async function handleRoulette(interaction, res) {
  const userId = getInvokerId(interaction);
  await checkAndHandleOverdueLoan(userId);

  const options = interaction.data?.options || [];
  const betOpt = options.find((o) => o.name === 'bet');
  const pilihanOpt = options.find((o) => o.name === 'pilihan');

  const choice = getRouletteChoice(pilihanOpt?.value);
  if (!choice) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Pilihan tidak valid. Pilih salah satu dari dropdown: Red, Black, Odd, Even.' },
    });
    return;
  }

  const result = await executeGamble(userId, betOpt?.value, playRoulette, [pilihanOpt.value]);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: result.error },
    });
    return;
  }

  const colorEmoji = result.rolledColor === 'red' ? '🔴' : result.rolledColor === 'black' ? '⬛' : '🟢';
  const content = result.isWin
    ? `🎡 Bola jatuh di **${result.rolled}** ${colorEmoji} — kamu pilih **${choice.label}**, MENANG! 💵 **${formatZYC(result.payout)} ZYC** (${choice.multiplier}x dari taruhan 💵 ${formatZYC(result.betAmount)} ZYC).`
    : `🎡 Bola jatuh di **${result.rolled}** ${colorEmoji} — kamu pilih **${choice.label}**, kalah 💵 **${formatZYC(result.betAmount)} ZYC**.${result.rolled === 0 ? ' _(Angka 0 selalu zonk.)_' : ''}`;

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content },
  });
}

module.exports = { handleRoulette };
