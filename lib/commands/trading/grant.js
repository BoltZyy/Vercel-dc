'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { isOwner } = require('../../permissions');
const { adjustBalance, adjustAssetQuantity } = require('../../trading');
const { isValidAssetCode, ASSET_CODES } = require('../../tradingAssets');

/* =========================================================================
 * /grant {user} {tipe} {kode?} {jumlah} — Owner-only. Tambah atau kurangi
 * (jumlah negatif) saldo cash atau kepemilikan aset user tertentu.
 * Instan, tidak panggil AI.
 * ========================================================================= */

async function handleGrant(interaction, res) {
  if (!isOwner(interaction)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❌ Command ini khusus Owner.' },
    });
    return;
  }

  const options = interaction.data?.options || [];
  const userOpt = options.find((o) => o.name === 'user');
  const tipeOpt = options.find((o) => o.name === 'tipe');
  const kodeOpt = options.find((o) => o.name === 'kode');
  const jumlahOpt = options.find((o) => o.name === 'jumlah');

  const targetId = userOpt?.value;
  const tipe = tipeOpt?.value;
  const assetCode = kodeOpt?.value;
  const amount = jumlahOpt?.value;

  if (!targetId) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Pilih user yang mau di-grant.' },
    });
    return;
  }
  if (typeof amount !== 'number' || amount === 0) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Jumlah harus angka, tidak boleh 0 (boleh negatif buat mengurangi).' },
    });
    return;
  }

  try {
    if (tipe === 'cash') {
      const newBalance = await adjustBalance(targetId, amount);
      const verb = amount > 0 ? 'ditambahkan ke' : 'dikurangi dari';
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `✅ 💵 ${Math.abs(amount).toLocaleString('id-ID')} ZYC ${verb} saldo <@${targetId}>.\nSaldo sekarang: 💵 ${newBalance.toLocaleString('id-ID')} ZYC`,
        },
      });
      return;
    }

    if (tipe === 'aset') {
      if (!assetCode || !isValidAssetCode(assetCode)) {
        res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `⚠️ Aset tidak dikenal. Aset valid: ${ASSET_CODES.join(', ')}.` },
        });
        return;
      }
      const newQuantity = await adjustAssetQuantity(targetId, assetCode, amount);
      const verb = amount > 0 ? 'ditambahkan ke' : 'dikurangi dari';
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `✅ 💰 ${Math.abs(amount)} ${assetCode.toUpperCase()} ${verb} kepemilikan <@${targetId}>.\nKepemilikan sekarang: ${newQuantity} unit`,
        },
      });
      return;
    }

    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Tipe harus cash atau aset.' },
    });
  } catch (err) {
    console.error('[handleGrant] error:', err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal grant (Redis tidak dikonfigurasi atau error).' },
    });
  }
}

module.exports = { handleGrant };
