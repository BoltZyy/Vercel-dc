'use strict';

const { CONFIG } = require('./config');
const { sendChannelMessage } = require('./discordApi');

/* =========================================================================
 * ERROR LOGGING — kirim notifikasi otomatis ke channel Discord privat
 * (LOG_CHANNEL_ID) tiap kali ada error signifikan (AI proxy gagal, QStash
 * gagal publish, dll). Best-effort — kegagalan kirim log TIDAK PERNAH
 * melempar error balik ke pemanggil, supaya tidak mengganggu alur utama.
 *
 * Dirate-limit sederhana di memori proses (bukan Redis) supaya error
 * beruntun (misal gateway AI down total) tidak spam channel log ratusan
 * kali dalam hitungan detik. Catatan: karena tiap invocation serverless
 * bisa jadi instance/process berbeda, rate-limit ini best-effort saja,
 * bukan jaminan keras — cukup untuk mengurangi spam kasus umum.
 *
 * PENTING: rate-limit di atas HANYA berlaku untuk notifikasi channel
 * real-time. Pencatatan ke audit log (Redis, dipakai /audit-log) TIDAK
 * di-rate-limit — semua error tetap tercatat permanen, supaya histori
 * lengkap tidak hilang cuma karena error beruntun dalam waktu singkat.
 * ========================================================================= */

let lastLogAt = 0;
const MIN_INTERVAL_MS = 3000; // maks 1 notifikasi channel per 3 detik per warm instance

async function logErrorToChannel({ source, message, userId, channelId, extra }) {
  // Audit log (Redis) — SELALU dicatat, tidak kena rate-limit.
  // Lazy require untuk hindari circular dependency (redis.js tidak
  // butuh errorLog.js).
  const { logAuditEvent } = require('./redis');
  await logAuditEvent('error', { source, message: String(message).slice(0, 500), userId, channelId });

  if (!CONFIG.LOG_CHANNEL_ID) return;

  const now = Date.now();
  if (now - lastLogAt < MIN_INTERVAL_MS) return;
  lastLogAt = now;

  try {
    await sendChannelMessage(CONFIG.LOG_CHANNEL_ID, {
      embeds: [
        {
          title: '⚠️ Bot Error',
          color: 0xed4245,
          fields: [
            { name: 'Source', value: `\`${source}\``, inline: true },
            ...(userId ? [{ name: 'User', value: `<@${userId}>`, inline: true }] : []),
            ...(channelId ? [{ name: 'Channel', value: `<#${channelId}>`, inline: true }] : []),
            { name: 'Message', value: `\`\`\`${String(message).slice(0, 900)}\`\`\`` },
            ...(extra ? [{ name: 'Extra', value: `\`\`\`${String(extra).slice(0, 500)}\`\`\`` }] : []),
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    });
  } catch (err) {
    // Sengaja cuma console.error, bukan re-throw — log gagal tidak boleh
    // menjatuhkan alur utama yang memanggil fungsi ini.
    console.error('[errorLog] Failed to send error log to channel:', err.message);
  }
}

module.exports = { logErrorToChannel };
