'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const { executeBuy, executeSell, checkAndHandleOverdueLoan } = require('../../trading');
const { isValidAssetCode, getAssetDefinition, ASSET_CODES } = require('../../tradingAssets');

/* =========================================================================
 * /buy {aset} {jumlah} — beli instan di harga sekarang.
 * /sell {aset} {jumlah} — jual instan di harga sekarang.
 * Instan (baca/tulis Redis, tidak panggil AI). Selalu cek nunggak dulu.
 * ========================================================================= */

function parseAssetAndQuantity(interaction) {
  const options = interaction.data?.options || [];
  const asetOpt = options.find((o) => o.name === 'aset');
  const jumlahOpt = options.find((o) => o.name === 'jumlah');
  return { assetCode: asetOpt?.value, quantity: jumlahOpt?.value };
}

async function handleBuy(interaction, res) {
  const userId = getInvokerId(interaction);
  await checkAndHandleOverdueLoan(userId);

  const { assetCode, quantity } = parseAssetAndQuantity(interaction);

  if (!assetCode || !isValidAssetCode(assetCode)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ Aset tidak dikenal. Aset valid: ${ASSET_CODES.join(', ')}.` },
    });
    return;
  }
  if (typeof quantity !== 'number' || quantity <= 0) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Jumlah harus angka lebih dari 0.' },
    });
    return;
  }

  const result = await executeBuy(userId, assetCode, quantity);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ ${result.error}` },
    });
    return;
  }

  const def = getAssetDefinition(assetCode);
  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: [
        `✅ Berhasil beli ${quantity} ${def.emoji} **${assetCode.toUpperCase()}** seharga 💵 ${result.totalCost.toLocaleString('id-ID')} ZYC`,
        `💰 Kepemilikan ${assetCode.toUpperCase()} sekarang: ${result.newQuantity} unit`,
        `💵 Sisa saldo: ${result.newBalance.toLocaleString('id-ID')} ZYC`,
      ].join('\n'),
    },
  });
}

async function handleSell(interaction, res) {
  const userId = getInvokerId(interaction);
  await checkAndHandleOverdueLoan(userId);

  const { assetCode, quantity } = parseAssetAndQuantity(interaction);

  if (!assetCode || !isValidAssetCode(assetCode)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ Aset tidak dikenal. Aset valid: ${ASSET_CODES.join(', ')}.` },
    });
    return;
  }
  if (typeof quantity !== 'number' || quantity <= 0) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Jumlah harus angka lebih dari 0.' },
    });
    return;
  }

  const result = await executeSell(userId, assetCode, quantity);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ ${result.error}` },
    });
    return;
  }

  const def = getAssetDefinition(assetCode);
  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: [
        `✅ Berhasil jual ${quantity} ${def.emoji} **${assetCode.toUpperCase()}** seharga 💵 ${result.totalGain.toLocaleString('id-ID')} ZYC`,
        `💰 Kepemilikan ${assetCode.toUpperCase()} sekarang: ${result.newQuantity} unit`,
        `💵 Saldo sekarang: ${result.newBalance.toLocaleString('id-ID')} ZYC`,
      ].join('\n'),
    },
  });
}

module.exports = { handleBuy, handleSell };
