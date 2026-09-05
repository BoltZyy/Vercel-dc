'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const {
  getBalance,
  getPortfolio,
  getAllPrices,
  getLoan,
  getBadDebt,
  checkAndHandleOverdueLoan,
  cleanInteger,
  formatZYC,
} = require('../../trading');
const { ASSET_CODES, getAssetDefinition } = require('../../tradingAssets');

/* =========================================================================
 * /portfolio — lihat saldo ZYC, kepemilikan aset, dan estimasi nilai
 * total. Instan (baca dari Redis, tidak panggil AI).
 *
 * SEMUA kalkulasi matematika di bawah pakai Number murni yang sudah
 * disanitasi cleanInteger() — formatZYC() cuma dipakai di tahap AKHIR
 * saat menyusun teks embed, tidak pernah dipakai untuk kalkulasi.
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

  // balance & qty sudah dijamin Integer murni oleh trading.js — cleanInteger()
  // di sini tetap dipertahankan sebagai lapisan pertahanan kedua.
  const cleanBalance = cleanInteger(balance);

  let assetValue = 0;
  const holdingLines = [];
  for (const code of ASSET_CODES) {
    const qty = cleanInteger(portfolio[code]);
    if (qty > 0) {
      const def = getAssetDefinition(code);
      // price boleh desimal — value hasil kali DIBULATKAN sebelum
      // dijumlahkan, supaya tidak ada residu desimal menumpuk.
      const value = cleanInteger(qty * prices[code]);
      assetValue += value;
      holdingLines.push(`${def.emoji} **${code}**: ${qty} unit (💵 ${formatZYC(value)} ZYC)`);
    }
  }
  assetValue = cleanInteger(assetValue);

  const totalValue = cleanInteger(cleanBalance + assetValue);
  const fields = [
    { name: 'Saldo Cash', value: `💵 ${formatZYC(cleanBalance)} ZYC`, inline: true },
    { name: 'Nilai Aset', value: `💰 ${formatZYC(assetValue)} ZYC`, inline: true },
    { name: 'Total Kekayaan', value: `**${formatZYC(totalValue)} ZYC**`, inline: true },
  ];

  if (holdingLines.length) {
    fields.push({ name: 'Kepemilikan Aset', value: holdingLines.join('\n'), inline: false });
  }

  if (loan && loan.amount > 0) {
    const dueDate = new Date(loan.dueAt).toLocaleDateString('id-ID');
    fields.push({ name: '⚠️ Utang Aktif', value: `💵 ${formatZYC(loan.amount)} ZYC — jatuh tempo ${dueDate}`, inline: false });
  }

  const cleanBadDebt = cleanInteger(badDebt);
  if (cleanBadDebt > 0) {
    fields.push({ name: '🚨 Bad Debt', value: `💵 ${formatZYC(cleanBadDebt)} ZYC (menunggu approval Owner untuk dihapus)`, inline: false });
  }

  const embeds = [{ title: '💼 Portfolio Kamu', color: 0x5865f2, fields }];

  let content;
  if (overdueResult.seized) {
    const d = overdueResult.details;
    if (d.fullyCovered) {
      const seizedText = d.seizedAssets.map((s) => `${s.quantity} ${s.code}`).join(', ');
      content = `🚨 Utang kamu (💵 ${formatZYC(d.loanAmount)} ZYC) sudah lewat tenor — aset disita otomatis: ${seizedText}.`;
    } else {
      content = `🚨 Utang kamu sudah lewat tenor dan SEMUA aset disita, tapi masih kurang 💵 ${formatZYC(d.badDebtAmount)} ZYC. Sisa itu tercatat sebagai bad debt, menunggu keputusan Owner.`;
    }
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, embeds },
  });
}

module.exports = { handlePortfolio };
