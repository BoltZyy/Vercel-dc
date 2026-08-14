'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { CONFIG } = require('../config');
const { isOwner } = require('../permissions');
const { getRedis, isMaintenanceMode } = require('../redis');
const { publishStatusJob } = require('../qstash');
const { editOriginalInteractionResponse } = require('../discordApi');

/* =========================================================================
 * /status — cek kesehatan Redis, QStash, dan gateway AI sekaligus dari
 * satu command. Owner-only. Melakukan pengecekan ringan (bukan full
 * request AI, supaya tidak makan kuota/token untuk sekadar cek status).
 * ========================================================================= */

async function checkRedis() {
  const redis = getRedis();
  if (!redis) return { ok: false, detail: 'Tidak dikonfigurasi' };
  try {
    const start = Date.now();
    await redis.ping();
    return { ok: true, detail: `${Date.now() - start}ms` };
  } catch (err) {
    return { ok: false, detail: err.message.slice(0, 100) };
  }
}

async function checkQStash() {
  if (!CONFIG.QSTASH_TOKEN) return { ok: false, detail: 'Tidak dikonfigurasi' };
  try {
    const start = Date.now();
    const res = await fetch(`${CONFIG.QSTASH_URL}/v2/messages`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${CONFIG.QSTASH_TOKEN}` },
    });
    // 200 atau 404 (endpoint list kosong/beda bentuk) sama-sama berarti
    // token & endpoint valid dan bisa diajak komunikasi.
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `Auth gagal (${res.status})` };
    }
    return { ok: true, detail: `${Date.now() - start}ms` };
  } catch (err) {
    return { ok: false, detail: err.message.slice(0, 100) };
  }
}

async function checkAiGateway() {
  if (!CONFIG.VERCEL_PROXY_URL) return { ok: false, detail: 'Tidak dikonfigurasi' };
  try {
    const start = Date.now();
    // HEAD/GET ringan ke root gateway — cuma cek gateway hidup & merespon,
    // BUKAN kirim chat completion (supaya tidak makan token/kuota AI).
    const res = await fetch(CONFIG.VERCEL_PROXY_URL, { method: 'GET' });
    const elapsed = Date.now() - start;
    // Gateway biasanya balas 404/405 untuk GET ke root (bukan endpoint
    // chat), itu tetap tanda gateway HIDUP — bukan gateway down.
    if (res.status >= 500) {
      return { ok: false, detail: `Server error (${res.status})` };
    }
    return { ok: true, detail: `${elapsed}ms (HTTP ${res.status})` };
  } catch (err) {
    return { ok: false, detail: err.message.slice(0, 100) };
  }
}

async function buildStatusEmbed() {
  const [redisResult, qstashResult, gatewayResult] = await Promise.all([
    checkRedis(),
    checkQStash(),
    checkAiGateway(),
  ]);

  const maintenanceOn = await isMaintenanceMode().catch(() => false);
  const statusLine = (label, result) => `${result.ok ? '✅' : '❌'} **${label}** — ${result.detail}`;

  return {
    embeds: [
      {
        title: '🩺 Bot Status',
        color: redisResult.ok && qstashResult.ok && gatewayResult.ok ? 0x57f287 : 0xed4245,
        description: [
          statusLine('Redis', redisResult),
          statusLine('QStash', qstashResult),
          statusLine('AI Gateway', gatewayResult),
          '',
          `🛠️ Maintenance mode: **${maintenanceOn ? 'ON' : 'OFF'}**`,
        ].join('\n'),
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/**
 * queueStatus — dipanggil dari api/index.js. /status butuh 3 network
 * call (Redis, QStash, gateway AI) yang totalnya bisa >3 detik, jadi
 * TIDAK dijawab Type 4 instan seperti command owner lain — job dilempar
 * ke QStash (konsisten dengan pola /tanya), lalu balas deferred.
 */
async function queueStatus(interaction, res) {
  if (!isOwner(interaction)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❌ Command ini khusus Owner.' },
    });
    return;
  }

  try {
    await publishStatusJob({ token: interaction.token });
  } catch (err) {
    console.error('[queueStatus] Failed to publish QStash job:', err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal menjadwalkan pengecekan status. Coba lagi beberapa saat ya 🙏' },
    });
    return;
  }

  res.status(200).json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
}

/**
 * processStatusJob — dipanggil dari api/process-status.js, SAAT QStash
 * mem-POST balik job status. PATCH hasil ke @original.
 */
async function processStatusJob({ token }) {
  try {
    const data = await buildStatusEmbed();
    await editOriginalInteractionResponse(token, data);
  } catch (err) {
    console.error('[processStatusJob] Error:', err.message);
    await editOriginalInteractionResponse(token, {
      content: '⚠️ Gagal mengambil status. Coba lagi beberapa saat ya 🙏',
    }).catch(() => {});
  }
}

module.exports = { queueStatus, processStatusJob };
