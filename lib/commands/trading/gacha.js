'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const { checkAndHandleOverdueLoan, formatZYC } = require('../../trading');
const { executeGachaPulls, GACHA_COST_PER_PULL } = require('../../gachaEngine');
const { getShopItem } = require('../../shopItems');
const { publishJob } = require('../../qstash');
const { editOriginalInteractionResponse } = require('../../discordApi');

/* =========================================================================
 * /gacha {pull} — money sink + sumber utility item & Founder Shares.
 * Lihat lib/gachaEngine.js untuk detail rate & formula.
 *
 * PEMBAGIAN INSTAN vs DEFERRED (fix timeout Discord Interaction 3 detik):
 *   - pull=1  -> INSTAN (Type 4 langsung). Satu pull cukup cepat
 *     (~terbukti dari testing), tidak perlu lewat QStash sama sekali.
 *   - pull=5/10 -> DEFERRED (Type 5) + job ke /api/process-gacha. Loop
 *     I/O Redis sekuensial untuk banyak pull (tiap pull baca+tulis
 *     saldo/inventory/shares) bisa mendekati/lewat 3 detik dijumlah
 *     dengan RTT jaringan — bukan sekadar dipercepat, tapi DIPINDAH ke
 *     luar batas waktu interaksi Discord sepenuhnya, konsisten dengan
 *     pola /tanya /status /export yang sudah ada (lihat README bagian
 *     "Pola QStash 2-tahap").
 *
 * Kenapa BUKAN cuma Promise.all tanpa QStash: memparalelkan penuh 10
 * pull independen berisiko race condition pada operasi yang sama-sama
 * menyentuh saldo/inventory user yang sama dalam satu request (adjustBalance/
 * hincrby yang saling tumpang tindih). Loop sekuensial di dalam job
 * QStash (yang punya waktu bebas, tidak terikat limit 3 detik) lebih
 * aman daripada paralelisasi yang mengorbankan konsistensi data demi
 * kecepatan.
 * ========================================================================= */

const TIER_EMOJI = {
  common: '⚪',
  uncommon: '🟢',
  rare: '🔵',
  epic: '🟣',
};

function formatPullResult(result) {
  const emoji = TIER_EMOJI[result.tier] || '⚪';

  if (result.rewardType === 'cash') {
    return `${emoji} [${result.tier.toUpperCase()}] 💵 ${formatZYC(result.amount)} ZYC`;
  }
  if (result.rewardType === 'share') {
    return `${emoji} [${result.tier.toUpperCase()}] 🏆 **${result.shareId}** JACKPOT! (total dimiliki: ${result.totalOwned}x)`;
  }
  // consumable atau cosmetic
  const itemDef = getShopItem(result.itemId);
  const itemName = itemDef?.name || result.itemId;
  return `${emoji} [${result.tier.toUpperCase()}] 📦 ${itemName}`;
}

/**
 * buildGachaResultEmbed — dipakai BERSAMA oleh jalur instan (1x) dan
 * jalur job QStash (5x/10x, lihat api/process-gacha.js) — supaya
 * tampilan hasil selalu identik terlepas dari jalur eksekusinya.
 */
function buildGachaResultEmbed(result) {
  const lines = result.results.map(formatPullResult);
  const jackpotHit = result.results.some((r) => r.rewardType === 'share' || (r.rewardType === 'cash' && r.tier === 'epic'));

  return {
    embeds: [
      {
        title: jackpotHit ? '🎉 GACHA — JACKPOT!' : '🎰 Hasil Gacha',
        color: jackpotHit ? 0xf1c40f : 0x9b59b6,
        description: `Total biaya: 💵 ${formatZYC(result.totalCost)} ZYC (${result.pullCount}x pull)\n\n${lines.join('\n')}`,
      },
    ],
  };
}

async function handleGacha(interaction, res) {
  const userId = getInvokerId(interaction);
  await checkAndHandleOverdueLoan(userId);

  const options = interaction.data?.options || [];
  const pullOpt = options.find((o) => o.name === 'pull');
  const pullCount = Number(pullOpt?.value || 1);

  // Jalur INSTAN: cuma untuk 1x pull.
  if (pullCount === 1) {
    const result = await executeGachaPulls(userId, pullCount);
    if (!result.ok) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: result.error },
      });
      return;
    }

    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: buildGachaResultEmbed(result),
    });
    return;
  }

  // Jalur DEFERRED: 5x/10x pull, lempar job ke QStash supaya loop
  // eksekusinya bebas dari limit 3 detik interaksi Discord.
  try {
    await publishJob({
      endpointPath: '/api/process-gacha',
      payload: { token: interaction.token, userId, pullCount },
    });
  } catch (err) {
    console.error('[handleGacha] Failed to publish QStash job:', err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal menjadwalkan gacha batch. Coba lagi beberapa saat ya 🙏' },
    });
    return;
  }

  res.status(200).json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
}

/**
 * processGachaJob — dipanggil dari api/process-gacha.js (job QStash
 * untuk batch 5x/10x). Menjalankan executeGachaPulls() sepenuhnya
 * (bebas dari limit 3 detik interaksi Discord), lalu PATCH hasil ATAU
 * pesan error ke pesan asli via editOriginalInteractionResponse — pola
 * identik dengan processAiJob() di lib/commands.js.
 */
async function processGachaJob({ token, userId, pullCount }) {
  try {
    const result = await executeGachaPulls(userId, pullCount);

    if (!result.ok) {
      await editOriginalInteractionResponse(token, { content: result.error });
      return;
    }

    await editOriginalInteractionResponse(token, buildGachaResultEmbed(result));
  } catch (err) {
    console.error('[processGachaJob] Unhandled error:', err.message);
    await editOriginalInteractionResponse(token, { content: '⚠️ Terjadi kesalahan saat memproses gacha. Coba lagi ya 🙏' }).catch(() => {});
  }
}

module.exports = { handleGacha, buildGachaResultEmbed, processGachaJob };
