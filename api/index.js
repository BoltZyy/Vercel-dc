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
const { handleRate } = require('../lib/commands/rate');
const { handleShip } = require('../lib/commands/ship');
const { handleTimezoneConvert } = require('../lib/commands/timezone');
const { handlePersonality } = require('../lib/commands/personality');
const { handleWarn } = require('../lib/commands/warn');
const { handleAuditLog } = require('../lib/commands/auditLog');
const { handleRetryButton } = require('../lib/commands/retryHandler');
const { handlePortfolio } = require('../lib/commands/trading/portfolio');
const { handleMarket, handleMarketEvent, handleMarketSetPrice } = require('../lib/commands/trading/market');
const { handleBuy, handleSell } = require('../lib/commands/trading/buysell');
const { handlePosisi } = require('../lib/commands/trading/posisi');
const { handlePinjam, handleBayarUtang, handleDebt, handleDebtApprove } = require('../lib/commands/trading/debt');
const { handleGrant } = require('../lib/commands/trading/grant');
const {
  handleTradeAddItem,
  handleTradeRequestItem,
  handleTradeClear,
  handleTradeSend,
  handleTradeAccept,
  handleTradeReject,
} = require('../lib/commands/trading/trade');
const { logErrorToChannel } = require('../lib/errorLog');

// Command yang butuh panggil AI (dirate-limit, dilempar ke QStash).
// /rate dimasukkan walau punya mode:random gratis, karena mode:ai bisa
// dipilih user kapan saja — rate-limit dicek berdasarkan NAMA command
// (sebelum tahu mode apa yang dipilih), jadi /rate mode:random pun ikut
// mengurangi kuota walau sebenarnya instan/gratis. Ini trade-off yang
// disengaja demi konsistensi & kesederhanaan (bukan bug).
const AI_COMMANDS = new Set(['tanya', 'translate', 'ringkas', 'rate']);

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
        console.log('[RawBody] path=buffer');
        resolve(req.body);
        return;
      }
      if (typeof req.body === 'string') {
        console.log('[RawBody] path=string');
        resolve(Buffer.from(req.body, 'utf8'));
        return;
      }
      // PENTING: kalau body sudah ter-parse jadi OBJECT (bodyParser masih
      // aktif di layer lain meski sudah di-set false), JANGAN re-serialize
      // dengan JSON.stringify — urutan key dan whitespace hasil stringify
      // BISA BEDA dari raw bytes asli yang di-sign Discord, dan verifyKey
      // akan SELALU gagal walau isi datanya "sama". Ini DICURIGAI jadi
      // penyebab signature invalid untuk command dengan struktur options
      // tertentu (payload memicu Vercel mem-parse body duluan sebelum kode
      // kita sempat baca raw stream). Log ini akan MEMBUKTIKAN atau
      // MEMATAHKAN dugaan itu — cek Vercel Logs setelah reproduksi bug.
      console.error(
        '[RawBody] path=object-FALLBACK-UNSAFE — body sudah ter-parse jadi object, verifikasi signature KEMUNGKINAN BESAR akan gagal. Keys:',
        Object.keys(req.body || {})
      );
      resolve(Buffer.from(JSON.stringify(req.body), 'utf8'));
      return;
    }

    // Kasus (a): baca langsung dari stream
    console.log('[RawBody] path=stream');
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
        case 'rate':
          await handleRate(interaction, res);
          return;
        case 'ship':
          await handleShip(interaction, res);
          return;
        case 'timezone':
          await handleTimezoneConvert(interaction, res);
          return;
        case 'personality':
          await handlePersonality(interaction, res);
          return;
        case 'warn':
          await handleWarn(interaction, res);
          return;
        case 'audit-log':
          await handleAuditLog(interaction, res);
          return;
        case 'portfolio':
          await handlePortfolio(interaction, res);
          return;
        case 'market':
          await handleMarket(interaction, res);
          return;
        case 'market-event':
          await handleMarketEvent(interaction, res);
          return;
        case 'market-set-price':
          await handleMarketSetPrice(interaction, res);
          return;
        case 'buy':
          await handleBuy(interaction, res);
          return;
        case 'sell':
          await handleSell(interaction, res);
          return;
        case 'posisi':
          await handlePosisi(interaction, res);
          return;
        case 'pinjam':
          await handlePinjam(interaction, res);
          return;
        case 'bayar-utang':
          await handleBayarUtang(interaction, res);
          return;
        case 'debt':
          await handleDebt(interaction, res);
          return;
        case 'debt-approve':
          await handleDebtApprove(interaction, res);
          return;
        case 'grant':
          await handleGrant(interaction, res);
          return;
        case 'trade-add-item':
          await handleTradeAddItem(interaction, res);
          return;
        case 'trade-request-item':
          await handleTradeRequestItem(interaction, res);
          return;
        case 'trade-clear':
          await handleTradeClear(interaction, res);
          return;
        case 'trade-send':
          await handleTradeSend(interaction, res);
          return;
        case 'trade-accept':
          await handleTradeAccept(interaction, res);
          return;
        case 'trade-reject':
          await handleTradeReject(interaction, res);
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

  // --- 4. Message component (tombol, dll) — khusus Retry button ---
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.data?.custom_id || '';
    if (customId.startsWith('retry:')) {
      try {
        await handleRetryButton(interaction, res);
      } catch (err) {
        console.error('[Dispatch] Unhandled error in retry button:', err);
        res.status(200).json({ type: 6 }); // DEFERRED_UPDATE_MESSAGE, aman minimal
      }
      return;
    }
    // custom_id tidak dikenali -> abaikan dengan aman.
    res.status(200).json({ type: 6 });
    return;
  }

  // --- Interaction type lain (modal, dll) — tidak dipakai ---
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
