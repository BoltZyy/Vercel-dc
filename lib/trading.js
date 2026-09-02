'use strict';

const { getRedis } = require('./redis');
const { CONFIG } = require('./config');
const { ASSET_CODES, getAssetDefinition } = require('./tradingAssets');
const { sendChannelMessage } = require('./discordApi');
const { publishJob } = require('./qstash');

/* =========================================================================
 * SISTEM TRADING FIKTIF (ZYC) — inti ekonomi bot: saldo, portofolio,
 * harga aset, pinjaman, order pending, dan event pasar.
 *
 * Struktur Redis:
 *   trading:balance:{userId}         -> number (saldo ZYC)
 *   trading:portfolio:{userId}       -> Hash { assetCode -> quantity }
 *   trading:price:{assetCode}        -> number (harga saat ini)
 *   trading:loan:{userId}            -> JSON { amount, borrowedAt, dueAt } | null
 *   trading:order:{userId}:{asset}   -> JSON { side, quantity, placedAt } | null
 *   trading:event:active             -> JSON { type, targetAssets, direction, magnitude, triggeredAt } | null
 *   trading:baddebt:{userId}         -> number (sisa bad debt menunggu approval Owner) | tidak ada
 * ========================================================================= */

function balanceKey(userId) {
  return `trading:balance:${userId}`;
}

/**
 * getBalance — ambil saldo ZYC user. User baru (belum pernah ada di Redis)
 * otomatis dapat STARTING_BALANCE, dan langsung disimpan saat itu juga.
 */
async function getBalance(userId) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(balanceKey(userId));
    if (raw === null || raw === undefined) {
      await redis.set(balanceKey(userId), CONFIG.STARTING_BALANCE);
      return CONFIG.STARTING_BALANCE;
    }
    return Number(raw);
  } catch (err) {
    console.error('[Trading] getBalance failed:', err.message);
    return null;
  }
}

/**
 * adjustBalance — tambah (delta positif) atau kurangi (delta negatif)
 * saldo user. TIDAK memvalidasi saldo tidak boleh minus di sini —
 * validasi "cukup atau tidak" WAJIB dilakukan pemanggil SEBELUM
 * memanggil ini. Fungsi ini murni operasi tulis.
 */
async function adjustBalance(userId, delta) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  await getBalance(userId); // pastikan key ada dulu (user baru)
  const newBalance = await redis.incrbyfloat(balanceKey(userId), delta);
  return Number(newBalance);
}

function portfolioKey(userId) {
  return `trading:portfolio:${userId}`;
}

/**
 * getPortfolio — ambil semua kepemilikan aset user sebagai object
 * { NORA: 5, VOLT: 0, ... }. Aset yang belum pernah dipegang tetap
 * muncul sebagai 0, supaya konsisten dipakai tanpa cek undefined.
 */
async function getPortfolio(userId) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.hgetall(portfolioKey(userId));
    const result = {};
    for (const code of ASSET_CODES) {
      result[code] = Number(raw?.[code] || 0);
    }
    return result;
  } catch (err) {
    console.error('[Trading] getPortfolio failed:', err.message);
    return null;
  }
}

async function getAssetQuantity(userId, assetCode) {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const raw = await redis.hget(portfolioKey(userId), assetCode.toUpperCase());
    return Number(raw || 0);
  } catch (err) {
    console.error('[Trading] getAssetQuantity failed:', err.message);
    return 0;
  }
}

/**
 * adjustAssetQuantity — tambah/kurangi kepemilikan 1 aset. Sama seperti
 * adjustBalance, TIDAK memvalidasi kecukupan.
 */
async function adjustAssetQuantity(userId, assetCode, delta) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  const code = assetCode.toUpperCase();
  const newQty = await redis.hincrby(portfolioKey(userId), code, delta);
  if (Number(newQty) === 0) {
    await redis.hdel(portfolioKey(userId), code);
  }
  return Number(newQty);
}

function priceKey(assetCode) {
  return `trading:price:${assetCode.toUpperCase()}`;
}

/**
 * getPrice — ambil harga 1 aset saat ini. Aset yang belum pernah punya
 * harga otomatis diinisialisasi ke startingPrice.
 */
async function getPrice(assetCode) {
  const redis = getRedis();
  const def = getAssetDefinition(assetCode);
  if (!def) return null;
  if (!redis) return def.startingPrice;

  try {
    const raw = await redis.get(priceKey(assetCode));
    if (raw === null || raw === undefined) {
      await redis.set(priceKey(assetCode), def.startingPrice);
      return def.startingPrice;
    }
    return Number(raw);
  } catch (err) {
    console.error('[Trading] getPrice failed:', err.message);
    return def.startingPrice;
  }
}

async function getAllPrices() {
  const prices = {};
  for (const code of ASSET_CODES) {
    prices[code] = await getPrice(code);
  }
  return prices;
}

/**
 * setPrice — paksa harga aset ke nilai tertentu. Dipakai
 * /market set-price (Owner) dan internal price update engine.
 */
async function setPrice(assetCode, newPrice) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  const clamped = Math.max(0.01, newPrice);
  await redis.set(priceKey(assetCode), clamped);
  return clamped;
}

/* ---------------------------------------------------------------------- */
/* TRANSAKSI INSTAN (buy / sell di harga sekarang)                        */
/* ---------------------------------------------------------------------- */

/**
 * executeBuy — beli aset instan di harga sekarang. Validasi saldo cukup
 * SEBELUM memotong apa pun. Urutan operasi: cek dulu, baru potong saldo,
 * baru tambah aset — kalau potong saldo berhasil tapi tambah aset gagal
 * (kasus sangat jarang, misal Redis error di tengah), ini TIDAK atomik
 * sempurna (Upstash Redis REST tidak mendukung multi-key transaction
 * penuh dengan rollback), tapi risikonya minim karena kedua operasi
 * sama-sama sederhana dan cepat.
 * @returns {Promise<{ ok: true, newBalance, newQuantity, totalCost } | { ok: false, error }>}
 */
async function executeBuy(userId, assetCode, quantity) {
  const def = getAssetDefinition(assetCode);
  if (!def) return { ok: false, error: 'Aset tidak dikenal.' };
  if (quantity <= 0) return { ok: false, error: 'Jumlah harus lebih dari 0.' };

  const price = await getPrice(assetCode);
  const totalCost = price * quantity;
  const balance = await getBalance(userId);

  if (balance === null) return { ok: false, error: 'Redis tidak dikonfigurasi.' };
  if (balance < totalCost) {
    return { ok: false, error: `Saldo tidak cukup. Butuh 💵 ${totalCost.toLocaleString('id-ID')} ZYC, saldo kamu 💵 ${balance.toLocaleString('id-ID')} ZYC.` };
  }

  const newBalance = await adjustBalance(userId, -totalCost);
  const newQuantity = await adjustAssetQuantity(userId, assetCode, quantity);

  return { ok: true, newBalance, newQuantity, totalCost, price };
}

/**
 * executeSell — jual aset instan di harga sekarang. Validasi kepemilikan
 * cukup SEBELUM memotong apa pun.
 */
async function executeSell(userId, assetCode, quantity) {
  const def = getAssetDefinition(assetCode);
  if (!def) return { ok: false, error: 'Aset tidak dikenal.' };
  if (quantity <= 0) return { ok: false, error: 'Jumlah harus lebih dari 0.' };

  const owned = await getAssetQuantity(userId, assetCode);
  if (owned < quantity) {
    return { ok: false, error: `Kepemilikan tidak cukup. Kamu punya 💰 ${owned} ${assetCode}, mau jual ${quantity}.` };
  }

  const price = await getPrice(assetCode);
  const totalGain = price * quantity;

  const newQuantity = await adjustAssetQuantity(userId, assetCode, -quantity);
  const newBalance = await adjustBalance(userId, totalGain);

  return { ok: true, newBalance, newQuantity, totalGain, price };
}

/* ---------------------------------------------------------------------- */
/* PINJAMAN — bebas nominal, tanpa bunga, tenor tetap (LOAN_DUE_DAYS).     */
/* Nunggak dicek SAAT user pakai command trading apa pun (bukan cron).    */
/* ---------------------------------------------------------------------- */

function loanKey(userId) {
  return `trading:loan:${userId}`;
}

function badDebtKey(userId) {
  return `trading:baddebt:${userId}`;
}

/**
 * getLoan — ambil data pinjaman aktif user, atau null kalau tidak punya
 * pinjaman berjalan.
 */
async function getLoan(userId) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(loanKey(userId));
    return raw || null;
  } catch (err) {
    console.error('[Trading] getLoan failed:', err.message);
    return null;
  }
}

/**
 * borrowMoney — ambil pinjaman baru. Bebas nominal, TIDAK ada limit
 * jumlah, dan TIDAK ada pengecekan "sudah punya pinjaman lama atau
 * belum" — user boleh menambah nominal pinjaman kapan saja (pinjaman
 * baru MENGGANTIKAN data lama, jumlahnya ditambahkan, dueAt di-reset
 * ke tenor penuh dari sekarang).
 */
async function borrowMoney(userId, amount) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  if (amount <= 0) throw new Error('Jumlah pinjaman harus lebih dari 0.');

  const existing = await getLoan(userId);
  const now = Date.now();
  const dueAt = now + CONFIG.LOAN_DUE_DAYS * 24 * 3600 * 1000;
  const newAmount = (existing?.amount || 0) + amount;

  const loanData = { amount: newAmount, borrowedAt: now, dueAt };
  await redis.set(loanKey(userId), loanData);
  await adjustBalance(userId, amount);

  return loanData;
}

/**
 * repayLoan — bayar cicilan/lunasi pinjaman. amount lebih besar dari
 * sisa utang otomatis dipotong pas sisa utang saja (tidak minus).
 * Kalau utang lunas total, key pinjaman dihapus.
 */
async function repayLoan(userId, amount) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  if (amount <= 0) return { ok: false, error: 'Jumlah pembayaran harus lebih dari 0.' };

  const loan = await getLoan(userId);
  if (!loan || loan.amount <= 0) {
    return { ok: false, error: 'Kamu tidak punya utang aktif.' };
  }

  const balance = await getBalance(userId);
  if (balance < amount) {
    return { ok: false, error: `Saldo tidak cukup. Saldo kamu 💵 ${balance.toLocaleString('id-ID')} ZYC.` };
  }

  const actualPayment = Math.min(amount, loan.amount);
  const remaining = loan.amount - actualPayment;

  await adjustBalance(userId, -actualPayment);

  if (remaining <= 0) {
    await redis.del(loanKey(userId));
  } else {
    await redis.set(loanKey(userId), { ...loan, amount: remaining });
  }

  return { ok: true, paid: actualPayment, remaining };
}

/**
 * checkAndHandleOverdueLoan — dipanggil di AWAL setiap command trading
 * (buy/sell/posisi/pinjam/dll). Kalau user punya pinjaman yang sudah
 * lewat tenor (dueAt terlampaui), OTOMATIS sita aset senilai utang:
 * 1. Hitung nilai total portofolio user (di harga sekarang).
 * 2. Kalau nilai aset >= sisa utang -> jual paksa aset secukupnya
 *    (mulai dari aset termahal totalnya dulu, sampai utang lunas),
 *    sisa aset & cash TETAP milik user.
 * 3. Kalau nilai aset TIDAK cukup -> semua aset disita habis, sisa
 *    utang yang belum tertutup dicatat sebagai bad debt (butuh
 *    approval Owner lewat /debt approve untuk dihapus).
 * Fungsi ini best-effort dan aman dipanggil berkali-kali — kalau tidak
 * ada pinjaman/tidak overdue, tidak melakukan apa-apa.
 * @returns {Promise<{ seized: boolean, details?: object }>}
 */
async function checkAndHandleOverdueLoan(userId) {
  const redis = getRedis();
  if (!redis) return { seized: false };

  const loan = await getLoan(userId);
  if (!loan || loan.amount <= 0) return { seized: false };
  if (Date.now() < loan.dueAt) return { seized: false }; // belum jatuh tempo

  // Sudah lewat tenor -> mulai proses sita.
  const portfolio = await getPortfolio(userId);
  const prices = await getAllPrices();

  // Urutkan aset dari nilai total (qty * harga) TERBESAR dulu, supaya
  // sita "menghabiskan" aset paling berharga duluan (mengurangi jumlah
  // aset berbeda yang tersentuh, dibanding jual sedikit-sedikit dari semua).
  const holdings = ASSET_CODES
    .map((code) => ({ code, qty: portfolio[code], price: prices[code], value: portfolio[code] * prices[code] }))
    .filter((h) => h.qty > 0)
    .sort((a, b) => b.value - a.value);

  let remainingDebt = loan.amount;
  const seizedAssets = [];

  for (const holding of holdings) {
    if (remainingDebt <= 0) break;
    // Math.ceil dipakai karena tidak bisa jual pecahan unit — tapi ini
    // berarti valueSeized BISA melebihi remainingDebt (dibulatkan ke
    // atas). Kelebihan itu WAJIB dikembalikan sebagai cash ke user,
    // supaya sita benar-benar "cukup buat nutup utang", bukan lebih.
    const unitsNeeded = Math.min(holding.qty, Math.ceil(remainingDebt / holding.price));
    const valueSeized = unitsNeeded * holding.price;
    const overshoot = Math.max(0, valueSeized - remainingDebt);

    await adjustAssetQuantity(userId, holding.code, -unitsNeeded);
    if (overshoot > 0) {
      await adjustBalance(userId, overshoot);
    }
    seizedAssets.push({ code: holding.code, quantity: unitsNeeded, value: valueSeized, refunded: overshoot });
    remainingDebt -= valueSeized;
  }

  if (remainingDebt <= 0) {
    // Utang lunas dari hasil sita -> hapus pinjaman.
    await redis.del(loanKey(userId));
    return { seized: true, details: { fullyCovered: true, seizedAssets, loanAmount: loan.amount } };
  }

  // Aset tidak cukup -> sisa jadi bad debt, tunggu approval Owner.
  await redis.del(loanKey(userId));
  const existingBadDebt = await redis.get(badDebtKey(userId));
  const totalBadDebt = Number(existingBadDebt || 0) + remainingDebt;
  await redis.set(badDebtKey(userId), totalBadDebt);

  return {
    seized: true,
    details: { fullyCovered: false, seizedAssets, loanAmount: loan.amount, badDebtAmount: totalBadDebt },
  };
}

/**
 * getBadDebt — ambil sisa bad debt user yang menunggu approval Owner.
 */
async function getBadDebt(userId) {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const raw = await redis.get(badDebtKey(userId));
    return Number(raw || 0);
  } catch (err) {
    console.error('[Trading] getBadDebt failed:', err.message);
    return 0;
  }
}

/**
 * approveBadDebtClear — Owner menghapus bad debt user (dianggap "write
 * off"/dihapuskan). Dipakai /debt approve.
 */
async function approveBadDebtClear(userId) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  const amount = await getBadDebt(userId);
  await redis.del(badDebtKey(userId));
  return amount;
}

/* ---------------------------------------------------------------------- */
/* ORDER PENDING ("Ancang-ancang") — dipasang sebelum event, dieksekusi   */
/* saat event terjadi di harga SETELAH event (bukan harga saat dipasang). */
/* 1 order per aset per user — order baru MENGGANTIKAN yang lama untuk    */
/* aset yang sama. Kuantitas dibatasi maxOrderQuantity per aset.          */
/* ---------------------------------------------------------------------- */

function orderKey(userId, assetCode) {
  return `trading:order:${userId}:${assetCode.toUpperCase()}`;
}

// TTL order pending — order otomatis basi kalau tidak pernah dieksekusi
// (misal event batal/tidak jadi terjadi karena alasan apa pun). 10 menit
// cukup jauh dari window normal (event terjadi T+1 menit dari trigger).
const PENDING_ORDER_TTL_SECONDS = 600;

/**
 * placeOrder — pasang order pending buy/sell. Validasi saldo/aset SAAT
 * DIPASANG (bukan jaminan — validasi ulang WAJIB dilakukan lagi saat
 * eksekusi, karena saldo/aset bisa berubah di antara waktu ini dan saat
 * event terjadi). Order baru untuk aset yang sama otomatis menggantikan
 * yang lama (bukan ditambah/ditumpuk).
 * @param {string} side - 'buy' | 'sell'
 */
async function placeOrder(userId, assetCode, side, quantity) {
  const redis = getRedis();
  if (!redis) return { ok: false, error: 'Redis tidak dikonfigurasi.' };

  const def = getAssetDefinition(assetCode);
  if (!def) return { ok: false, error: 'Aset tidak dikenal.' };
  if (side !== 'buy' && side !== 'sell') return { ok: false, error: 'Sisi order harus buy atau sell.' };
  if (quantity <= 0) return { ok: false, error: 'Jumlah harus lebih dari 0.' };
  if (quantity > def.maxOrderQuantity) {
    return { ok: false, error: `Maksimal ${def.maxOrderQuantity} unit per order untuk ${assetCode.toUpperCase()}.` };
  }

  // Validasi kecukupan saat dipasang (estimasi di harga SEKARANG — harga
  // eksekusi nanti BISA BEDA karena event, jadi ini cuma validasi awal,
  // bukan jaminan final).
  const price = await getPrice(assetCode);
  if (side === 'buy') {
    const balance = await getBalance(userId);
    const estimatedCost = price * quantity;
    if (balance < estimatedCost) {
      return { ok: false, error: `Saldo tidak cukup buat estimasi order ini. Estimasi biaya 💵 ${estimatedCost.toLocaleString('id-ID')} ZYC, saldo kamu 💵 ${balance.toLocaleString('id-ID')} ZYC.` };
    }
  } else {
    const owned = await getAssetQuantity(userId, assetCode);
    if (owned < quantity) {
      return { ok: false, error: `Kepemilikan tidak cukup. Kamu punya 💰 ${owned} ${assetCode.toUpperCase()}.` };
    }
  }

  const orderData = { side, quantity, assetCode: assetCode.toUpperCase(), placedAt: Date.now() };
  await redis.set(orderKey(userId, assetCode), orderData, { ex: PENDING_ORDER_TTL_SECONDS });

  return { ok: true, order: orderData };
}

/**
 * cancelOrder — batalkan order pending untuk 1 aset tertentu.
 */
async function cancelOrder(userId, assetCode) {
  const redis = getRedis();
  if (!redis) return { ok: false, error: 'Redis tidak dikonfigurasi.' };
  const existing = await redis.get(orderKey(userId, assetCode));
  if (!existing) return { ok: false, error: 'Kamu tidak punya order pending untuk aset ini.' };
  await redis.del(orderKey(userId, assetCode));
  return { ok: true, cancelledOrder: existing };
}

/**
 * getOrder — ambil order pending user untuk 1 aset, atau null.
 */
async function getOrder(userId, assetCode) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(orderKey(userId, assetCode));
    return raw || null;
  } catch (err) {
    console.error('[Trading] getOrder failed:', err.message);
    return null;
  }
}

/**
 * executeOrderAtEventPrice — dipanggil oleh event processor SAAT event
 * terjadi (T+1 menit dari trigger), untuk 1 user + 1 aset yang punya
 * order pending. Validasi ULANG saldo/aset (bisa sudah berubah sejak
 * order dipasang) — kalau tidak cukup lagi, order dibatalkan (bukan
 * error), sesuai spesifikasi.
 * @returns {Promise<{ executed: boolean, cancelled?: boolean, reason?: string, result?: object }>}
 */
async function executeOrderAtEventPrice(userId, assetCode) {
  const redis = getRedis();
  if (!redis) return { executed: false };

  const order = await getOrder(userId, assetCode);
  if (!order) return { executed: false }; // tidak ada order buat user+aset ini

  // Hapus order dulu SEBELUM eksekusi — supaya kalau ada retry/panggilan
  // ganda karena alasan apa pun, order yang sama tidak dieksekusi 2x.
  await redis.del(orderKey(userId, assetCode));

  const result =
    order.side === 'buy'
      ? await executeBuy(userId, assetCode, order.quantity)
      : await executeSell(userId, assetCode, order.quantity);

  if (!result.ok) {
    return { executed: false, cancelled: true, reason: result.error };
  }

  return { executed: true, result: { ...result, side: order.side, assetCode: order.assetCode } };
}

/* ---------------------------------------------------------------------- */
/* EVENT PASAR — trigger random otomatis ATAU manual Owner. Bisa target   */
/* semua aset atau aset spesifik. Perubahan harga terjadi via QStash      */
/* delay job (T+1 menit dari trigger) — lihat api/process-market-event.js */
/* ---------------------------------------------------------------------- */

const ACTIVE_EVENT_KEY = 'trading:event:active';
const EVENT_TTL_SECONDS = 300; // 5 menit — cukup jauh dari window 1 menit

const EVENT_TYPES = {
  BULLISH: { label: 'Sentimen Bullish', direction: 1 },
  BEARISH: { label: 'Sentimen Bearish', direction: -1 },
};

/**
 * createMarketEvent — buat data event baru (BELUM disimpan sebagai
 * "active" — itu tanggung jawab pemanggil setelah kirim pengumuman).
 * @param {string} type - 'BULLISH' | 'BEARISH'
 * @param {string[]|null} targetAssets - null berarti SEMUA aset kena
 */
function createMarketEvent(type, targetAssets = null) {
  const eventDef = EVENT_TYPES[type];
  if (!eventDef) return null;
  return {
    type,
    label: eventDef.label,
    direction: eventDef.direction,
    targetAssets, // null = semua aset
    triggeredAt: Date.now(),
  };
}

/**
 * setActiveEvent — simpan event yang baru di-trigger sebagai "sedang
 * berlangsung" (dipakai buat referensi, misal ditampilkan di /market).
 * TTL otomatis, tidak perlu dibersihkan manual.
 */
async function setActiveEvent(eventData) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  await redis.set(ACTIVE_EVENT_KEY, eventData, { ex: EVENT_TTL_SECONDS });
}

async function getActiveEvent() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(ACTIVE_EVENT_KEY);
    return raw || null;
  } catch (err) {
    console.error('[Trading] getActiveEvent failed:', err.message);
    return null;
  }
}

/**
 * generateRandomPrediction — prediksi RANDOM INDEPENDEN dari event asli
 * (bisa benar, bisa ngawur total — murni gambling, TIDAK ada hubungan
 * dengan arah/target event yang sebenarnya akan terjadi). Dipakai di
 * pengumuman T-1 menit.
 */
function generateRandomPrediction() {
  const randomAsset = ASSET_CODES[Math.floor(Math.random() * ASSET_CODES.length)];
  const randomDirection = Math.random() < 0.5 ? 'melesat naik 📈' : 'anjlok turun 📉';
  return { asset: randomAsset, text: `${randomAsset} diperkirakan akan ${randomDirection}` };
}

/**
 * applyEventToPrice — hitung harga baru 1 aset setelah kena dampak
 * event. Dipanggil oleh api/process-market-event.js untuk tiap aset
 * yang jadi target event.
 * @param {string} assetCode
 * @param {object} eventData - hasil dari createMarketEvent
 * @param {number} baseMagnitudePercent - besaran dasar pergerakan (0-1),
 *   akan dikalikan eventSensitivity aset tersebut.
 */
async function applyEventToPrice(assetCode, eventData, baseMagnitudePercent) {
  const def = getAssetDefinition(assetCode);
  if (!def) return null;

  const currentPrice = await getPrice(assetCode);
  const magnitude = baseMagnitudePercent * def.eventSensitivity;
  const newPrice = currentPrice * (1 + eventData.direction * magnitude);

  return setPrice(assetCode, newPrice);
}

/**
 * isAssetTargetedByEvent — cek apakah 1 aset kena dampak event tertentu.
 * targetAssets null berarti SEMUA aset kena.
 */
function isAssetTargetedByEvent(assetCode, eventData) {
  if (!eventData.targetAssets) return true; // null = semua aset
  return eventData.targetAssets.includes(assetCode.toUpperCase());
}

/**
 * triggerMarketEventFlow — alur LENGKAP trigger event: simpan sebagai
 * active event, kirim pengumuman T-1 menit (dengan prediksi random
 * independen), lalu publish QStash delay job 60 detik yang nanti benar-
 * benar mengubah harga + eksekusi order pending.
 *
 * Dipakai BERSAMA oleh /market-event (trigger manual Owner) dan
 * process-price-update.js (trigger random otomatis) — supaya kedua jalur
 * itu punya alur & pesan yang identik, tidak ada logic yang ditulis
 * dobel dan berisiko berbeda perilaku secara tidak sengaja.
 * @param {string} type - 'BULLISH' | 'BEARISH'
 * @param {string[]|null} targetAssets
 */
async function triggerMarketEventFlow(type, targetAssets = null) {
  const eventData = createMarketEvent(type, targetAssets);
  if (!eventData) return { ok: false, error: 'Tipe event tidak dikenal.' };

  await setActiveEvent(eventData);

  const prediction = generateRandomPrediction();
  const announcementChannelId = CONFIG.MARKET_ANNOUNCEMENT_CHANNEL_ID || CONFIG.LOG_CHANNEL_ID;

  if (announcementChannelId) {
    await sendChannelMessage(announcementChannelId, {
      embeds: [
        {
          title: '📢 Peringatan Pasar!',
          color: 0xfee75c,
          description: [
            '⚠️ Ada pergerakan besar di pasar, **1 menit lagi**!',
            '',
            `📊 Analis memperkirakan **${prediction.text}**`,
            '_(Catatan: prediksi ini cuma perkiraan liar, bisa benar bisa juga meleset total)_',
            '',
            'Pasang posisi kamu sekarang lewat `/posisi buy` atau `/posisi sell` sebelum terlambat!',
          ].join('\n'),
        },
      ],
    }).catch((err) => console.error('[triggerMarketEventFlow] Failed to send announcement:', err.message));
  }

  try {
    await publishJob({
      endpointPath: '/api/process-market-event',
      payload: { eventData },
      delaySeconds: 60,
    });
  } catch (err) {
    return { ok: false, error: `Gagal menjadwalkan eksekusi event: ${err.message}`, eventData };
  }

  return { ok: true, eventData };
}

/* ---------------------------------------------------------------------- */
/* TRADE ANTAR-USER — keranjang bertahap, 1 aktif per user (global),      */
/* maks 5 item per sisi. User A susun tawaran+permintaan, kirim ke User   */
/* B, User B accept/reject. TIDAK dikunci saat dikirim — divalidasi ulang */
/* saat accept, bisa gagal kalau saldo/aset sudah berubah (sama pola      */
/* dengan order pending /posisi).                                        */
/* ---------------------------------------------------------------------- */

const MAX_ITEMS_PER_SIDE = 5;
const TRADE_TTL_SECONDS = 600; // 10 menit

function cartKey(userId) {
  return `trading:cart:${userId}`;
}

function tradeKey(tradeId) {
  return `trading:trade:${tradeId}`;
}

function generateTradeId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * getCart — ambil keranjang aktif user (belum dikirim). Struktur:
 * { offer: [{type, code?, amount}], request: [{type, code?, amount}] }
 */
async function getCart(userId) {
  const redis = getRedis();
  if (!redis) return { offer: [], request: [] };
  try {
    const raw = await redis.get(cartKey(userId));
    return raw || { offer: [], request: [] };
  } catch (err) {
    console.error('[Trading] getCart failed:', err.message);
    return { offer: [], request: [] };
  }
}

/**
 * addCartItem — tambah 1 item ke sisi 'offer' atau 'request' di keranjang
 * user. Validasi dasar (tipe, kode aset, jumlah, limit 5 item) di sini —
 * TAPI TIDAK cek kecukupan saldo/aset (itu baru dicek saat /trade-send
 * dan saat accept, karena keranjang bisa diisi bertahap sebelum user
 * benar-benar punya cukup, dan bisa berubah di antara waktu itu).
 */
async function addCartItem(userId, side, item) {
  const redis = getRedis();
  if (!redis) return { ok: false, error: 'Redis tidak dikonfigurasi.' };
  if (side !== 'offer' && side !== 'request') return { ok: false, error: 'Sisi tidak valid.' };

  if (item.type === 'asset') {
    if (!getAssetDefinition(item.code)) return { ok: false, error: 'Aset tidak dikenal.' };
  } else if (item.type !== 'cash') {
    return { ok: false, error: 'Tipe item harus cash atau asset.' };
  }
  if (item.amount <= 0) return { ok: false, error: 'Jumlah harus lebih dari 0.' };

  const cart = await getCart(userId);
  if (cart[side].length >= MAX_ITEMS_PER_SIDE) {
    return { ok: false, error: `Maksimal ${MAX_ITEMS_PER_SIDE} item per sisi.` };
  }

  cart[side].push(item);
  await redis.set(cartKey(userId), cart); // tidak ada TTL — keranjang persisten sampai clear/send
  return { ok: true, cart };
}

async function clearCart(userId) {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(cartKey(userId));
}

/**
 * sendTrade — kirim keranjang User A (offer + request) sebagai tawaran
 * resmi ke User B. Keranjang A dikosongkan setelah terkirim. TTL 10
 * menit — expired otomatis kalau tidak direspon.
 */
async function sendTrade(fromUserId, toUserId, channelId) {
  const redis = getRedis();
  if (!redis) return { ok: false, error: 'Redis tidak dikonfigurasi.' };

  const cart = await getCart(fromUserId);
  if (cart.offer.length === 0 && cart.request.length === 0) {
    return { ok: false, error: 'Keranjang kamu kosong. Isi dulu pakai /trade-add-item.' };
  }
  if (fromUserId === toUserId) {
    return { ok: false, error: 'Tidak bisa trade dengan diri sendiri.' };
  }

  // Validasi awal (best-effort) — User A punya cukup buat SEMUA item
  // yang ditawarkan, di saat INI. Validasi ulang WAJIB terjadi lagi saat
  // accept, karena kondisi bisa berubah selama trade menunggu direspon.
  for (const item of cart.offer) {
    if (item.type === 'cash') {
      const balance = await getBalance(fromUserId);
      if (balance < item.amount) {
        return { ok: false, error: `Saldo kamu tidak cukup buat menawarkan 💵 ${item.amount.toLocaleString('id-ID')} ZYC.` };
      }
    } else {
      const owned = await getAssetQuantity(fromUserId, item.code);
      if (owned < item.amount) {
        return { ok: false, error: `Kamu tidak punya cukup ${item.code} buat ditawarkan.` };
      }
    }
  }

  const tradeId = generateTradeId();
  const tradeData = {
    tradeId,
    fromUserId,
    toUserId,
    channelId,
    offer: cart.offer,
    request: cart.request,
    createdAt: Date.now(),
  };

  await redis.set(tradeKey(tradeId), tradeData, { ex: TRADE_TTL_SECONDS });
  await clearCart(fromUserId);

  return { ok: true, trade: tradeData };
}

async function getTrade(tradeId) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(tradeKey(tradeId));
    return raw || null;
  } catch (err) {
    console.error('[Trading] getTrade failed:', err.message);
    return null;
  }
}

/**
 * respondTrade — User B accept atau reject trade. Untuk accept, VALIDASI
 * ULANG kecukupan kedua belah pihak (User A bisa sudah habiskan saldo
 * sejak trade dikirim, User B mungkin tidak cukup buat sisi 'request').
 * Kalau valid, eksekusi SEKALIGUS kedua arah (tidak ada rollback parsial
 * berarti — kalau satu arah gagal di tengah, trade dianggap gagal total
 * SEBELUM transfer apa pun terjadi, karena validasi dilakukan dulu untuk
 * KEDUA arah sebelum eksekusi mana pun dimulai).
 * @param {string} action - 'accept' | 'reject'
 */
async function respondTrade(tradeId, respondingUserId, action) {
  const redis = getRedis();
  if (!redis) return { ok: false, error: 'Redis tidak dikonfigurasi.' };

  const trade = await getTrade(tradeId);
  if (!trade) return { ok: false, error: 'Trade tidak ditemukan atau sudah kedaluwarsa.' };
  if (trade.toUserId !== respondingUserId) {
    return { ok: false, error: 'Trade ini bukan untuk kamu.' };
  }

  if (action === 'reject') {
    await redis.del(tradeKey(tradeId));
    return { ok: true, action: 'rejected', trade };
  }

  // action === 'accept' -> validasi ulang KEDUA arah sebelum eksekusi apa pun.
  for (const item of trade.offer) {
    if (item.type === 'cash') {
      const balance = await getBalance(trade.fromUserId);
      if (balance < item.amount) {
        await redis.del(tradeKey(tradeId));
        return { ok: false, error: `Trade gagal — pengirim tidak lagi punya cukup 💵 ${item.amount.toLocaleString('id-ID')} ZYC.` };
      }
    } else {
      const owned = await getAssetQuantity(trade.fromUserId, item.code);
      if (owned < item.amount) {
        await redis.del(tradeKey(tradeId));
        return { ok: false, error: `Trade gagal — pengirim tidak lagi punya cukup ${item.code}.` };
      }
    }
  }
  for (const item of trade.request) {
    if (item.type === 'cash') {
      const balance = await getBalance(respondingUserId);
      if (balance < item.amount) {
        await redis.del(tradeKey(tradeId));
        return { ok: false, error: `Kamu tidak punya cukup 💵 ${item.amount.toLocaleString('id-ID')} ZYC buat memenuhi permintaan trade ini.` };
      }
    } else {
      const owned = await getAssetQuantity(respondingUserId, item.code);
      if (owned < item.amount) {
        await redis.del(tradeKey(tradeId));
        return { ok: false, error: `Kamu tidak punya cukup ${item.code} buat memenuhi permintaan trade ini.` };
      }
    }
  }

  // Kedua arah valid -> eksekusi transfer. offer: A -> B. request: B -> A.
  for (const item of trade.offer) {
    if (item.type === 'cash') {
      await adjustBalance(trade.fromUserId, -item.amount);
      await adjustBalance(respondingUserId, item.amount);
    } else {
      await adjustAssetQuantity(trade.fromUserId, item.code, -item.amount);
      await adjustAssetQuantity(respondingUserId, item.code, item.amount);
    }
  }
  for (const item of trade.request) {
    if (item.type === 'cash') {
      await adjustBalance(respondingUserId, -item.amount);
      await adjustBalance(trade.fromUserId, item.amount);
    } else {
      await adjustAssetQuantity(respondingUserId, item.code, -item.amount);
      await adjustAssetQuantity(trade.fromUserId, item.code, item.amount);
    }
  }

  await redis.del(tradeKey(tradeId));
  return { ok: true, action: 'accepted', trade };
}

module.exports = {
  getBalance,
  adjustBalance,
  getPortfolio,
  getAssetQuantity,
  adjustAssetQuantity,
  getPrice,
  getAllPrices,
  setPrice,
  executeBuy,
  executeSell,
  getLoan,
  borrowMoney,
  repayLoan,
  checkAndHandleOverdueLoan,
  getBadDebt,
  approveBadDebtClear,
  placeOrder,
  cancelOrder,
  getOrder,
  executeOrderAtEventPrice,
  EVENT_TYPES,
  createMarketEvent,
  setActiveEvent,
  getActiveEvent,
  generateRandomPrediction,
  applyEventToPrice,
  isAssetTargetedByEvent,
  triggerMarketEventFlow,
  MAX_ITEMS_PER_SIDE,
  getCart,
  addCartItem,
  clearCart,
  sendTrade,
  getTrade,
  respondTrade,
};
