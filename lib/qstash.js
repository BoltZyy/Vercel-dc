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
    qstashClient = new Client({ token: CONFIG.QSTASH_TOKEN });
  }
  return qstashClient;
}

/**
 * publishAiJob — kirim job pemrosesan AI ke QStash, yang akan
 * mem-POST ulang ke /api/process-ai sebagai request independen.
 * @param {Object} payload - data minimal yang dibutuhkan untuk memproses
 *   command ini nanti (token interaksi, pesan user, command name, dll).
 */
async function publishAiJob(payload) {
  if (!CONFIG.PUBLIC_BASE_URL) {
    throw new Error('PUBLIC_BASE_URL is not configured.');
  }
  const client = getQStash();
  const destinationUrl = `${CONFIG.PUBLIC_BASE_URL}/api/process-ai`;

  return client.publishJSON({
    url: destinationUrl,
    body: payload,
    retries: 2,
  });
}

module.exports = { getQStash, publishAiJob };
