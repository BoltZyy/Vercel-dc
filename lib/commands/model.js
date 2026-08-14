'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { CONFIG } = require('../config');
const { isOwner } = require('../permissions');
const { getModelOverride, setModelOverride, clearModelOverride } = require('../redis');

/* =========================================================================
 * /model {set?} — lihat status model AI aktif, atau ganti model on-the-fly
 * tanpa redeploy. Owner-only, instan (baca/tulis Redis, tidak panggil AI).
 *
 * Tanpa opsi 'set'   -> tampilkan model aktif saat ini (override Redis
 *                       kalau ada, atau default dari ENV).
 * Dengan opsi 'set'  -> "default" mengembalikan ke ENV default (hapus
 *                       override), nama lain disimpan sebagai override.
 *                       Nama model TIDAK divalidasi di sini — kalau salah
 *                       ketik, errornya akan muncul natural dari gateway
 *                       AI kamu sendiri saat command AI berikutnya dipanggil.
 * ========================================================================= */

async function handleModel(interaction, res) {
  if (!isOwner(interaction)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❌ Command ini khusus Owner.' },
    });
    return;
  }

  const options = interaction.data?.options || [];
  const setOpt = options.find((o) => o.name === 'set');

  if (setOpt) {
    const newModel = setOpt.value.trim();
    try {
      if (newModel.toLowerCase() === 'default') {
        await clearModelOverride();
        res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `✅ Model dikembalikan ke default ENV: \`${CONFIG.VERCEL_PROXY_MODEL}\`` },
        });
      } else {
        await setModelOverride(newModel);
        res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `✅ Model aktif diubah ke: \`${newModel}\`\n⚠️ Nama model tidak divalidasi di sini — kalau salah ketik, errornya akan muncul saat command AI berikutnya dipanggil.`,
          },
        });
      }
    } catch (err) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '⚠️ Gagal mengubah model (Redis tidak dikonfigurasi atau error).' },
      });
    }
    return;
  }

  // Tanpa opsi 'set' -> tampilkan status saat ini.
  const override = await getModelOverride();
  const activeModel = override || CONFIG.VERCEL_PROXY_MODEL;
  const proxyConfigured = Boolean(CONFIG.VERCEL_PROXY_URL && CONFIG.VERCEL_PROXY_KEY);

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: '🔧 Saucepan Engine — Model Status',
          color: 0x5865f2,
          fields: [
            { name: 'Active Model', value: `\`${activeModel}\``, inline: true },
            { name: 'Sumber', value: override ? 'Override (Redis)' : 'Default (ENV)', inline: true },
            { name: 'Proxy Status', value: proxyConfigured ? '✅ Configured' : '❌ Not configured', inline: true },
            { name: 'Proxy URL', value: CONFIG.VERCEL_PROXY_URL ? `\`${CONFIG.VERCEL_PROXY_URL}\`` : '—', inline: false },
          ],
          footer: { text: 'Pakai /model set:<nama> untuk ganti, atau set:default untuk kembali ke ENV.' },
        },
      ],
    },
  });
}

module.exports = { handleModel };
