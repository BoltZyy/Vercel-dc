const { augmentResponse } = require('../lib/resHelper');
'use strict';

const { verifyAndParseQStashRequest } = require('../lib/qstashVerify');
const { getAuction, closeAuction } = require('../lib/auctionEngine');
const { publishJob } = require('../lib/qstash');
const { sendChannelMessage } = require('../lib/discordApi');
const { CONFIG } = require('../lib/config');
const { logErrorToChannel } = require('../lib/errorLog');
const { getShopItem } = require('../lib/shopItems');

/* =========================================================================
 * /api/process-auction-close — job QStash yang menutup lelang.
 *
 * ANTI-SNIPE OPSI B (Time Re-validation, TANPA QStash cancel API):
 * Job ini dijadwalkan SEKALI SAJA saat lelang dibuka (/auction-sell)
 * dengan delay = durasi awal. Kalau ada bid masuk di 2 menit terakhir
 * (anti-snipe trigger), auctionEngine.placeBid() HANYA mengupdate
 * `endsAt` di Redis — TIDAK membuat job baru.
 *
 * Jadi saat job INI benar-benar jalan, dia WAJIB membaca ulang endsAt
 * TERBARU dari Redis dulu:
 *   - Kalau now >= endsAt (tidak ada snipe, atau snipe sudah lewat
 *     waktunya) -> TUTUP lelang sungguhan.
 *   - Kalau now < endsAt (masih ada sisa waktu karena snipe terjadi
 *     setelah job ini dijadwalkan) -> job ini MENJADWALKAN ULANG
 *     DIRINYA SENDIRI dengan delay = sisa waktu, lalu keluar TANPA
 *     menutup apa pun. Cuma SATU job "aktif" berjalan-ulang pada satu
 *     waktu — tidak ada job menumpuk.
 *
 * ERROR HANDLING KOMPREHENSIF: setiap tahap (baca auction, reschedule,
 * closeAuction, notifikasi Discord) dibungkus try/catch TERPISAH dengan
 * log yang menyebutkan auctionId + tahap persis — sesuai permintaan
 * eksplisit untuk Bagian #6, supaya kalau ada error di production,
 * gampang dilacak.
 * ========================================================================= */

module.exports.config = {
  api: {
    bodyParser: false,
  },
};

module.exports = async (req, res) => {
  augmentResponse(res);
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const verified = await verifyAndParseQStashRequest(req, 'process-auction-close');
  if (!verified.ok) {
    res.status(verified.status).json({ error: verified.error });
    return;
  }

  const { auctionId } = verified.payload || {};
  if (!auctionId) {
    res.status(400).json({ error: 'Missing auctionId in job payload' });
    return;
  }

  // --- TAHAP 1: baca ulang state lelang terbaru ---
  let auction;
  try {
    auction = await getAuction(auctionId);
  } catch (err) {
    console.error(`[process-auction-close] TAHAP 1 (baca auction) GAGAL untuk ${auctionId}:`, err.message);
    await logErrorToChannel({ source: 'process-auction-close:read', message: `Gagal baca lelang ${auctionId}: ${err.message}` }).catch(() => {});
    res.status(500).json({ error: 'Failed to read auction state' });
    return;
  }

  if (!auction) {
    // Lelang sudah tidak ada — kemungkinan besar SUDAH DITUTUP oleh job
    // sebelumnya (retry QStash, atau race jarang terjadi). Ini BUKAN
    // error, cukup log info dan keluar dengan aman.
    console.log(`[process-auction-close] Lelang ${auctionId} tidak ditemukan — sudah ditutup sebelumnya, tidak ada yang perlu dilakukan.`);
    res.status(200).json({ ok: true, alreadyClosed: true });
    return;
  }

  // --- TAHAP 2: cek apakah masih ada sisa waktu (anti-snipe Opsi B) ---
  const now = Date.now();
  if (now < auction.endsAt) {
    const remainingMs = auction.endsAt - now;
    const remainingSeconds = Math.ceil(remainingMs / 1000);

    try {
      await publishJob({
        endpointPath: '/api/process-auction-close',
        payload: { auctionId },
        delaySeconds: remainingSeconds,
      });
      console.log(`[process-auction-close] Lelang ${auctionId} kena snipe — reschedule diri sendiri, sisa ${remainingSeconds} detik.`);
      res.status(200).json({ ok: true, rescheduled: true, remainingSeconds });
      return;
    } catch (err) {
      // GAGAL reschedule itu SERIUS — lelang bisa menggantung selamanya
      // (endsAt sudah diperpanjang tapi tidak ada job baru yang akan
      // menutupnya). Log sekeras mungkin untuk intervensi manual.
      console.error(`[process-auction-close] TAHAP 2 (reschedule anti-snipe) GAGAL untuk ${auctionId} — LELANG BERISIKO MENGGANTUNG, PERLU INTERVENSI MANUAL (/auction-admin atau reschedule manual):`, err.message);
      await logErrorToChannel({ source: 'process-auction-close:reschedule', message: `GAGAL reschedule lelang ${auctionId} — berisiko menggantung. ${err.message}` }).catch(() => {});
      res.status(500).json({ error: 'Failed to reschedule auction close job' });
      return;
    }
  }

  // --- TAHAP 3: benar-benar tutup lelang ---
  let closeResult;
  try {
    closeResult = await closeAuction(auctionId);
  } catch (err) {
    console.error(`[process-auction-close] TAHAP 3 (closeAuction) GAGAL untuk ${auctionId}:`, err.message);
    await logErrorToChannel({ source: 'process-auction-close:close', message: `Gagal menutup lelang ${auctionId}: ${err.message}` }).catch(() => {});
    res.status(500).json({ error: 'Failed to close auction' });
    return;
  }

  if (!closeResult.ok) {
    console.error(`[process-auction-close] closeAuction mengembalikan ok:false untuk ${auctionId}:`, closeResult.error);
    res.status(200).json({ ok: true, closeFailed: true, reason: closeResult.error });
    return;
  }

  // --- TAHAP 4: notifikasi hasil ke channel (best-effort, TIDAK fatal) ---
  try {
    if (CONFIG.MARKET_ANNOUNCEMENT_CHANNEL_ID || CONFIG.LOG_CHANNEL_ID) {
      const channelId = CONFIG.MARKET_ANNOUNCEMENT_CHANNEL_ID || CONFIG.LOG_CHANNEL_ID;
      const itemDef = closeResult.itemDef || getShopItem(closeResult.auction?.itemId);
      const itemName = itemDef?.name || closeResult.auction?.itemId || 'Item';

      const content = closeResult.outcome === 'sold'
        ? `🔨 **Lelang Selesai!** ${itemName} terjual 💵 ${closeResult.finalBid?.toLocaleString('id-ID')} ZYC ke <@${closeResult.winnerId}>.`
        : `🔨 **Lelang Berakhir Tanpa Penawar.** ${itemName} dikembalikan ke penjual.`;

      await sendChannelMessage(channelId, { content });
    }
  } catch (err) {
    // Notifikasi gagal TIDAK BOLEH membuat job ini dianggap gagal —
    // lelang SUDAH SELESAI dengan benar di tahap 3, ini cuma pesan
    // pengumuman yang best-effort.
    console.error(`[process-auction-close] TAHAP 4 (notifikasi channel) GAGAL untuk ${auctionId} (non-fatal, lelang tetap sudah ditutup dengan benar):`, err.message);
  }

  res.status(200).json({ ok: true, outcome: closeResult.outcome });
};
