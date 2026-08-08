'use strict';

const { verifyKey, InteractionType, InteractionResponseType } = require('discord-interactions');
const { CONFIG } = require('../lib/config');
const { handleTanya, handleModel } = require('../lib/commands');
const { isMaintenanceMode, isUserBlocked } = require('../lib/redis');
const { editOriginalInteractionResponse } = require('../lib/discordApi');

/* =========================================================================
 * VERCEL SERVERLESS — Discord HTTP Interactions Endpoint
 *
 * ARSITEKTUR:
 * 1. Verifikasi signature (Ed25519) dari header Discord — WAJIB sebelum
 *    parse body apapun, atau Discord akan menolak endpoint saat setup.
 * 2. PING -> PONG (health check dari Discord saat register endpoint URL).
 * 3. APPLICATION_COMMAND -> balas Type 5 (DEFERRED) SEGERA (<3 detik),
 *    lalu jalankan command handler secara async di background via
 *    context.waitUntil-equivalent (lihat runAsync helper di bawah).
 *
 * PENTING: Vercel Node.js serverless functions TIDAK auto-support
 * "waitUntil" seperti Edge/Cloudflare. Untuk memastikan kerja async
 * (call AI + PATCH webhook) benar-benar tuntas walau response utama
 * sudah dikirim, kita AWAIT proses background SEBELUM function exit,
 * tapi response ke Discord sudah dikirim duluan lewat res.send() —
 * function tetap 'hidup' menjalankan promise berikutnya sampai selesai
 * karena kita tidak return dari handler sampai promise itu settle.
 * maxDuration diset 60s di vercel.json untuk memberi ruang cukup.
 * ========================================================================= */

// --- Wajibkan Vercel TIDAK mem-parse body otomatis, agar raw bytes utuh ---
// untuk verifikasi signature Ed25519 (hash harus atas byte asli, bukan
// hasil re-serialize JSON yang bisa beda whitespace/urutan key).
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

// --- Raw body reader ---
// Robust terhadap dua kemungkinan bentuk `req` di Vercel Node runtime:
// (a) stream mentah (Node http.IncomingMessage) -> baca via event 'data'/'end'
// (b) body sudah ter-buffer duluan oleh platform ke req.body (Buffer/string)
//     -> pakai itu langsung, jangan tunggu event stream yang mungkin tidak
//     pernah fire lagi karena sudah dikonsumsi.
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    // Kasus (b): body sudah tersedia langsung (mis. sudah di-buffer platform)
    if (req.body !== undefined && req.body !== null) {
      if (Buffer.isBuffer(req.body)) {
        resolve(req.body);
        return;
      }
      if (typeof req.body === 'string') {
        resolve(Buffer.from(req.body, 'utf8'));
        return;
      }
      // Kalau ternyata sudah ter-parse jadi object (bodyParser masih aktif
      // di layer lain), re-serialize sebagai fallback. Ini best-effort dan
      // BISA gagal verifikasi kalau urutan key berubah — sebisa mungkin
      // hindari lewat config.api.bodyParser=false di atas.
      resolve(Buffer.from(JSON.stringify(req.body), 'utf8'));
      return;
    }

    // Kasus (a): baca langsung dari stream
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

    // Guard: kalau stream sudah 'ended' sebelum listener terpasang
    // (race condition di beberapa runtime), jangan hang selamanya.
    if (req.readableEnded || req.complete) {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    }
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!CONFIG.DISCORD_PUBLIC_KEY) {
    console.error('[Config] DISCORD_PUBLIC_KEY is not set.');
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  // --- 1. Signature verification ---
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const rawBody = await getRawBody(req);

  // Diagnostic log — aman ditinggal permanen (tidak membocorkan payload),
  // hapus baris ini nanti kalau sudah tidak dibutuhkan.
  console.log('[Verify] bodyLength=%d hasSig=%s hasTs=%s', rawBody.length, Boolean(signature), Boolean(timestamp));

  const isValid =
    signature &&
    timestamp &&
    verifyKey(rawBody, signature, timestamp, CONFIG.DISCORD_PUBLIC_KEY);

  console.log('[Verify] isValid=%s', isValid);

  if (!isValid) {
    res.status(401).json({ error: 'Invalid request signature' });
    return;
  }

  let interaction;
  try {
    interaction = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  // --- 2. PING health check ---
  if (interaction.type === InteractionType.PING) {
    res.status(200).json({ type: InteractionResponseType.PONG });
    return;
  }

  // --- 3. Slash command dispatch ---
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const commandName = interaction.data?.name;

    // Kirim deferred response SEGERA supaya Discord tidak timeout (3s limit).
    res.status(200).json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });

    // Jalankan command handler async setelah response terkirim.
    // Function tetap alive sampai promise ini settle (tidak ada early return
    // sebelum ini di module scope, Node/Vercel akan flush response header
    // duluan lalu lanjut proses body function hingga tuntas).
    try {
      const invokerId = interaction.member?.user?.id || interaction.user?.id;

      // --- Emergency Maintenance Switch (Redis key: MAINTENANCE_MODE) ---
      // Owner tetap bisa lewat saat maintenance, supaya bisa cek/matikan sendiri.
      const maintenanceOn = await isMaintenanceMode();
      if (maintenanceOn && invokerId !== CONFIG.OWNER_ID) {
        await editOriginalInteractionResponse(interaction.token, {
          content: '🛠️ Bot sedang dalam mode maintenance. Coba lagi beberapa saat ya.',
        }).catch(() => {});
        return;
      }

      // --- Blocklist gate (Redis key: blocklist:{userId}) ---
      if (invokerId && (await isUserBlocked(invokerId))) {
        await editOriginalInteractionResponse(interaction.token, {
          content: '🚫 Kamu diblokir dari fitur ini.',
        }).catch(() => {});
        return;
      }

      await dispatchCommand(commandName, interaction);
    } catch (err) {
      console.error(`[Dispatch] Unhandled error for command "${commandName}":`, err);
    }
    return;
  }

  // --- Interaction type lain (message component, modal, dll) — tidak dipakai ---
  res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
};

async function dispatchCommand(commandName, interaction) {
  switch (commandName) {
    case 'tanya':
      await handleTanya(interaction);
      break;
    case 'model':
      await handleModel(interaction);
      break;
    default:
      console.warn(`[Dispatch] Unknown command: ${commandName}`);
  }
}
