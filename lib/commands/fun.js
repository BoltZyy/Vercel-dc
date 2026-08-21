'use strict';

const { InteractionResponseType } = require('discord-interactions');

/* =========================================================================
 * /coinflip dan /roll {dice} — random generator ringan, instan, tanpa
 * AI/Redis/QStash sama sekali.
 * ========================================================================= */

async function handleCoinflip(interaction, res) {
  const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
  const emoji = result === 'Heads' ? '🪙' : '🎯';
  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `${emoji} **${result}**!` },
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
