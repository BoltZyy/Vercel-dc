'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const { checkAndHandleOverdueLoan, formatZYC } = require('../../trading');
const { executeGamble, playSlots, SLOTS_JACKPOT_MULTIPLIER, SLOTS_PAIR_MULTIPLIER } = require('../../gamblingEngine');

/* =========================================================================
 * /slots {bet} — 3 reel acak. 3 sama = jackpot 5x, 2 sama = 1.5x,
 * sisanya zonk. Payout TETAP sesuai spesifikasi (bukan hasil kalkulasi
 * fair-odds otomatis seperti coinflip/dice).
 * ========================================================================= */

async function handleSlots(interaction, res) {
  const userId = getInvokerId(interaction);
  await checkAndHandleOverdueLoan(userId);

  const options = interaction.data?.options || [];
  const betOpt = options.find((o) => o.name === 'bet');

  const result = await executeGamble(userId, betOpt?.value, playSlots);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: result.error },
    });
    return;
  }

  const reelDisplay = `[ ${result.reels.join(' | ')} ]`;
  let content;
  if (result.outcome === 'jackpot') {
    content = `🎰 ${reelDisplay}\n💥 **JACKPOT!** Menang 💵 **${formatZYC(result.payout)} ZYC** (${SLOTS_JACKPOT_MULTIPLIER}x dari taruhan 💵 ${formatZYC(result.betAmount)} ZYC)!`;
  } else if (result.outcome === 'pair') {
    content = `🎰 ${reelDisplay}\n✨ 2 simbol sama! Menang 💵 **${formatZYC(result.payout)} ZYC** (${SLOTS_PAIR_MULTIPLIER}x dari taruhan 💵 ${formatZYC(result.betAmount)} ZYC).`;
  } else {
    content = `🎰 ${reelDisplay}\n💨 Zonk. Kamu kalah 💵 **${formatZYC(result.betAmount)} ZYC**.`;
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content },
  });
}

module.exports = { handleSlots };
