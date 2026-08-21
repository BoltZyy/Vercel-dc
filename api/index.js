'use strict';

const { verifyKey, InteractionType, InteractionResponseType } = require('discord-interactions');
const { CONFIG } = require('../lib/config');
const { isMaintenanceMode, isUserBlocked } = require('../lib/redis');
const { checkRateLimit } = require('../lib/ratelimit');
const { getInvokerId, isOwner: checkIsOwner } = require('../lib/permissions');
const { handleAvatar } = require('../lib/commands/avatar');
const { handleUserinfo } = require('../lib/commands/userinfo');
const { handlePing } = require('../lib/commands/ping');
const { handleSay } = require('../lib/commands/say');
const {
  handleBlock,
  handleUnblock,
  handleBlocklist,
  handleMaintenance,
  handleReset,
} = require('../lib/commands/moderation');
const { publishAiJob } = require('../lib/qstash');
const { queueTranslate, queueRingkas } = require('../lib/commands/aiJobs');
const { handleModel } = require('../lib/commands/model');
const { handleRiwayat } = require('../lib/commands/riwayat');
const { handleStats } = require('../lib/commands/stats');
const { queueStatus } = require('../lib/commands/status');
const { handleCoinflip, handleRoll } = require('../lib/commands/fun');
const { handleLeaderboard } = require('../lib/commands/leaderboard');
const { handleRemind } = require('../lib/commands/remind');
const { queueExport } = require('../lib/commands/exportChat');
const { logErrorToChannel } = require('../lib/errorLog');

// Command yang butuh panggil AI (dirate-limit, dilempar ke QStash).
const AI_COMMANDS = new Set(['tanya', 'translate', 'ringkas']);

/* =========================================================================
 * VERCEL SERVERLESS — Discord HTTP Interactions Endpoint
 *
 * ARSITEKTUR (v2 — QStash-based, menggantikan pola "kerja di background
 * setelah response" yang TERBUKTI TIDAK RELIABLE di Vercel Node Functions):
 * 1. Verifikasi signature (Ed25519) dari header Discord — WAJIB sebelum
 *    parse body apapun, atau Discord akan menolak endpoint saat setup.
 * 2. PING -> PONG (health check dari Discord saat register endpoint URL).
 * 3. APPLICATION_COMMAND:
 *    - Semua kerja (cek maintenance, cek blocklist, publish job ke QStash
 *      untuk /tanya) DITUNTASKAN dulu, baru SETELAH ITU response dikirim
 *      sebagai statement TERAKHIR — tidak ada kerja apa pun sesudahnya.
 *    - /model dijawab langsung (Type 4) karena instan, tidak perlu AI.
 *    - /tanya: publish job ke QStash (cepat), lalu balas deferred (Type 5).
 *      Pemrosesan AI yang sesungguhnya terjadi di /api/process-ai, yaitu
 *      REQUEST HTTP BARU yang independen dipicu oleh QStash — bukan kerja
 *      lanjutan di function ini. Ini menghindari ketergantungan pada
 *      asumsi "function tetap hidup setelah response terkirim", yang
 *      TERBUKTI GAGAL (gejala: Discord "thinking..." lalu "did not
 *      respond" setelah >5 menit, tanpa log lanjutan sama sekali).
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
    (await verifyKey(rawBody, signature, timestamp, CONFIG.DISCORD_PUBLIC_KEY));

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
    const invokerId = getInvokerId(interaction);
    const receivedAt = Date.now();

    // PENTING: semua kerja berikut dituntaskan SEBELUM response dikirim ke
    // Discord — bukan sesudahnya. Vercel Node function TIDAK menjamin kerja
    // async lanjut berjalan setelah res.json() terkirim (terbukti lewat
    // kasus "thinking... / did not respond" sebelumnya), jadi kita hindari
    // pola itu sepenuhnya di sini.
    //
    // - Command di INSTANT_COMMANDS tidak panggil AI -> aman dieksekusi
    //   penuh di sini, langsung balas hasil final (Type 4).
    // - Command di AI_COMMANDS (tanya/translate/ringkas) butuh panggil AI
    //   (lama) -> kita HANYA publish job ke QStash di sini (operasi cepat,
    //   <1 detik), baru setelah publish sukses kita kirim deferred (Type 5).
    //   QStash yang nanti memproses AI lewat request terpisah & independen
    //   ke /api/process-ai.

    try {
      // --- Emergency Maintenance Switch (Redis key: MAINTENANCE_MODE) ---
      const maintenanceOn = await isMaintenanceMode();
      if (maintenanceOn && invokerId !== CONFIG.OWNER_ID) {
        res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '🛠️ Bot sedang dalam mode maintenance. Coba lagi beberapa saat ya.' },
        });
        return;
      }

      // --- Blocklist gate (Redis key: blocklist:{userId}) ---
      if (invokerId && (await isUserBlocked(invokerId))) {
        res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '🚫 Kamu diblokir dari fitur ini.' },
        });
        return;
      }

      // --- Rate limit khusus command yang panggil AI (bukan Owner) ---
      if (AI_COMMANDS.has(commandName) && invokerId && !checkIsOwner(interaction)) {
        const rl = await checkRateLimit(invokerId);
        if (!rl.success) {
          res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `⏳ Kamu terlalu sering pakai command ini. Coba lagi dalam ${rl.resetInSeconds} detik ya.`,
            },
          });
          return;
        }
      }

      // --- Dispatch ke handler masing-masing ---
      switch (commandName) {
        case 'model':
          await handleModel(interaction, res);
          return;
        case 'avatar':
          await handleAvatar(interaction, res);
          return;
        case 'userinfo':
          await handleUserinfo(interaction, res);
          return;
        case 'ping':
          await handlePing(interaction, res, receivedAt);
          return;
        case 'say':
          await handleSay(interaction, res);
          return;
        case 'block':
          await handleBlock(interaction, res);
          return;
        case 'unblock':
          await handleUnblock(interaction, res);
          return;
        case 'blocklist':
          await handleBlocklist(interaction, res);
          return;
        case 'maintenance':
          await handleMaintenance(interaction, res);
          return;
        case 'reset':
          await handleReset(interaction, res);
          return;
        case 'riwayat':
          await handleRiwayat(interaction, res);
          return;
        case 'stats':
          await handleStats(interaction, res);
          return;
        case 'status':
          await queueStatus(interaction, res);
          return;
        case 'translate':
          await queueTranslate(interaction, res);
          return;
        case 'ringkas':
          await queueRingkas(interaction, res);
          return;
        case 'tanya':
          await dispatchTanya(interaction, res, invokerId);
          return;
        case 'coinflip':
          await handleCoinflip(interaction, res);
          return;
        case 'roll':
          await handleRoll(interaction, res);
          return;
        case 'leaderboard':
          await handleLeaderboard(interaction, res);
          return;
        case 'remind':
          await handleRemind(interaction, res);
          return;
        case 'export':
          await queueExport(interaction, res);
          return;
        default:
          console.warn(`[Dispatch] Unknown command: ${commandName}`);
          res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: '❓ Command tidak dikenali.' },
          });
          return;
      }
    } catch (err) {
      console.error(`[Dispatch] Unhandled error for command "${commandName}":`, err);
      await logErrorToChannel({
        source: `api/index.js:${commandName}`,
        message: err.message,
        userId: invokerId,
        channelId: interaction.channel_id,
      });
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '⚠️ Terjadi kesalahan internal. Coba lagi beberapa saat ya 🙏' },
      });
      return;
    }
  }

  // --- Interaction type lain (message component, modal, dll) — tidak dipakai ---
  res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
};

/**
 * dispatchTanya — /tanya: publish job ke QStash (chat bebas dengan
 * conversation history), lalu balas deferred. Beda dari /translate dan
 * /ringkas (yang tidak pakai history) — ditangani terpisah karena butuh
 * baca opsi "pesan"/"mode" dan validasi kosong yang sedikit berbeda.
 */
async function dispatchTanya(interaction, res, invokerId) {
  const options = interaction.data?.options || [];
  const pesanOpt = options.find((o) => o.name === 'pesan');
  const modeOpt = options.find((o) => o.name === 'mode');
  const userMessage = (pesanOpt?.value || '').trim();
  const mode = modeOpt?.value || null; // 'singkat' | 'detail' | 'kreatif' | null

  if (!userMessage) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'Halo! Tulis pertanyaanmu setelah `/tanya` ya 🙂' },
    });
    return;
  }

  const isOwnerFlag = invokerId === CONFIG.OWNER_ID;

  try {
    await publishAiJob({
      token: interaction.token,
      channelId: interaction.channel_id,
      userId: invokerId,
      userMessage,
      isOwner: isOwnerFlag,
      jobType: 'tanya',
      extra: { mode },
    });
  } catch (err) {
    console.error('[dispatchTanya] Failed to publish QStash job:', err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal menjadwalkan proses AI. Coba lagi beberapa saat ya 🙏' },
    });
    return;
  }

  // Job berhasil dipublish -> baru sekarang kirim deferred.
  // QStash akan memanggil /api/process-ai secara independen untuk
  // menuntaskan hasil lewat PATCH @original.
  res.status(200).json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
}
