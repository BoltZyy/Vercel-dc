'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const { checkAndHandleOverdueLoan, formatZYC } = require('../../trading');
const { JOB_IDS, getJob, executeWork, MAX_STAMINA, getStaminaState, getNextChargeEta } = require('../../workEngine');

/* =========================================================================
 * /work {job} — kerja untuk dapat ZYC, dibatasi sistem stamina (5 charge,
 * regen 1/120 detik, timestamp-based tanpa cron). Lihat lib/workEngine.js
 * untuk detail model regen & payout.
 * ========================================================================= */

const RISK_LABELS = {
  low: '🟢 Aman',
  high: '🔴 Spekulasi',
  meme: '🎭 Meme & Unik',
};

async function handleWork(interaction, res) {
  const userId = getInvokerId(interaction);
  // Gaji otomatis kepotong sitaan kalau user sedang nunggak, sebelum
  // sempat kerja dan dapat uang baru.
  await checkAndHandleOverdueLoan(userId);

  const options = interaction.data?.options || [];
  const jobOpt = options.find((o) => o.name === 'job');
  const job = getJob(jobOpt?.value);

  if (!job) {
    const jobList = JOB_IDS.map((id) => `\`${id}\``).join(', ');
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ Pekerjaan tidak dikenal. Pilihan: ${jobList}` },
    });
    return;
  }

  const result = await executeWork(userId, job.id);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: result.error },
    });
    return;
  }

  let description;
  let color;
  if (result.outcome === 'success' || result.outcome === 'normal') {
    description = `Kamu kerja sebagai **${result.job.name}** dan dapat 💵 **${formatZYC(result.amount)} ZYC**!`;
    color = 0x2ecc71;
  } else {
    description = result.amount > 0
      ? `Kerja sebagai **${result.job.name}** kurang beruntung... cuma dapat 💵 **${formatZYC(result.amount)} ZYC**.`
      : `Kerja sebagai **${result.job.name}** zonk total. 💵 **0 ZYC**.`;
    color = 0xe74c3c;
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: result.isSuccess ? '✅ Kerja Berhasil' : '😔 Kerja Kurang Beruntung',
          color,
          description,
          footer: { text: `⚡ Stamina tersisa: ${result.remainingStamina}/${MAX_STAMINA}` },
        },
      ],
    },
  });
}

module.exports = { handleWork, RISK_LABELS };
