'use strict';

const { Receiver } = require('@upstash/qstash');
const { CONFIG } = require('../lib/config');
const { processTanyaJob } = require('../lib/commands');

/* =========================================================================
 * /api/process-ai — dipanggil QStash (bukan Discord langsung).
 *
 * Ini request HTTP independen yang terpisah total dari request pertama
 * Discord -> /api. Karena request ini "hidup" untuk melayani dirinya
 * sendiri, kita bisa dengan aman `await` proses AI yang lama tanpa
 * takut function dibekukan sebelum tuntas — beda dengan kalau kita coba
 * lanjut proses di background setelah response Discord awal terkirim.
 *
 * WAJIB verifikasi signature QStash di sini, supaya endpoint ini tidak
 * bisa dipanggil sembarang orang untuk memicu pemrosesan AI/biaya API
 * tanpa izin.
 * ========================================================================= */

module.exports.config = {
  api: {
    bodyParser: false,
  },
};

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers['upstash-signature'];

  if (!signature) {
    res.status(401).json({ error: 'Missing QStash signature' });
    return;
  }

  let isValid = false;
  try {
    isValid = await getReceiver().verify({
      signature,
      body: rawBody.toString('utf8'),
    });
  } catch (err) {
    console.error('[process-ai] Signature verification error:', err.message);
    res.status(401).json({ error: 'Invalid QStash signature' });
    return;
  }

  if (!isValid) {
    res.status(401).json({ error: 'Invalid QStash signature' });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  const { token, channelId, userMessage, isOwner } = payload || {};

  if (!token || !userMessage) {
    res.status(400).json({ error: 'Missing required job fields' });
    return;
  }

  // Proses AI sepenuhnya di-await di sini — request ini independen,
  // aman untuk berjalan sampai tuntas sebelum response dikirim.
  try {
    await processTanyaJob({ token, channelId, userMessage, isOwner });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[process-ai] Unhandled error:', err);
    res.status(500).json({ error: 'Processing failed' });
  }
};
