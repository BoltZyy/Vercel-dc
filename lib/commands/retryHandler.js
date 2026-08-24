'use strict';

const { getRetryJob } = require('../redis');
const { publishAiJob } = require('../qstash');

/* =========================================================================
 * RETRY BUTTON HANDLER — dipanggil dari api/index.js saat interaction
 * type MESSAGE_COMPONENT (3) diterima dengan custom_id berformat
 * "retry:{jobId}". Ambil payload job asli dari Redis, publish ulang ke
 * QStash persis seperti job pertama kali, lalu update pesan supaya
 * tombol lama hilang dan Discord menampilkan "thinking..." lagi.
 *
 * response type 6 (DEFERRED_UPDATE_MESSAGE) dipakai di sini, BUKAN type 5
 * (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE) — karena ini bukan command baru,
 * melainkan update atas pesan yang sudah ada (pesan error + tombol tadi).
 * type 6 mengakui interaction tombol tanpa membuat pesan baru. Setiap
 * interaction (termasuk klik tombol) punya token-nya sendiri yang
 * independen dari token command asli — token BARU inilah yang dipakai
 * untuk PATCH @original nanti di processAiJob, dan @original akan
 * merujuk ke pesan tombol ini (bukan pesan command paling awal).
 * ========================================================================= */

async function handleRetryButton(interaction, res) {
  const customId = interaction.data?.custom_id || '';
  const match = customId.match(/^retry:(.+)$/);

  if (!match) {
    // custom_id tidak dikenali -> abaikan dengan aman, jangan biarkan
    // Discord menampilkan error interaksi gagal ke user.
    res.status(200).json({ type: 6 }); // DEFERRED_UPDATE_MESSAGE
    return;
  }

  const jobId = match[1];
  const job = await getRetryJob(jobId);

  if (!job) {
    // Job sudah expired (>15 menit) atau Redis tidak dikonfigurasi.
    res.status(200).json({
      type: 7, // UPDATE_MESSAGE
      data: {
        content: '⚠️ Sesi retry sudah kedaluwarsa. Silakan jalankan command aslinya lagi.',
        components: [],
      },
    });
    return;
  }

  const newToken = interaction.token;

  try {
    await publishAiJob({
      token: newToken,
      channelId: job.channelId,
      userId: job.userId,
      userMessage: job.userMessage,
      isOwner: job.isOwner,
      jobType: job.jobType,
      extra: job.extra,
    });
  } catch (err) {
    console.error('[handleRetryButton] Failed to re-publish QStash job:', err.message);
    res.status(200).json({
      type: 7,
      data: { content: '⚠️ Gagal mencoba lagi. Coba jalankan command aslinya lagi.', components: [] },
    });
    return;
  }

  // Update pesan lama: hapus tombol, Discord otomatis tampilkan
  // "thinking..." baru karena kita balas DEFERRED_UPDATE_MESSAGE.
  res.status(200).json({
    type: 6, // DEFERRED_UPDATE_MESSAGE — akui interaksi, tidak buat pesan baru
  });
}

module.exports = { handleRetryButton };
