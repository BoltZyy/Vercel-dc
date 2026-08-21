'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { isOwner } = require('../permissions');
const { getConversation } = require('../redis');
const { editOriginalInteractionResponseWithFile, editOriginalInteractionResponse } = require('../discordApi');
const { publishJob } = require('../qstash');
const { logErrorToChannel } = require('../errorLog');

/* =========================================================================
 * /export {user} {format?} — Owner-only. Export riwayat percakapan AI
 * user tertentu di channel ini jadi file (.txt atau .md) yang bisa
 * didownload langsung dari Discord.
 *
 * Konsisten dengan pola /status: dipisah jadi 2 tahap via QStash, BUKAN
 * diproses langsung di request pertama — walau "cuma baca Redis", baca
 * Redis + build file + upload file balik ke Discord bisa >3 detik untuk
 * riwayat panjang, dan Vercel Node Functions tidak menjamin proses lanjut
 * berjalan setelah response pertama terkirim (lihat catatan arsitektur
 * /tanya). queueExport publish job (cepat), processExportJob (dipanggil
 * dari api/process-export.js) yang benar-benar baca & kirim file.
 * ========================================================================= */

function formatAsText(history, targetUserId) {
  const lines = [`Riwayat Percakapan — User ID: ${targetUserId}`, `Diekspor: ${new Date().toISOString()}`, ''];
  history.forEach((m) => {
    const label = m.role === 'user' ? 'User' : 'Bot';
    lines.push(`[${label}] ${m.content}`);
    lines.push('');
  });
  return lines.join('\n');
}

function formatAsMarkdown(history, targetUserId) {
  const lines = [`# Riwayat Percakapan`, ``, `- **User ID:** ${targetUserId}`, `- **Diekspor:** ${new Date().toISOString()}`, ``, `---`, ``];
  history.forEach((m) => {
    const label = m.role === 'user' ? '🙋 User' : '🤖 Bot';
    lines.push(`**${label}:**`);
    lines.push('');
    lines.push(m.content);
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * queueExport — dipanggil dari api/index.js. Validasi input & publish
 * job ke QStash, lalu balas deferred. Tidak baca Redis/build file di sini.
 */
async function queueExport(interaction, res) {
  if (!isOwner(interaction)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❌ Command ini khusus Owner.' },
    });
    return;
  }

  const options = interaction.data?.options || [];
  const userOpt = options.find((o) => o.name === 'user');
  const formatOpt = options.find((o) => o.name === 'format');

  const targetUserId = userOpt?.value;
  const format = formatOpt?.value || 'markdown';

  if (!targetUserId) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Pilih user yang riwayatnya mau diekspor.' },
    });
    return;
  }

  try {
    await publishJob({
      endpointPath: '/api/process-export',
      payload: {
        token: interaction.token,
        channelId: interaction.channel_id,
        targetUserId,
        format,
      },
    });
  } catch (err) {
    console.error('[queueExport] Failed to publish QStash job:', err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal menjadwalkan ekspor. Coba lagi beberapa saat ya 🙏' },
    });
    return;
  }

  res.status(200).json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
}

/**
 * processExportJob — dipanggil dari api/process-export.js, SAAT QStash
 * mem-POST balik job. Di sinilah Redis benar-benar dibaca dan file
 * benar-benar dibangun & diupload balik ke Discord via PATCH @original.
 */
async function processExportJob({ token, channelId, targetUserId, format }) {
  try {
    const history = await getConversation(channelId, targetUserId);

    if (!history.length) {
      await editOriginalInteractionResponse(token, {
        content: `📭 User <@${targetUserId}> belum punya riwayat percakapan di channel ini.`,
      });
      return;
    }

    const isMarkdown = format === 'markdown';
    const content = isMarkdown ? formatAsMarkdown(history, targetUserId) : formatAsText(history, targetUserId);
    const filename = `riwayat-${targetUserId}-${Date.now()}.${isMarkdown ? 'md' : 'txt'}`;

    await editOriginalInteractionResponseWithFile(
      token,
      { content: `📄 Riwayat percakapan <@${targetUserId}> di channel ini:` },
      { filename, content, contentType: isMarkdown ? 'text/markdown' : 'text/plain' }
    );
  } catch (err) {
    console.error('[processExportJob] error:', err.message);
    await editOriginalInteractionResponse(token, {
      content: '⚠️ Gagal mengekspor riwayat. Coba lagi beberapa saat ya 🙏',
    }).catch(() => {});
    await logErrorToChannel({
      source: 'processExportJob',
      message: err.message,
      userId: targetUserId,
      channelId,
    });
  }
}

module.exports = { queueExport, processExportJob };
