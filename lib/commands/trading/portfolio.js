'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const { getBalance, getPortfolio, getAllPrices, getLoan, getBadDebt, checkAndHandleOverdueLoan } = require('../../trading');
const { ASSET_CODES, getAssetDefinition } = require('../../tradingAssets');

/* =========================================================================
 * /portfolio — lihat saldo ZYC, kepemilikan aset, dan estimasi nilai
 * total. Instan (baca dari Redis, tidak panggil AI).
 *
 * Selalu cek nunggak dulu di awal (checkAndHandleOverdueLoan) — sesuai
 * spesifikasi, pengecekan overdue terjadi SAAT user berinteraksi dengan
 * command trading apa pun, bukan cron terpisah.
 * ========================================================================= */

async function handlePortfolio(interaction, res) {
  const userId = getInvokerId(interaction);

  const overdueResult = await checkAndHandleOverdueLoan(userId);

  const [balance, portfolio, prices, loan, badDebt] = await Promise.all([
    getBalance(userId),
    getPortfolio(userId),
    getAllPrices(),
    getLoan(userId),
    getBadDebt(userId),
  ]);

  if (balance === null || portfolio === null) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' },
    });
    return;
  }

  let assetValue = 0;
  const holdingLines = [];
  for (const code of ASSET_CODES) {
    const qty = portfolio[code];
    if (qty > 0) {
      const def = getAssetDefinition(code);
      const value = qty * prices[code];
      assetValue += value;
      holdingLines.push(`${def.emoji} **${code}**: ${qty} unit (💵 ${value.toLocaleString('id-ID')} ZYC)`);
    }
  }

  const totalValue = balance + assetValue;
  const fields = [
    { name: 'Saldo Cash', value: `💵 ${balance.toLocaleString('id-ID')} ZYC`, inline: true },
    { name: 'Nilai Aset', value: `💰 ${assetValue.toLocaleString('id-ID')} ZYC`, inline: true },
    { name: 'Total Kekayaan', value: `**${totalValue.toLocaleString('id-ID')} ZYC**`, inline: true },
  ];

  if (holdingLines.length) {
    fields.push({ name: 'Kepemilikan Aset', value: holdingLines.join('\n'), inline: false });
  }

  if (loan && loan.amount > 0) {
    const dueDate = new Date(loan.dueAt).toLocaleDateString('id-ID');
    fields.push({ name: '⚠️ Utang Aktif', value: `💵 ${loan.amount.toLocaleString('id-ID')} ZYC — jatuh tempo ${dueDate}`, inline: false });
  }

  if (badDebt > 0) {
    fields.push({ name: '🚨 Bad Debt', value: `💵 ${badDebt.toLocaleString('id-ID')} ZYC (menunggu approval Owner untuk dihapus)`, inline: false });
  }

  const embeds = [
    {
      title: '💼 Portfolio Kamu',
      color: 0x5865f2,
      fields,
    },
  ];

  let content;
  if (overdueResult.seized) {
    const d = overdueResult.details;
    if (d.fullyCovered) {
      const seizedText = d.seizedAssets.map((s) => `${s.quantity} ${s.code}`).join(', ');
      content = `🚨 Utang kamu (💵 ${d.loanAmount.toLocaleString('id-ID')} ZYC) sudah lewat tenor — aset disita otomatis: ${seizedText}.`;
    } else {
      content = `🚨 Utang kamu sudah lewat tenor dan SEMUA aset disita, tapi masih kurang 💵 ${d.badDebtAmount.toLocaleString('id-ID')} ZYC. Sisa itu tercatat sebagai bad debt, menunggu keputusan Owner.`;
    }
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, embeds },
  });
}

module.exports = { handlePortfolio };
