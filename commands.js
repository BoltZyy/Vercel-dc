'use strict';

const { CONFIG } = require('./config');
const { askAI, splitMessage } = require('./aiEngine');
const { editOriginalInteractionResponse, sendFollowupMessage } = require('./discordApi');
const { getConversation, appendConversation } = require('./redis');

/* =========================================================================
 * COMMAND HANDLERS
 * Setiap handler dipanggil SETELAH response Type 5 (deferred) sudah
 * dikirim balik ke Discord. Handler ini berjalan async dan menuntaskan
 * hasil lewat PATCH @original / POST followup.
 * ========================================================================= */

/**
 * handleTanya — /tanya [pesan]
 * Mengirim pesan user ke AI Proxy, lalu PATCH hasilnya ke @original.
 * Kalau hasil > 2000 karakter, chunk berikutnya dikirim via followup POST.
 */
async function handleTanya(interaction) {
  const { token, member, user } = interaction;
  const invokerId = member?.user?.id || user?.id;
  const isOwner = invokerId === CONFIG.OWNER_ID;

  const options = interaction.data?.options || [];
  const pesanOpt = options.find((o) => o.name === 'pesan');
  const userMessage = (pesanOpt?.value || '').trim();

  if (!userMessage) {
    await editOriginalInteractionResponse(token, {
      content: 'Halo! Tulis pertanyaanmu setelah `/tanya` ya 🙂',
    });
    return;
  }

  const channelId = interaction.channel_id;

  try {
    const history = await getConversation(channelId);
    const replyText = await askAI({ userMessage, isOwner, history });
    const chunks = splitMessage(replyText);

    await editOriginalInteractionResponse(token, { content: chunks[0] });

    for (let i = 1; i < chunks.length; i++) {
      await sendFollowupMessage(token, { content: chunks[i] });
    }

    await appendConversation(channelId, userMessage, replyText);
  } catch (err) {
    console.error('[handleTanya] AI error:', err.message);
    await editOriginalInteractionResponse(token, {
      content: '⚠️ Maaf, layanan AI sedang bermasalah. Coba lagi beberapa saat ya 🙏',
    }).catch(() => {});
  }
}

/**
 * handleModel — /model
 * Command sensitif khusus Owner. Menampilkan model aktif dari proxy.
 * Non-owner ditolak secara halus tanpa membocorkan detail konfigurasi.
 */
async function handleModel(interaction) {
  const { token, member, user } = interaction;
  const invokerId = member?.user?.id || user?.id;
  const isOwner = invokerId === CONFIG.OWNER_ID;

  if (!isOwner) {
    await editOriginalInteractionResponse(token, {
      content: '❌ Command ini khusus Owner.',
    });
    return;
  }

  const activeModel = CONFIG.VERCEL_PROXY_MODEL;
  const proxyConfigured = Boolean(CONFIG.VERCEL_PROXY_URL && CONFIG.VERCEL_PROXY_KEY);

  await editOriginalInteractionResponse(token, {
    embeds: [
      {
        title: '🔧 Saucepan Engine — Model Status',
        color: 0x5865f2,
        fields: [
          { name: 'Active Model', value: `\`${activeModel}\``, inline: true },
          { name: 'Proxy Status', value: proxyConfigured ? '✅ Configured' : '❌ Not configured', inline: true },
          { name: 'Proxy URL', value: CONFIG.VERCEL_PROXY_URL ? `\`${CONFIG.VERCEL_PROXY_URL}\`` : '—', inline: false },
        ],
        footer: { text: 'Ubah VERCEL_PROXY_MODEL di Environment Variables untuk ganti model.' },
      },
    ],
  });
}

module.exports = { handleTanya, handleModel };
