'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const { addCartItem, clearCart, sendTrade, respondTrade } = require('../../trading');
const { isValidAssetCode, ASSET_CODES } = require('../../tradingAssets');

/* =========================================================================
 * Sistem Trade Antar-User — keranjang bertahap, 1 aktif per user (global).
 *
 * /trade-add-item {tipe} {kode?} {jumlah}     -> tambah ke sisi TAWARKAN
 * /trade-request-item {tipe} {kode?} {jumlah} -> tambah ke sisi MINTA (opsional)
 * /trade-clear                                 -> kosongkan keranjang
 * /trade-send {user}                            -> kirim ke user lain
 * /trade-accept {id}                             -> terima trade masuk
 * /trade-reject {id}                              -> tolak trade masuk
 *
 * Semua command instan (baca/tulis Redis, tidak panggil AI).
 * ========================================================================= */

function parseItemFromOptions(options) {
  const tipeOpt = options.find((o) => o.name === 'tipe');
  const kodeOpt = options.find((o) => o.name === 'kode');
  const jumlahOpt = options.find((o) => o.name === 'jumlah');

  const tipe = tipeOpt?.value;
  const assetCode = kodeOpt?.value;
  const amount = jumlahOpt?.value;

  if (tipe === 'cash') {
    return { type: 'cash', amount };
  }
  if (tipe === 'aset') {
    return { type: 'asset', code: assetCode?.toUpperCase(), amount };
  }
  return null;
}

async function handleTradeAddItem(interaction, res) {
  await addOrRequestItem(interaction, res, 'offer');
}

async function handleTradeRequestItem(interaction, res) {
  await addOrRequestItem(interaction, res, 'request');
}

async function addOrRequestItem(interaction, res, side) {
  const userId = getInvokerId(interaction);
  const options = interaction.data?.options || [];
  const item = parseItemFromOptions(options);

  if (!item) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Tipe harus cash atau aset.' },
    });
    return;
  }
  if (item.type === 'asset' && !isValidAssetCode(item.code)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ Aset tidak dikenal. Aset valid: ${ASSET_CODES.join(', ')}.` },
    });
    return;
  }
  if (typeof item.amount !== 'number' || item.amount <= 0) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Jumlah harus angka lebih dari 0.' },
    });
    return;
  }

  const result = await addCartItem(userId, side, item);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ ${result.error}` },
    });
    return;
  }

  const sideLabel = side === 'offer' ? 'TAWARKAN' : 'MINTA';
  const itemLabel = item.type === 'cash' ? `💵 ${item.amount.toLocaleString('id-ID')} ZYC` : `💰 ${item.amount} ${item.code}`;
  const offerCount = result.cart.offer.length;
  const requestCount = result.cart.request.length;

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: [
        `✅ ${itemLabel} ditambahkan ke sisi **${sideLabel}**.`,
        `📦 Keranjang kamu sekarang: ${offerCount} item ditawarkan, ${requestCount} item diminta.`,
        `Pakai \`/trade-send\` kalau sudah siap kirim, atau \`/trade-clear\` buat mulai ulang.`,
      ].join('\n'),
    },
  });
}

async function handleTradeClear(interaction, res) {
  const userId = getInvokerId(interaction);
  await clearCart(userId);
  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: '🧹 Keranjang trade kamu dikosongkan.' },
  });
}

async function handleTradeSend(interaction, res) {
  const userId = getInvokerId(interaction);
  const options = interaction.data?.options || [];
  const userOpt = options.find((o) => o.name === 'user');
  const toUserId = userOpt?.value;

  if (!toUserId) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Pilih user yang mau diajak trade.' },
    });
    return;
  }

  const result = await sendTrade(userId, toUserId, interaction.channel_id);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ ${result.error}` },
    });
    return;
  }

  const trade = result.trade;
  const formatItems = (items) =>
    items.length
      ? items.map((i) => (i.type === 'cash' ? `💵 ${i.amount.toLocaleString('id-ID')} ZYC` : `💰 ${i.amount} ${i.code}`)).join(', ')
      : '_(tidak ada)_';

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: `📨 <@${toUserId}>, kamu dapat tawaran trade dari <@${userId}>!`,
      embeds: [
        {
          title: '🤝 Tawaran Trade',
          color: 0x5865f2,
          fields: [
            { name: 'Ditawarkan', value: formatItems(trade.offer), inline: false },
            { name: 'Diminta balik', value: formatItems(trade.request), inline: false },
            { name: 'ID Trade', value: `\`${trade.tradeId}\``, inline: false },
          ],
          footer: { text: `Pakai /trade-accept id:${trade.tradeId} atau /trade-reject id:${trade.tradeId}. Kedaluwarsa dalam 10 menit.` },
        },
      ],
    },
  });
}

async function handleTradeAccept(interaction, res) {
  await respondToTrade(interaction, res, 'accept');
}

async function handleTradeReject(interaction, res) {
  await respondToTrade(interaction, res, 'reject');
}

async function respondToTrade(interaction, res, action) {
  const userId = getInvokerId(interaction);
  const options = interaction.data?.options || [];
  const idOpt = options.find((o) => o.name === 'id');
  const tradeId = idOpt?.value;

  if (!tradeId) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Masukkan ID trade.' },
    });
    return;
  }

  const result = await respondTrade(tradeId, userId, action);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ ${result.error}` },
    });
    return;
  }

  if (result.action === 'rejected') {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `❌ Trade dari <@${result.trade.fromUserId}> ditolak.` },
    });
    return;
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `✅ Trade dengan <@${result.trade.fromUserId}> berhasil! Barang sudah dipertukarkan.` },
  });
}

module.exports = {
  handleTradeAddItem,
  handleTradeRequestItem,
  handleTradeClear,
  handleTradeSend,
  handleTradeAccept,
  handleTradeReject,
};
