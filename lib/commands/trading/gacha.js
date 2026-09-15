'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const { checkAndHandleOverdueLoan, formatZYC } = require('../../trading');
const { executeGachaPulls, GACHA_COST_PER_PULL } = require('../../gachaEngine');
const { getShopItem } = require('../../shopItems');

/* =========================================================================
 * /gacha {pull} — money sink + sumber utility item & Founder Shares.
 * Lihat lib/gachaEngine.js untuk detail rate & formula.
 * ========================================================================= */

const TIER_EMOJI = {
  common: '⚪',
  uncommon: '🟢',
  rare: '🔵',
  epic: '🟣',
};

function formatPullResult(result) {
  const emoji = TIER_EMOJI[result.tier] || '⚪';

  if (result.rewardType === 'cash') {
    return `${emoji} [${result.tier.toUpperCase()}] 💵 ${formatZYC(result.amount)} ZYC`;
  }
  if (result.rewardType === 'share') {
    return `${emoji} [${result.tier.toUpperCase()}] 🏆 **${result.shareId}** JACKPOT! (total dimiliki: ${result.totalOwned}x)`;
  }
  // consumable atau cosmetic
  const itemDef = getShopItem(result.itemId);
  const itemName = itemDef?.name || result.itemId;
  return `${emoji} [${result.tier.toUpperCase()}] 📦 ${itemName}`;
}

async function handleGacha(interaction, res) {
  const userId = getInvokerId(interaction);
  await checkAndHandleOverdueLoan(userId);

  const options = interaction.data?.options || [];
  const pullOpt = options.find((o) => o.name === 'pull');
  const pullCount = Number(pullOpt?.value || 1);

  const result = await executeGachaPulls(userId, pullCount);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: result.error },
    });
    return;
  }

  const lines = result.results.map(formatPullResult);
  const jackpotHit = result.results.some((r) => r.rewardType === 'share' || (r.rewardType === 'cash' && r.tier === 'epic'));

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: jackpotHit ? '🎉 GACHA — JACKPOT!' : '🎰 Hasil Gacha',
          color: jackpotHit ? 0xf1c40f : 0x9b59b6,
          description: `Total biaya: 💵 ${formatZYC(result.totalCost)} ZYC (${result.pullCount}x pull)\n\n${lines.join('\n')}`,
        },
      ],
    },
  });
}

module.exports = { handleGacha };
