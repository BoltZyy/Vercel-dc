'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const { placeOrder, cancelOrder, checkAndHandleOverdueLoan } = require('../../trading');
const { isValidAssetCode, ASSET_CODES } = require('../../tradingAssets');

/* =========================================================================
 * /posisi buy {aset} {jumlah}   — pasang order pending "ancang-ancang beli"
 * /posisi sell {aset} {jumlah}  — pasang order pending "ancang-ancang jual"
 * /posisi batal {aset}          — batalkan order pending untuk 1 aset
 *
 * Order TIDAK dieksekusi langsung — baru dieksekusi saat event pasar
 * terjadi (T+1 menit dari trigger), di HARGA SETELAH EVENT, lewat
 * api/process-market-event.js. Lihat lib/trading.js untuk detail alur.
 * ========================================================================= */

async function handlePosisi(interaction, res) {
  const options = interaction.data?.options || [];
  const buyOpt = options.find((o) => o.name === 'buy');
  const sellOpt = options.find((o) => o.name === 'sell');
  const batalOpt = options.find((o) => o.name === 'batal');

  const userId = getInvokerId(interaction);
  await checkAndHandleOverdueLoan(userId);

  if (buyOpt) {
    await handlePlaceOrder(interaction, res, userId, buyOpt, 'buy');
    return;
  }
  if (sellOpt) {
    await handlePlaceOrder(interaction, res, userId, sellOpt, 'sell');
    return;
  }
  if (batalOpt) {
    await handleCancelOrder(interaction, res, userId, batalOpt);
    return;
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: '⚠️ Pakai `/posisi buy`, `/posisi sell`, atau `/posisi batal`.' },
  });
}

async function handlePlaceOrder(interaction, res, userId, subOpt, side) {
  const subOptions = subOpt.options || [];
  const asetOpt = subOptions.find((o) => o.name === 'aset');
  const jumlahOpt = subOptions.find((o) => o.name === 'jumlah');

  const assetCode = asetOpt?.value;
  const quantity = jumlahOpt?.value;

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

  const result = await placeOrder(userId, assetCode, side, quantity);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ ${result.error}` },
    });
    return;
  }

  const sideLabel = side === 'buy' ? 'BELI' : 'JUAL';
  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: [
        `📌 Posisi **${sideLabel}** ${quantity} ${assetCode.toUpperCase()} dipasang.`,
        `Order ini akan dieksekusi otomatis saat event pasar terjadi, di harga SAAT ITU (bukan harga sekarang).`,
        `Pakai \`/posisi batal aset:${assetCode.toUpperCase()}\` kalau berubah pikiran.`,
      ].join('\n'),
    },
  });
}

async function handleCancelOrder(interaction, res, userId, batalOpt) {
  const subOptions = batalOpt.options || [];
  const asetOpt = subOptions.find((o) => o.name === 'aset');
  const assetCode = asetOpt?.value;

  if (!assetCode || !isValidAssetCode(assetCode)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ Aset tidak dikenal. Aset valid: ${ASSET_CODES.join(', ')}.` },
    });
    return;
  }

  const result = await cancelOrder(userId, assetCode);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ ${result.error}` },
    });
    return;
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `✅ Order pending untuk ${assetCode.toUpperCase()} berhasil dibatalkan.` },
  });
}

module.exports = { handlePosisi };
