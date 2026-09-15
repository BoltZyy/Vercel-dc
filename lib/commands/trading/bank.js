'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const { checkAndHandleOverdueLoan, formatZYC, getInventory, consumeInventoryItem } = require('../../trading');
const { isDevBypassed } = require('../../devHelper');
const {
  BANK_TIER_IDS,
  getBankTier,
  depositToBank,
  getDepositStatus,
  withdrawFromBank,
  PASSCARD_DAILY_LIMIT,
  getPasscardUsageToday,
  incrementPasscardUsage,
  depositToSavings,
  withdrawFromSavings,
  getSavingsStatus,
  claimSavingsInterest,
  REGULAR_SAVINGS_CLAIM_COOLDOWN_MS,
} = require('../../bankEngine');

/* =========================================================================
 * /bank-list, /bank-deposit, /bank-withdraw, /bank-status — command
 * MANDIRI terpisah (bukan subcommand grup /bank), sesuai keputusan
 * desain proyek ini: command campuran polos+subcommand tidak valid,
 * harus dipisah jadi command mandiri (lihat README).
 *
 * Bunga dihitung dari selisih timestamp (bukan cron). Lihat
 * lib/bankEngine.js untuk detail model bunga & penalti.
 * ========================================================================= */

function formatDuration(ms) {
  if (ms === 0) return 'Tanpa lock';
  const hours = ms / (60 * 60 * 1000);
  return `${hours} jam`;
}

async function handleBankList(interaction, res) {
  const fields = BANK_TIER_IDS.map((id) => {
    const tier = getBankTier(id);
    const penaltyText = tier.earlyWithdrawPenalty
      ? tier.earlyWithdrawPenalty.type === 'principal_cut'
        ? `Early withdraw: potong ${tier.earlyWithdrawPenalty.rate * 100}% modal`
        : `Early withdraw: potong ${tier.earlyWithdrawPenalty.rate * 100}% modal + bunga hangus`
      : 'Bebas withdraw kapan saja, tanpa penalti';
    return {
      name: `${tier.name} — \`${tier.id}\``,
      value: `Bunga: **${tier.dailyRate * 100}%/hari** (simple interest, per hari penuh)\nLock: ${formatDuration(tier.lockDurationMs)}\n${penaltyText}`,
      inline: false,
    };
  });

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: '🏦 Daftar Bank & Staking',
          description: 'Pakai `/bank deposit bank:<kode> jumlah:<angka>` untuk mulai staking. Hanya 1 deposit aktif per user.',
          color: 0x2ecc71,
          fields,
        },
      ],
    },
  });
}

async function handleBankDeposit(interaction, res) {
  const userId = getInvokerId(interaction);
  const bypassed = await isDevBypassed(userId);

  // Wajib dicek dulu — user yang nunggak jangan bisa "kabur" menyembunyikan
  // ZYC-nya di bank sebelum aset disita. Dev bypass melewati ini
  // sepenuhnya (tidak dipanggil sama sekali).
  if (!bypassed) {
    await checkAndHandleOverdueLoan(userId);
  }

  const options = interaction.data?.options || [];
  const typeOpt = options.find((o) => o.name === 'type');
  const bankOpt = options.find((o) => o.name === 'bank');
  const jumlahOpt = options.find((o) => o.name === 'jumlah');

  const type = typeOpt?.value;

  if (type === 'REGULAR') {
    const result = await depositToSavings(userId, jumlahOpt?.value);
    if (!result.ok) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: result.error },
      });
      return;
    }
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [
          {
            title: '✅ Setor ke Tabungan Reguler Berhasil',
            color: 0x2ecc71,
            description: `Kamu setor 💵 ${formatZYC(result.amount)} ZYC ke Rekening Tabungan Reguler.\nTotal saldo tabungan: 💵 ${formatZYC(result.newBalance)} ZYC.\nBunga harus diklaim manual lewat \`/bank-claim\` (cooldown 24 jam).`,
          },
        ],
      },
    });
    return;
  }

  if (type === 'TIER_DEPOSIT') {
    if (!bankOpt?.value) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '⚠️ Pilih `bank:` (CENTRAL_RESERVE/KRYNITHIAN_COMMERCIAL/VOLT_APEX_NEOBANK) untuk deposito bertingkat.' },
      });
      return;
    }

    const result = await depositToBank(userId, bankOpt.value, jumlahOpt?.value);
    if (!result.ok) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: result.error },
      });
      return;
    }

    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [
          {
            title: '✅ Deposit Berhasil',
            color: 0x2ecc71,
            description: `Kamu deposit 💵 ${formatZYC(result.amount)} ZYC ke **${result.tier.name}** (${result.tier.dailyRate * 100}%/hari).\n${result.tier.lockDurationMs > 0 ? `Lock ${formatDuration(result.tier.lockDurationMs)} -- withdraw sebelum itu kena penalti.` : 'Bisa withdraw kapan saja tanpa penalti.'}`,
          },
        ],
      },
    });
    return;
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: '⚠️ Pilih `type:` REGULAR atau TIER_DEPOSIT.' },
  });
}

async function handleBankStatus(interaction, res) {
  const userId = getInvokerId(interaction);
  const options = interaction.data?.options || [];
  const typeOpt = options.find((o) => o.name === 'type');
  const type = typeOpt?.value || 'TIER_DEPOSIT'; // default TIER_DEPOSIT supaya command lama (tanpa isi type) tetap jalan sama seperti sebelumnya

  if (type === 'REGULAR') {
    const status = await getSavingsStatus(userId);
    if (!status.ok) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: status.error },
      });
      return;
    }
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [
          {
            title: '📊 Status Tabungan Reguler',
            color: 0x3498db,
            fields: [
              { name: 'Saldo Pokok', value: `💵 ${formatZYC(status.balance)} ZYC`, inline: true },
              { name: 'Rate Harian', value: `${status.rate * 100}%/hari`, inline: true },
              { name: 'Bunga Terkumpul', value: `💵 ${formatZYC(status.accruedInterest)} ZYC`, inline: true },
              { name: 'Bunga Hari Berjalan (belum matang)', value: `💵 ${formatZYC(status.pendingInterest)} ZYC`, inline: true },
              { name: 'Total Bisa Diklaim', value: `💵 ${formatZYC(status.totalClaimable)} ZYC`, inline: true },
            ],
          },
        ],
      },
    });
    return;
  }

  const status = await getDepositStatus(userId);

  if (!status.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: status.error },
    });
    return;
  }

  const lockText = status.lockExpired
    ? '✅ Lock sudah selesai, bisa withdraw tanpa penalti.'
    : `🔒 Masih terkunci sampai <t:${Math.floor(status.unlockAt / 1000)}:R>. Withdraw sekarang akan kena penalti.`;

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: '📊 Status Deposit',
          color: 0x3498db,
          fields: [
            { name: 'Bank', value: status.tier.name, inline: true },
            { name: 'Modal', value: `💵 ${formatZYC(status.principal)} ZYC`, inline: true },
            { name: 'Hari Berjalan', value: `${status.daysElapsed} hari`, inline: true },
            { name: 'Bunga Terkumpul', value: `💵 ${formatZYC(status.interest)} ZYC`, inline: true },
            { name: 'Total Jika Withdraw Sekarang', value: `💵 ${formatZYC(status.totalIfWithdrawNow)} ZYC`, inline: true },
            { name: 'Status Lock', value: lockText, inline: false },
          ],
        },
      ],
    },
  });
}

async function handleBankWithdraw(interaction, res) {
  const userId = getInvokerId(interaction);

  const options = interaction.data?.options || [];
  const typeOpt = options.find((o) => o.name === 'type');
  const type = typeOpt?.value || 'TIER_DEPOSIT'; // default TIER_DEPOSIT, backward compatible

  if (type === 'REGULAR') {
    const jumlahOpt = options.find((o) => o.name === 'jumlah');
    if (typeof jumlahOpt?.value !== 'number' || jumlahOpt.value <= 0) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '⚠️ Isi `jumlah:` (angka lebih dari 0) untuk withdraw Tabungan Reguler.' },
      });
      return;
    }

    const result = await withdrawFromSavings(userId, jumlahOpt.value);
    if (!result.ok) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: result.error },
      });
      return;
    }

    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [
          {
            title: '✅ Withdraw Tabungan Reguler Berhasil',
            color: 0x2ecc71,
            description: `Kamu tarik 💵 ${formatZYC(result.amount)} ZYC dari Tabungan Reguler.\nSisa saldo tabungan: 💵 ${formatZYC(result.newBalance)} ZYC.\n_(Bunga yang sudah terkumpul TIDAK ikut tertarik — tetap tersimpan, klaim terpisah lewat \`/bank-claim\`.)_`,
          },
        ],
      },
    });
    return;
  }

  const passcardOpt = options.find((o) => o.name === 'pakai_passcard');
  const wantsPasscard = passcardOpt?.value === true;

  let usePasscard = false;

  if (wantsPasscard) {
    // Rantai validasi passcard SEBELUM withdraw diproses sama sekali —
    // supaya kalau salah satu syarat gagal, tidak ada state (item,
    // deposit) yang berubah sedikit pun.
    const inventory = await getInventory(userId);
    if (inventory === null) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' },
      });
      return;
    }
    if ((inventory.ADVANCED_PASSCARD || 0) <= 0) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '⚠️ Kamu tidak punya 🎟️ Advanced Passcard. Beli dulu lewat `/shop-buy item:ADVANCED_PASSCARD`.' },
      });
      return;
    }

    const usage = await getPasscardUsageToday(userId);
    if (usage === null) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' },
      });
      return;
    }
    if (usage.count >= PASSCARD_DAILY_LIMIT) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `⚠️ Kamu sudah pakai Advanced Passcard ${PASSCARD_DAILY_LIMIT}x hari ini. Coba lagi besok, atau withdraw normal (kena penalti kalau masih lock).` },
      });
      return;
    }

    usePasscard = true;
  }

  const result = await withdrawFromBank(userId, usePasscard);

  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: result.error },
    });
    return;
  }

  // Konsumsi item + catat pemakaian HANYA setelah withdraw benar-benar
  // berhasil — supaya kalau withdrawFromBank gagal karena alasan lain
  // (misal tidak ada deposit aktif), item passcard tidak ikut hangus.
  if (usePasscard) {
    await consumeInventoryItem(userId, 'ADVANCED_PASSCARD');
    await incrementPasscardUsage(userId);
  }

  const lines = [
    `Modal awal: 💵 ${formatZYC(result.principal)} ZYC (${result.daysElapsed} hari di **${result.tier.name}**)`,
  ];
  if (result.usedPasscard) {
    lines.push('🎟️ Pakai Advanced Passcard -- pencairan instan, TANPA penalti meski lock belum selesai.');
    lines.push(`Bunga penuh: 💵 ${formatZYC(result.interestEarned)} ZYC`);
  } else if (result.wasEarlyWithdraw) {
    lines.push(`⚠️ Early withdraw -- ${result.penaltyDescription}`);
  } else {
    lines.push(`Bunga terkumpul: 💵 ${formatZYC(result.interestEarned)} ZYC`);
  }
  lines.push(`💰 **Total diterima: 💵 ${formatZYC(result.totalPayout)} ZYC**`);

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: result.usedPasscard ? '🎟️ Withdraw Instan (Passcard)' : result.wasEarlyWithdraw ? '⚠️ Withdraw (Early)' : '✅ Withdraw Berhasil',
          color: result.usedPasscard ? 0x9b59b6 : result.wasEarlyWithdraw ? 0xe67e22 : 0x2ecc71,
          description: lines.join('\n'),
        },
      ],
    },
  });
}

/**
 * handleBankClaim — /bank-claim: klaim manual bunga Tabungan Reguler
 * (BUKAN untuk deposito bertingkat — itu bunganya sudah otomatis
 * dihitung penuh saat /bank-withdraw, tidak perlu klaim terpisah).
 * Cooldown 24 jam, ADVANCED_PASSCARD melewati cooldown (menghitung
 * bunga penuh sampai saat ini juga, bukan cuma yang sudah matang).
 */
async function handleBankClaim(interaction, res) {
  const userId = getInvokerId(interaction);

  const options = interaction.data?.options || [];
  const passcardOpt = options.find((o) => o.name === 'pakai_passcard');
  const wantsPasscard = passcardOpt?.value === true;

  let usePasscard = false;

  if (wantsPasscard) {
    const inventory = await getInventory(userId);
    if (inventory === null) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' },
      });
      return;
    }
    if ((inventory.ADVANCED_PASSCARD || 0) <= 0) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '⚠️ Kamu tidak punya 🎟️ Advanced Passcard. Beli dulu lewat `/shop-buy item:ADVANCED_PASSCARD`.' },
      });
      return;
    }

    const usage = await getPasscardUsageToday(userId);
    if (usage === null) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' },
      });
      return;
    }
    if (usage.count >= PASSCARD_DAILY_LIMIT) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `⚠️ Kamu sudah pakai Advanced Passcard ${PASSCARD_DAILY_LIMIT}x hari ini. Coba lagi besok, atau tunggu cooldown klaim selesai.` },
      });
      return;
    }

    usePasscard = true;
  }

  const result = await claimSavingsInterest(userId, usePasscard);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: result.error },
    });
    return;
  }

  if (usePasscard) {
    await consumeInventoryItem(userId, 'ADVANCED_PASSCARD');
    await incrementPasscardUsage(userId);
  }

  const cooldownHours = REGULAR_SAVINGS_CLAIM_COOLDOWN_MS / (60 * 60 * 1000);
  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: result.usedPasscard ? '🎟️ Klaim Instan (Passcard)' : '✅ Klaim Bunga Berhasil',
          color: result.usedPasscard ? 0x9b59b6 : 0x2ecc71,
          description: [
            `💰 **Bunga diklaim: 💵 ${formatZYC(result.claimedAmount)} ZYC**`,
            result.usedPasscard
              ? '🎟️ Pakai Advanced Passcard -- klaim instan, cooldown 24 jam dilewati.'
              : `Klaim berikutnya bisa ${cooldownHours} jam lagi.`,
          ].join('\n'),
        },
      ],
    },
  });
}

module.exports = { handleBankList, handleBankDeposit, handleBankStatus, handleBankWithdraw, handleBankClaim };
