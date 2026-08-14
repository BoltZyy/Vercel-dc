'use strict';

const { Client } = require('@upstash/qstash');
const { CONFIG } = require('./config');

/* =========================================================================
 * QSTASH PUBLISHER
 * Dipakai untuk melempar "job" pemrosesan AI ke endpoint terpisah
 * (/api/process-ai) sebagai request HTTP baru yang independen — supaya
 * tidak bergantung pada function pertama (yang sudah kirim response ke
 * Discord) tetap hidup di background, karena itu TIDAK dijamin oleh
 * Vercel Node.js Serverless Functions.
 * ========================================================================= */

let qstashClient = null;

function getQStash() {
  if (!CONFIG.QSTASH_TOKEN) {
    throw new Error('QSTASH_TOKEN is not configured.');
  }
  if (!qstashClient) {
    qstashClient = new Client({
      token: CONFIG.QSTASH_TOKEN,
      baseUrl: CONFIG.QSTASH_URL,
    });
  }
  return qstashClient;
}

/**
 * publishJob — kirim job apa pun ke QStash, yang akan mem-POST ulang ke
 * endpoint tujuan (relatif terhadap PUBLIC_BASE_URL) sebagai request
 * independen.
 * @param {Object} params
 * @param {string} params.endpointPath - path tujuan, contoh '/api/process-ai'
 * @param {Object} params.payload - data yang dikirim sebagai JSON body
 */
async function publishJob({ endpointPath, payload }) {
  if (!CONFIG.PUBLIC_BASE_URL) {
    throw new Error('PUBLIC_BASE_URL is not configured.');
  }
  const client = getQStash();
  const destinationUrl = `${CONFIG.PUBLIC_BASE_URL}${endpointPath}`;

  return client.publishJSON({
    url: destinationUrl,
    body: payload,
    retries: 2,
  });
}

/**
 * publishAiJob — shortcut publishJob khusus ke /api/process-ai (job AI:
 * tanya/translate/ringkas). Dipertahankan supaya pemanggil lama tidak
 * perlu berubah.
 */
async function publishAiJob(payload) {
  return publishJob({ endpointPath: '/api/process-ai', payload });
}

/**
 * publishStatusJob — shortcut publishJob khusus ke /api/process-status
 * (job /status: cek kesehatan Redis/QStash/gateway AI).
 */
async function publishStatusJob(payload) {
  return publishJob({ endpointPath: '/api/process-status', payload });
}

module.exports = { getQStash, publishJob, publishAiJob, publishStatusJob };
