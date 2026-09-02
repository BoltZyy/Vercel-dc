'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { isOwner } = require('../../permissions');
const { getAllPrices, getActiveEvent, setPrice, EVENT_TYPES } = require('../../trading');
const { ASSET_CODES, getAssetDefinition, isValidAssetCode } = require('../../tradingAssets');
const { publishJob } = require('../../qstash');

/* =========================================================================
 * /market                          — lihat harga semua aset saat ini
 * /market-event {tipe} {aset?}     — Owner-only, trigger event pasar manual
 * /market-set-price {aset} {harga} — Owner-only, paksa harga aset
 *
 * Tiga command MANDIRI (bukan subcommand grup) — Discord tidak izinkan
 * command yang "kadang polos, kadang punya subcommand", jadi dipisah
 * biar /market tetap bisa dipanggil tanpa opsi apa pun.
 * ========================================================================= */

async function handleMarket(interaction, res) {
  const [prices, activeEvent] = await Promise.all([getAllPrices(), getActiveEvent()]);

  const lines = ASSET_CODES.map((code) => {
    const def = getAssetDefinition(code);
    return `${def.emoji} **${code}** (${def.name}) — 💵 ${prices[code].toLocaleString('id-ID')} ZYC`;
  });

  let description = lines.join('\n');
  if (activeEvent) {
    description += `\n\n⚠️ **Event aktif:** ${activeEvent.label}${
      activeEvent.targetAssets ? ` (target: ${activeEvent.targetAssets.join(', ')})` : ' (semua aset)'
    }`;
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [{ title: '📊 Harga Pasar Saat Ini', color: 0x57f287, description }],
    },
  });
}

/**
 * handleMarketEvent — Owner trigger event manual. Validasi input di sini
 * (cepat), lalu publish job KE ENDPOINT TERPISAH yang benar-benar
 * menjalankan triggerMarketEventFlow() (kirim pengumuman + publish delay
 * job kedua) — konsisten dengan pola /status dan /export, karena
 * triggerMarketEventFlow sendiri melakukan network call ganda yang
 * berisiko >3 detik kalau dijalankan langsung di request pertama.
 */
async function handleMarketEvent(interaction, res) {
  if (!isOwner(interaction)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❌ Command ini khusus Owner.' },
    });
    return;
  }

  const options = interaction.data?.options || [];
  const tipeOpt = options.find((o) => o.name === 'tipe');
  const asetOpt = options.find((o) => o.name === 'aset');

  const eventType = (tipeOpt?.value || '').toUpperCase();
  if (!EVENT_TYPES[eventType]) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ Tipe event tidak dikenal. Pilihan: ${Object.keys(EVENT_TYPES).join(', ')}.` },
    });
    return;
  }

  let targetAssets = null;
  if (asetOpt?.value) {
    const requested = asetOpt.value.toUpperCase().split(',').map((s) => s.trim());
    const invalid = requested.filter((a) => !isValidAssetCode(a));
    if (invalid.length) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `⚠️ Aset tidak dikenal: ${invalid.join(', ')}. Aset valid: ${ASSET_CODES.join(', ')}.` },
      });
      return;
    }
    targetAssets = requested;
  }

  try {
    await publishJob({
      endpointPath: '/api/process-market-event-trigger',
      payload: { token: interaction.token, eventType, targetAssets },
    });
  } catch (err) {
    console.error('[handleMarketEvent] Failed to publish QStash job:', err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal menjadwalkan trigger event. Coba lagi beberapa saat ya 🙏' },
    });
    return;
  }

  res.status(200).json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
}

/**
 * handleMarketSetPrice — Owner paksa harga aset. Instan, tidak perlu deferred.
 */
async function handleMarketSetPrice(interaction, res) {
  if (!isOwner(interaction)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❌ Command ini khusus Owner.' },
    });
    return;
  }

  const options = interaction.data?.options || [];
  const asetOpt = options.find((o) => o.name === 'aset');
  const hargaOpt = options.find((o) => o.name === 'harga');

  const assetCode = asetOpt?.value;
  const newPrice = hargaOpt?.value;

  if (!assetCode || !isValidAssetCode(assetCode)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ Aset tidak dikenal. Aset valid: ${ASSET_CODES.join(', ')}.` },
    });
    return;
  }
  if (typeof newPrice !== 'number' || newPrice <= 0) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Harga harus angka lebih dari 0.' },
    });
    return;
  }

  try {
    const applied = await setPrice(assetCode, newPrice);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `✅ Harga ${assetCode.toUpperCase()} dipaksa jadi 💵 ${applied.toLocaleString('id-ID')} ZYC.` },
    });
  } catch (err) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal mengubah harga (Redis tidak dikonfigurasi atau error).' },
    });
  }
}

module.exports = { handleMarket, handleMarketEvent, handleMarketSetPrice };
