'use strict';

const { getRedis } = require('./redis');
const { getBalance, adjustBalance, getInventory, consumeInventoryItem, cleanInteger, formatZYC } = require('./trading');
const { getShopItem } = require('./shopItems');

/* =========================================================================
 * AUCTION ENGINE — Official (system, Sabtu malam) & P2P (user-driven).
 * Lihat docs/redis-schema-phase2.md Bagian #6 untuk skema Redis lengkap.
 *
 * ATOMIC BID via Redis Lua/EVAL (D1): validasi + update currentBid/
 * currentBidderId dalam SATU langkah atomik, mencegah race condition dua
 * bid bersamaan di detik-detik terakhir. Ini POLA BARU di proyek ini —
 * semua atomicity sebelumnya cukup pakai HINCRBY native, tapi bid butuh
 * "baca dulu, validasi, baru tulis" yang TIDAK bisa dijamin atomik tanpa
 * Lua kalau dilakukan sebagai beberapa perintah terpisah.
 *
 * ANTI-SNIPE tanpa QStash cancel API (Opsi B — Time Re-validation):
 * TIDAK ada job baru dibuat tiap kali snipe terjadi. Sebagai gantinya,
 * `endsAt` di-update di Redis, dan job penutupan (dijadwalkan SEKALI di
 * awal) akan MEMBACA ULANG endsAt saat dia jalan — kalau ternyata belum
 * waktunya (masih ada sisa waktu karena snipe), job itu men-reschedule
 * DIRINYA SENDIRI dengan delay = sisa waktu, lalu keluar tanpa menutup
 * lelang. Lihat api/process-auction-close.js untuk implementasi ini.
 *
 * ERROR HANDLING: SEMUA fungsi kritis di file ini (bid, buka/tutup
 * lelang) dibungkus try/catch dengan log yang menyebutkan NAMA FUNGSI +
 * auctionId + tahap eksekusi — supaya kalau ada error di production,
 * gampang dilacak persis di mana gagalnya, sesuai permintaan eksplisit
 * untuk Bagian #6 ini.
 * ========================================================================= */

const AUCTION_ANTI_SNIPE_WINDOW_MS = 2 * 60 * 1000; // 2 menit
const AUCTION_ANTI_SNIPE_EXTENSION_MS = 3 * 60 * 1000; // +3 menit
const P2P_LISTING_FEE = 1500;
const P2P_LISTING_FEE_DISCOUNTED = 1000; // buff Syndicate Boss
const P2P_MIN_TAX_RATE = 0.05;
const P2P_MAX_TAX_RATE = 0.10;
const P2P_TAX_RATE_WITH_BUFF = 0.05; // buff Titan Vanguard: selalu 5%, bukan random

function auctionKey(auctionId) {
  return `trading:auction:active:${auctionId}`;
}

function lockedItemsKey(userId) {
  return `trading:auction:locked-items:${userId}`;
}

function generateAuctionId() {
  // Format: timestamp + random suffix — cukup unik untuk kebutuhan ini,
  // tidak perlu UUID library tambahan yang belum ada di package.json.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * getAuction — baca 1 lelang aktif. null kalau tidak ada/sudah ditutup.
 */
async function getAuction(auctionId) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.hgetall(auctionKey(auctionId));
    if (!raw || !raw.itemId) return null;
    return {
      auctionId,
      kind: raw.kind,
      sellerId: raw.sellerId || null,
      itemId: raw.itemId,
      scenario: raw.scenario || null,
      startingPrice: cleanInteger(raw.startingPrice),
      currentBid: cleanInteger(raw.currentBid),
      currentBidderId: raw.currentBidderId || null,
      endsAt: cleanInteger(raw.endsAt),
      taxRate: raw.taxRate ? Number(raw.taxRate) : P2P_MIN_TAX_RATE,
    };
  } catch (err) {
    console.error(`[auctionEngine.getAuction] Gagal baca lelang ${auctionId}:`, err.message);
    return null;
  }
}

/**
 * placeBidAtomic — inti D1. Lua script membaca currentBid, validasi
 * bidAmount > currentBid DAN bidderId beda dari currentBidderId (tidak
 * boleh menaikkan bid sendiri), lalu update dalam SATU operasi atomik.
 *
 * Return dari EVAL (array): [statusCode, oldBid, oldBidderId]
 *   statusCode: 1 = sukses, 0 = bid terlalu rendah, -1 = lelang tidak ada,
 *               -2 = bidder sama dengan bidder saat ini
 *
 * Auto-refund (D2) TIDAK dilakukan di dalam Lua script — Lua script
 * TIDAK BOLEH memanggil fungsi lain (adjustBalance, dst), jadi refund
 * bidder lama dilakukan di JS SETELAH EVAL sukses, memakai oldBidderId
 * dan oldBid yang dikembalikan Lua. Ini aman karena EVAL sendiri sudah
 * memastikan konsistensi currentBid/currentBidderId — refund cuma
 * "efek samping" yang terjadi setelah state inti sudah pasti benar.
 */
async function placeBidAtomic(auctionId, bidderId, bidAmount) {
  const redis = getRedis();
  if (!redis) return { ok: false, error: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' };

  const luaScript = `
    local key = KEYS[1]
    local bidderId = ARGV[1]
    local bidAmount = tonumber(ARGV[2])

    local exists = redis.call('HGET', key, 'itemId')
    if not exists then
      return {-1, 0, ''}
    end

    local currentBid = tonumber(redis.call('HGET', key, 'currentBid') or '0')
    local currentBidderId = redis.call('HGET', key, 'currentBidderId') or ''

    if currentBidderId == bidderId then
      return {-2, currentBid, currentBidderId}
    end

    if bidAmount <= currentBid then
      return {0, currentBid, currentBidderId}
    end

    redis.call('HSET', key, 'currentBid', bidAmount, 'currentBidderId', bidderId)
    return {1, currentBid, currentBidderId}
  `;

  try {
    const result = await redis.eval(luaScript, [auctionKey(auctionId)], [bidderId, String(bidAmount)]);
    const [statusCode, oldBid, oldBidderId] = result;

    if (statusCode === -1) {
      return { ok: false, error: '⚠️ Lelang tidak ditemukan atau sudah berakhir.' };
    }
    if (statusCode === -2) {
      return { ok: false, error: '⚠️ Kamu sudah jadi bidder tertinggi saat ini.' };
    }
    if (statusCode === 0) {
      return { ok: false, error: `⚠️ Bid terlalu rendah. Bid tertinggi saat ini 💵 ${formatZYC(cleanInteger(oldBid))} ZYC.` };
    }

    return { ok: true, oldBid: cleanInteger(oldBid), oldBidderId: oldBidderId || null };
  } catch (err) {
    console.error(`[auctionEngine.placeBidAtomic] EVAL gagal untuk lelang ${auctionId}, bidder ${bidderId}:`, err.message);
    return { ok: false, error: '⚠️ Terjadi kesalahan saat memproses bid. Coba lagi ya 🙏' };
  }
}

/**
 * refundPreviousBidder — kredit balik 100% bid lama ke bidder yang baru
 * saja tersalip (D2, silent tanpa DM). Dipanggil SETELAH placeBidAtomic
 * sukses, cuma kalau ada oldBidderId (lelang belum pernah ada bidder =
 * tidak perlu refund apa pun).
 */
async function refundPreviousBidder(auctionId, oldBidderId, oldBid) {
  if (!oldBidderId || oldBid <= 0) return; // belum ada bidder sebelumnya, tidak ada yang direfund
  try {
    await adjustBalance(oldBidderId, oldBid);
  } catch (err) {
    // Kegagalan refund TIDAK BOLEH menggagalkan bid yang baru saja
    // berhasil (state auction sudah benar di Redis) — tapi WAJIB
    // dicatat sekeras mungkin karena ini berarti ada uang yang
    // "tersangkut", perlu intervensi manual Owner kalau ini terjadi.
    console.error(`[auctionEngine.refundPreviousBidder] GAGAL REFUND untuk lelang ${auctionId}, user ${oldBidderId}, jumlah ${oldBid}. PERLU INTERVENSI MANUAL:`, err.message);
  }
}

/**
 * placeBid — orchestrator lengkap 1 bid: validasi saldo cukup, EVAL
 * atomic, refund bidder lama, DAN cek anti-snipe (update endsAt kalau
 * bid masuk di window 2 menit terakhir).
 */
async function placeBid(auctionId, bidderId, bidAmount) {
  try {
    const auction = await getAuction(auctionId);
    if (!auction) {
      return { ok: false, error: '⚠️ Lelang tidak ditemukan atau sudah berakhir.' };
    }

    const cleanAmount = cleanInteger(bidAmount);
    if (cleanAmount <= 0) {
      return { ok: false, error: '⚠️ Jumlah bid harus lebih dari 0.' };
    }

    const balance = await getBalance(bidderId);
    if (balance === null) {
      return { ok: false, error: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' };
    }
    if (balance < cleanAmount) {
      return { ok: false, error: `⚠️ Saldo tidak cukup. Saldo kamu 💵 ${formatZYC(balance)} ZYC.` };
    }

    // Potong saldo bidder BARU dulu, sebelum EVAL — supaya bid yang
    // "dijanjikan" benar-benar sudah keluar dari saldo cash bidder
    // (uang sedang "ditahan" oleh sistem lelang, konsisten dengan
    // pola shop: taruhan/pembelian keluar duluan, refund terjadi
    // terpisah kalau tersalip).
    await adjustBalance(bidderId, -cleanAmount);

    const bidResult = await placeBidAtomic(auctionId, bidderId, cleanAmount);
    if (!bidResult.ok) {
      // EVAL gagal/ditolak -> kembalikan saldo yang tadi dipotong duluan.
      await adjustBalance(bidderId, cleanAmount);
      return bidResult;
    }

    await refundPreviousBidder(auctionId, bidResult.oldBidderId, bidResult.oldBid);

    // Anti-snipe (D3, Opsi B): kalau bid masuk di window 2 menit
    // terakhir, perpanjang endsAt +3 menit. TIDAK membuat job baru —
    // cukup update Redis, job penutupan yang sudah terjadwal akan
    // membaca ulang endsAt ini saat dia jalan nanti.
    const now = Date.now();
    let newEndsAt = auction.endsAt;
    let wasExtended = false;
    if (auction.endsAt - now <= AUCTION_ANTI_SNIPE_WINDOW_MS) {
      newEndsAt = now + AUCTION_ANTI_SNIPE_EXTENSION_MS;
      const redis = getRedis();
      await redis.hset(auctionKey(auctionId), { endsAt: newEndsAt });
      wasExtended = true;
    }

    return { ok: true, newBid: cleanAmount, previousBidderId: bidResult.oldBidderId, endsAt: newEndsAt, wasExtended };
  } catch (err) {
    console.error(`[auctionEngine.placeBid] Error tak terduga untuk lelang ${auctionId}, bidder ${bidderId}:`, err.message);
    return { ok: false, error: '⚠️ Terjadi kesalahan tak terduga saat memproses bid. Coba lagi ya 🙏' };
  }
}

module.exports = {
  AUCTION_ANTI_SNIPE_WINDOW_MS,
  AUCTION_ANTI_SNIPE_EXTENSION_MS,
  P2P_LISTING_FEE,
  P2P_LISTING_FEE_DISCOUNTED,
  P2P_MIN_TAX_RATE,
  P2P_MAX_TAX_RATE,
  P2P_TAX_RATE_WITH_BUFF,
  auctionKey,
  lockedItemsKey,
  generateAuctionId,
  getAuction,
  placeBidAtomic,
  refundPreviousBidder,
  placeBid,
};
