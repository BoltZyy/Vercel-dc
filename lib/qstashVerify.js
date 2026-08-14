'use strict';

const { Receiver } = require('@upstash/qstash');
const { CONFIG } = require('./config');

/* =========================================================================
 * Shared helper untuk semua endpoint /api/process-* yang dipanggil balik
 * oleh QStash (bukan Discord langsung). Dipakai bareng oleh
 * api/process-ai.js dan api/process-status.js supaya logic raw-body-read
 * dan signature verification tidak terduplikasi di tiap endpoint baru.
 * ========================================================================= */

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined && req.body !== null) {
      if (Buffer.isBuffer(req.body)) {
        resolve(req.body);
        return;
      }
      if (typeof req.body === 'string') {
        resolve(Buffer.from(req.body, 'utf8'));
        return;
      }
      resolve(Buffer.from(JSON.stringify(req.body), 'utf8'));
      return;
    }
    const chunks = [];
    let settled = false;
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    if (req.readableEnded || req.complete) {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    }
  });
}

let receiver = null;
function getReceiver() {
  if (!receiver) {
    receiver = new Receiver({
      currentSigningKey: CONFIG.QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: CONFIG.QSTASH_NEXT_SIGNING_KEY,
    });
  }
  return receiver;
}

/**
 * verifyAndParseQStashRequest — baca raw body, verifikasi signature
 * QStash, lalu parse JSON. Return { ok: true, payload } kalau valid,
 * atau { ok: false, status, error } kalau gagal di tahap mana pun —
 * pemanggil tinggal cek `ok` dan langsung res.status(status).json(...).
 */
async function verifyAndParseQStashRequest(req, logPrefix) {
  const rawBody = await getRawBody(req);
  const signature = req.headers['upstash-signature'];

  if (!signature) {
    return { ok: false, status: 401, error: 'Missing QStash signature' };
  }

  let isValid = false;
  try {
    isValid = await getReceiver().verify({ signature, body: rawBody.toString('utf8') });
  } catch (err) {
    console.error(`[${logPrefix}] Signature verification error:`, err.message);
    return { ok: false, status: 401, error: 'Invalid QStash signature' };
  }

  if (!isValid) {
    return { ok: false, status: 401, error: 'Invalid QStash signature' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return { ok: false, status: 400, error: 'Invalid JSON body' };
  }

  return { ok: true, payload };
}

module.exports = { getRawBody, getReceiver, verifyAndParseQStashRequest };
