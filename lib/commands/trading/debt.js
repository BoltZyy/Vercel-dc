'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId, isOwner } = require('../../permissions');
const {
  borrowMoney,
  repayLoan,
  getLoan,
  getBadDebt,
  approveBadDebtClear,
  checkAndHandleOverdueLoan,
} = require('../../trading');
const { CONFIG } = require('../../config');

/* =========================================================================
 * /pinjam {jumlah}       — ambil pinjaman dari bank fiktif
 * /bayar-utang {jumlah}  — bayar cicilan/lunasi utang
 * /debt                  — lihat status utang & bad debt sendiri
 * /debt approve {user}   — Owner-only, hapus bad debt user
 * ========================================================================= */

async function handlePinjam(interaction, res) {
  const userId = getInvokerId(interaction);
  await checkAndHandleOverdueLoan(userId);

  const options = interaction.data?.options || [];
  const jumlahOpt = options.find((o) => o.name === 'jumlah');
  const amount = jumlahOpt?.value;

  if (typeof amount !== 'number' || amount <= 0) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Jumlah pinjaman harus angka lebih dari 0.' },
    });
    return;
  }

  try {
    const loan = await borrowMoney(userId, amount);
    const dueDate = new Date(loan.dueAt).toLocaleDateString('id-ID');
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: [
          `✅ Pinjaman 💵 ${amount.toLocaleString('id-ID')} ZYC cair ke saldo kamu.`,
          `📋 Total utang sekarang: 💵 ${loan.amount.toLocaleString('id-ID')} ZYC`,
          `⏰ Jatuh tempo: ${dueDate} (${CONFIG.LOAN_DUE_DAYS} hari dari sekarang)`,
          `⚠️ Kalau lewat tenor, aset kamu bisa disita otomatis buat nutup utang!`,
        ].join('\n'),
      },
    });
  } catch (err) {
    console.error('[handlePinjam] error:', err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal mengambil pinjaman (Redis tidak dikonfigurasi atau error).' },
    });
  }
}

async function handleBayarUtang(interaction, res) {
  const userId = getInvokerId(interaction);
  await checkAndHandleOverdueLoan(userId);

  const options = interaction.data?.options || [];
  const jumlahOpt = options.find((o) => o.name === 'jumlah');
  const amount = jumlahOpt?.value;

  if (typeof amount !== 'number' || amount <= 0) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Jumlah pembayaran harus angka lebih dari 0.' },
    });
    return;
  }

  const result = await repayLoan(userId, amount);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ ${result.error}` },
    });
    return;
  }

  const content =
    result.remaining <= 0
      ? `✅ Utang lunas! Kamu membayar 💵 ${result.paid.toLocaleString('id-ID')} ZYC.`
      : `✅ Pembayaran 💵 ${result.paid.toLocaleString('id-ID')} ZYC diterima. Sisa utang: 💵 ${result.remaining.toLocaleString('id-ID')} ZYC.`;

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content },
  });
}

async function handleDebt(interaction, res) {
  const userId = getInvokerId(interaction);
  const overdueResult = await checkAndHandleOverdueLoan(userId);

  const [loan, badDebt] = await Promise.all([getLoan(userId), getBadDebt(userId)]);

  const lines = [];
  if (loan && loan.amount > 0) {
    const dueDate = new Date(loan.dueAt).toLocaleDateString('id-ID');
    const daysLeft = Math.ceil((loan.dueAt - Date.now()) / (24 * 3600 * 1000));
    lines.push(`📋 **Utang Aktif:** 💵 ${loan.amount.toLocaleString('id-ID')} ZYC`);
    lines.push(`⏰ Jatuh tempo: ${dueDate} (${daysLeft > 0 ? `${daysLeft} hari lagi` : 'SUDAH LEWAT'})`);
  } else {
    lines.push('✅ Kamu tidak punya utang aktif.');
  }

  if (badDebt > 0) {
    lines.push('');
    lines.push(`🚨 **Bad Debt:** 💵 ${badDebt.toLocaleString('id-ID')} ZYC (menunggu approval Owner untuk dihapus)`);
  }

  let content;
  if (overdueResult.seized) {
    const d = overdueResult.details;
    content = d.fullyCovered
      ? `🚨 Utang kamu baru saja lewat tenor — aset disita otomatis untuk menutupnya.`
      : `🚨 Utang kamu lewat tenor, semua aset disita tapi masih kurang — sisanya jadi bad debt.`;
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      embeds: [{ title: '🏦 Status Utang Kamu', color: 0xed4245, description: lines.join('\n') }],
    },
  });
}

async function handleDebtApprove(interaction, res) {
  if (!isOwner(interaction)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❌ Command ini khusus Owner.' },
    });
    return;
  }

  const options = interaction.data?.options || [];
  const userOpt = options.find((o) => o.name === 'user');
  const targetId = userOpt?.value;

  if (!targetId) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Pilih user yang bad debt-nya mau dihapus.' },
    });
    return;
  }

  try {
    const amount = await approveBadDebtClear(targetId);
    if (amount <= 0) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `ℹ️ <@${targetId}> tidak punya bad debt.` },
      });
      return;
    }
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `✅ Bad debt <@${targetId}> sebesar 💵 ${amount.toLocaleString('id-ID')} ZYC berhasil dihapus.` },
    });
  } catch (err) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal menghapus bad debt (Redis tidak dikonfigurasi atau error).' },
    });
  }
}

module.exports = { handlePinjam, handleBayarUtang, handleDebt, handleDebtApprove };
