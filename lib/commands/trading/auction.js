'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const { checkAndHandleOverdueLoan, formatZYC } = require('../../trading');
const { openP2PAuction, placeBid, getAuction } = require('../../auctionEngine');
const { publishJob } = require('../../qstash');

/* =========================================================================
 * /auction-sell item:<kode> starting_price:<jumlah> duration:<jam>
 * /bid auction_id:<id> jumlah:<angka>
 *
 * Membuka lelang P2P: potong listing fee (burn), kunci item dari
 * inventory, jadwalkan job penutupan via QStash dengan delay = durasi
 * yang diminta. Lihat lib/auctionEngine.js untuk detail lifecycle penuh
 * dan mekanisme anti-snipe (Opsi B, TANPA cancel API).
 * ========================================================================= */

async function handleAuctionSell(interaction, res) {
  const userId = getInvokerId(interaction);
  await checkAndHandleOverdueLoan(userId);

  const options = interaction.data?.options || [];
  const itemOpt = options.find((o) => o.name === 'item');
  const startingPriceOpt = options.find((o) => o.name === 'starting_price');
  const durationOpt = options.find((o) => o.name === 'duration');

  const result = await openP2PAuction(userId, itemOpt?.value, startingPriceOpt?.value, durationOpt?.value);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: result.error },
    });
    return;
  }

  // Jadwalkan job penutupan TEPAT di endsAt — SEKALI SAJA, tidak
  // dijadwalkan ulang lagi meski nanti kena snipe berkali-kali (lihat
  // Opsi B di lib/auctionEngine.js: job ini sendiri yang akan
  // menjadwalkan ulang DIRINYA SENDIRI kalau endsAt sudah berubah saat
  // dia jalan nanti).
  try {
    const delaySeconds = Math.ceil((result.endsAt - Date.now()) / 1000);
    await publishJob({
      endpointPath: '/api/process-auction-close',
      payload: { auctionId: result.auctionId },
      delaySeconds,
    });
  } catch (err) {
    // Kegagalan menjadwalkan job penutupan itu SERIUS — lelang bisa
    // "menggantung" selamanya tanpa pernah ditutup. Item & fee SUDAH
    // terpotong di openP2PAuction, jadi kita TIDAK bisa membatalkan
    // transaksi ini dengan aman (butuh rollback manual kompleks) —
    // cukup log sekeras mungkin untuk intervensi manual Owner, dan
    // tetap kabari user lelangnya terbuka (memang benar terbuka).
    console.error(`[handleAuctionSell] GAGAL menjadwalkan job penutupan untuk lelang ${result.auctionId} — PERLU INTERVENSI MANUAL (jadwalkan manual atau tutup via /auction-admin):`, err.message);
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: '🔨 Lelang P2P Dibuka!',
          color: 0xf39c12,
          description: [
            `**${result.itemDef.name}** dilelang mulai dari 💵 ${formatZYC(startingPriceOpt.value)} ZYC.`,
            `Berakhir <t:${Math.floor(result.endsAt / 1000)}:R>.`,
            `Listing fee: 💵 ${formatZYC(result.listingFee)} ZYC (hangus, tidak dikembalikan meski tidak laku).`,
            `Pajak transaksi kalau laku: ${(result.taxRate * 100).toFixed(1)}%.`,
            '',
            `ID Lelang: \`${result.auctionId}\` — gunakan \`/bid auction_id:${result.auctionId}\` untuk menawar.`,
          ].join('\n'),
        },
      ],
    },
  });
}

/**
 * handleBid — /bid auction_id:<id> jumlah:<angka>. Orkestrasi penuh
 * (validasi, EVAL atomic, refund, anti-snipe) ada di placeBid() di
 * lib/auctionEngine.js — handler ini murni menerjemahkan input Discord
 * dan menampilkan hasil.
 */
async function handleBid(interaction, res) {
  const userId = getInvokerId(interaction);
  await checkAndHandleOverdueLoan(userId);

  const options = interaction.data?.options || [];
  const auctionIdOpt = options.find((o) => o.name === 'auction_id');
  const jumlahOpt = options.find((o) => o.name === 'jumlah');

  const auctionId = auctionIdOpt?.value;
  if (!auctionId) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Isi `auction_id:` (lihat pengumuman lelang untuk ID-nya).' },
    });
    return;
  }

  const result = await placeBid(auctionId, userId, jumlahOpt?.value);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: result.error },
    });
    return;
  }

  const lines = [
    `💰 Bid kamu 💵 ${formatZYC(result.newBid)} ZYC berhasil masuk sebagai penawaran tertinggi!`,
  ];
  if (result.wasExtended) {
    lines.push(`⏰ Anti-snipe aktif! Waktu lelang diperpanjang, berakhir <t:${Math.floor(result.endsAt / 1000)}:R>.`);
  } else {
    lines.push(`Lelang berakhir <t:${Math.floor(result.endsAt / 1000)}:R>.`);
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: '🔨 Bid Berhasil',
          color: 0x2ecc71,
          description: lines.join('\n'),
        },
      ],
    },
  });
}

module.exports = { handleAuctionSell, handleBid };
