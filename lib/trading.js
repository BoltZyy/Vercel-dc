'use strict';

const { getRedis } = require('./redis');
const { CONFIG } = require('./config');
const { ASSET_CODES, getAssetDefinition } = require('./tradingAssets');
const { sendChannelMessage } = require('./discordApi');
const { publishJob } = require('./qstash');

/* =========================================================================
 * SANITIZER & FORMATTER GLOBAL — dipakai di SELURUH sistem trading untuk
 * mencegah floating point drift dan type coercion (String concatenation
 * saat operasi matematika, atau desimal liar akibat incrbyfloat).
 *
 * ATURAN: SALDO ZYC dan JUMLAH UNIT ASET yang dipegang user SELALU
 * integer bulat. HARGA per unit aset TETAP boleh desimal (dibulatkan
 * cuma saat ditampilkan lewat formatZYC), supaya random walk & event
 * pasar tetap presisi secara matematis.
 * ========================================================================= */

/**
 * cleanInteger — paksa nilai apa pun (Number, String berformat, null,
 * undefined) jadi Integer murni.
 *
 * Data yang TERSIMPAN di Redis dijamin selalu format JS native (titik =
 * desimal, TIDAK PERNAH koma ribuan) — jadi koma yang muncul di string
 * SELALU dianggap sampah/corrupt dan dibuang total.
 *
 * Untuk titik: kalau cuma ADA SATU titik dalam string, itu desimal asli
 * (mis. "1000.7" -> 1001 setelah dibulatkan). Kalau ADA LEBIH dari satu
 * titik (mis. user mengetik "1.000.000" ala format ribuan Indonesia di
 * command seperti /grant), semua titik dianggap pemisah ribuan dan
 * dibuang total (mis. "1.000.000" -> 1000000, BUKAN 1).
 */
function cleanInteger(val) {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? Math.round(val) : 0;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    const isNegative = trimmed.startsWith('-');
    // Koma SELALU sampah (data Redis tidak pernah pakai koma ribuan).
    let cleaned = trimmed.replace(/,/g, '').replace(/[^0-9.]/g, '');

    const dotCount = (cleaned.match(/\./g) || []).length;
    if (dotCount > 1) {
      // Lebih dari 1 titik -> format ribuan, buang SEMUA titik.
      cleaned = cleaned.replace(/\./g, '');
    }
    // dotCount === 1 -> biarkan sebagai desimal asli, parseFloat menanganinya.

    const num = cleaned ? parseFloat(cleaned) : 0;
    const rounded = Number.isFinite(num) ? Math.round(num) : 0;
    return isNegative ? -rounded : rounded;
  }
  const num = Number(val);
  return Number.isFinite(num) ? Math.round(num) : 0;
}

/**
 * cleanNumber — sama seperti cleanInteger, TAPI mempertahankan desimal.
 * Dipakai khusus untuk HARGA aset (boleh pecahan), BUKAN untuk saldo/unit.
 */
function cleanNumber(val) {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : 0;
  }
  if (typeof val === 'string') {
    const isNegative = val.trim().startsWith('-');
    const cleaned = val.replace(/[^0-9.]/g, '');
    const num = cleaned ? parseFloat(cleaned) : 0;
    return isNegative && num > 0 ? -num : num;
  }
  const num = Number(val);
  return Number.isFinite(num) ? num : 0;
}

/**
 * formatZYC — bersihkan nilai dengan cleanInteger(), lalu kembalikan
 * String terformat Indonesia TANPA desimal. Dipakai HANYA di tahap akhir
 * saat menyusun teks embed/pesan Discord — kalkulasi matematika di
 * tempat lain harus selalu pakai Number murni dari cleanInteger/cleanNumber.
 */
function formatZYC(val) {
  return cleanInteger(val).toLocaleString('id-ID');
}

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
      const starting = cleanInteger(CONFIG.STARTING_BALANCE);
      await redis.set(balanceKey(userId), starting);
      return starting;
    }
    // cleanInteger() di sini WAJIB — data lama di Redis bisa saja masih
    // berupa desimal liar akibat incrbyfloat sebelum sanitizer ini ada.
    // Baca ulang otomatis membulatkan, tanpa perlu migrasi data manual.
    return cleanInteger(raw);
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
 *
 * delta SELALU dibulatkan ke Integer sebelum dikirim ke Redis — saldo
 * ZYC tidak pernah punya desimal, terlepas dari nilai floating point
 * apa pun yang mungkin dihasilkan kalkulasi sebelumnya (misal price *
 * quantity yang price-nya desimal).
 */
async function adjustBalance(userId, delta) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  await getBalance(userId); // pastikan key ada dulu (user baru), sekaligus BERSIHKAN data lama kalau masih desimal
  const cleanDelta = cleanInteger(delta);
  const newBalance = await redis.incrbyfloat(balanceKey(userId), cleanDelta);
  // incrbyfloat SELALU mengembalikan STRING — WAJIB dibulatkan di sini,
  // jangan pernah dianggap Number langsung tanpa sanitasi (ini akar bug
  // "String concatenation" / saldo melesat minus triliunan sebelumnya).
  const cleaned = cleanInteger(newBalance);
  // Tulis ulang versi bersih kalau ternyata Redis masih simpan representasi
  // desimal (misal "1000.0000000000002" dari floating point drift) — supaya
  // pembacaan BERIKUTNYA langsung dapat nilai bulat tanpa perlu cleanInteger lagi.
  if (String(newBalance) !== String(cleaned)) {
    await redis.set(balanceKey(userId), cleaned);
  }
  return cleaned;
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
      result[code] = cleanInteger(raw?.[code]);
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
    return cleanInteger(raw);
  } catch (err) {
    console.error('[Trading] getAssetQuantity failed:', err.message);
    return 0;
  }
}

/**
 * adjustAssetQuantity — tambah/kurangi kepemilikan 1 aset. Sama seperti
 * adjustBalance, TIDAK memvalidasi kecukupan. delta SELALU dibulatkan ke
 * Integer — kepemilikan aset tidak pernah berupa pecahan unit.
 */
async function adjustAssetQuantity(userId, assetCode, delta) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  const code = assetCode.toUpperCase();
  const cleanDelta = cleanInteger(delta);
  const newQty = await redis.hincrby(portfolioKey(userId), code, cleanDelta);
  const cleaned = cleanInteger(newQty);
  if (cleaned === 0) {
    await redis.hdel(portfolioKey(userId), code);
  }
  return cleaned;
}

function priceKey(assetCode) {
  return `trading:price:${assetCode.toUpperCase()}`;
}

/**
 * getPrice — ambil harga 1 aset saat ini. Aset yang belum pernah punya
 * harga otomatis diinisialisasi ke startingPrice. Harga BOLEH desimal
 * (dipakai cleanNumber, BUKAN cleanInteger) — cuma saldo/unit yang wajib
 * bulat, harga tetap presisi buat kalkulasi random walk & event pasar.
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
    return cleanNumber(raw);
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
 * /market-set-price (Owner) dan internal price update engine. Harga
 * boleh desimal — dibersihkan pakai cleanNumber, bukan dibulatkan.
 */
async function setPrice(assetCode, newPrice) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  const clamped = Math.max(0.01, cleanNumber(newPrice));
  await redis.set(priceKey(assetCode), clamped);
  return clamped;
}

/* ---------------------------------------------------------------------- */
/* TRANSAKSI INSTAN (buy / sell di harga sekarang)                        */
/* ---------------------------------------------------------------------- */

async function executeBuy(userId, assetCode, quantity) {
  const def = getAssetDefinition(assetCode);
  if (!def) return { ok: false, error: 'Aset tidak dikenal.' };
  const qty = cleanInteger(quantity);
  if (qty <= 0) return { ok: false, error: 'Jumlah harus lebih dari 0.' };

  const price = await getPrice(assetCode);
  // totalCost DIBULATKAN di sini — price boleh desimal, tapi nilai yang
  // benar-benar dipotong dari saldo user harus selalu Integer.
  const totalCost = cleanInteger(price * qty);
  const balance = await getBalance(userId);

  if (balance === null) return { ok: false, error: 'Redis tidak dikonfigurasi.' };
  if (balance < totalCost) {
    return { ok: false, error: `Saldo tidak cukup. Butuh 💵 ${formatZYC(totalCost)} ZYC, saldo kamu 💵 ${formatZYC(balance)} ZYC.` };
  }

  const newBalance = await adjustBalance(userId, -totalCost);
  const newQuantity = await adjustAssetQuantity(userId, assetCode, qty);

  return { ok: true, newBalance, newQuantity, totalCost, price };
}

/**
 * executeSell — jual aset instan di harga sekarang. Validasi kepemilikan
 * cukup SEBELUM memotong apa pun.
 */
async function executeSell(userId, assetCode, quantity) {
  const def = getAssetDefinition(assetCode);
  if (!def) return { ok: false, error: 'Aset tidak dikenal.' };
  const qty = cleanInteger(quantity);
  if (qty <= 0) return { ok: false, error: 'Jumlah harus lebih dari 0.' };

  const owned = await getAssetQuantity(userId, assetCode);
  if (owned < qty) {
    return { ok: false, error: `Kepemilikan tidak cukup. Kamu punya 💰 ${owned} ${assetCode}, mau jual ${qty}.` };
  }

  const price = await getPrice(assetCode);
  const totalGain = cleanInteger(price * qty);

  const newQuantity = await adjustAssetQuantity(userId, assetCode, -qty);
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
 * pinjaman berjalan. `amount` di dalam object SELALU dibersihkan dengan
 * cleanInteger() — data lama yang mungkin tersimpan sebagai desimal
 * otomatis dibulatkan saat dibaca ulang.
 */
async function getLoan(userId) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(loanKey(userId));
    if (!raw) return null;
    return { ...raw, amount: cleanInteger(raw.amount) };
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
 * ke tenor penuh dari sekarang). amount SELALU dibulatkan ke Integer.
 */
async function borrowMoney(userId, amount) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  const cleanAmount = cleanInteger(amount);
  if (cleanAmount <= 0) throw new Error('Jumlah pinjaman harus lebih dari 0.');

  const existing = await getLoan(userId);
  const now = Date.now();
  const dueAt = now + CONFIG.LOAN_DUE_DAYS * 24 * 3600 * 1000;
  const newAmount = cleanInteger((existing?.amount || 0) + cleanAmount);

  const loanData = { amount: newAmount, borrowedAt: now, dueAt };
  await redis.set(loanKey(userId), loanData);
  await adjustBalance(userId, cleanAmount);

  return loanData;
}

/**
 * repayLoan — bayar cicilan/lunasi pinjaman. amount lebih besar dari
 * sisa utang otomatis dipotong pas sisa utang saja (tidak minus).
 * Kalau utang lunas total, key pinjaman dihapus. Semua nilai uang
 * disanitasi dengan cleanInteger sebelum dipakai kalkulasi apa pun.
 */
async function repayLoan(userId, amount) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  const cleanAmount = cleanInteger(amount);
  if (cleanAmount <= 0) return { ok: false, error: 'Jumlah pembayaran harus lebih dari 0.' };

  const loan = await getLoan(userId); // amount di sini sudah dibersihkan oleh getLoan
  if (!loan || loan.amount <= 0) {
    return { ok: false, error: 'Kamu tidak punya utang aktif.' };
  }

  const balance = await getBalance(userId); // sudah dibersihkan oleh getBalance
  if (balance < cleanAmount) {
    return { ok: false, error: `Saldo tidak cukup. Saldo kamu 💵 ${formatZYC(balance)} ZYC.` };
  }

  const actualPayment = Math.min(cleanAmount, loan.amount);
  const remaining = cleanInteger(loan.amount - actualPayment);

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
 *    approval Owner lewat /debt-approve untuk dihapus).
 * @returns {Promise<{ seized: boolean, details?: object }>}
 */
async function checkAndHandleOverdueLoan(userId) {
  const redis = getRedis();
  if (!redis) return { seized: false };

  const loan = await getLoan(userId);
  if (!loan || loan.amount <= 0) return { seized: false };
  if (Date.now() < loan.dueAt) return { seized: false }; // belum jatuh tempo

  const portfolio = await getPortfolio(userId);
  const prices = await getAllPrices();

  const holdings = ASSET_CODES
    .map((code) => ({ code, qty: portfolio[code], price: prices[code], value: cleanInteger(portfolio[code] * prices[code]) }))
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
    const valueSeized = cleanInteger(unitsNeeded * holding.price);
    const overshoot = Math.max(0, valueSeized - remainingDebt);

    await adjustAssetQuantity(userId, holding.code, -unitsNeeded);
    if (overshoot > 0) {
      await adjustBalance(userId, overshoot);
    }
    seizedAssets.push({ code: holding.code, quantity: unitsNeeded, value: valueSeized, refunded: overshoot });
    remainingDebt -= valueSeized;
  }

  if (remainingDebt <= 0) {
    await redis.del(loanKey(userId));
    return { seized: true, details: { fullyCovered: true, seizedAssets, loanAmount: loan.amount } };
  }

  await redis.del(loanKey(userId));
  const existingBadDebt = await redis.get(badDebtKey(userId));
  const totalBadDebt = cleanInteger(cleanInteger(existingBadDebt) + remainingDebt);
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
    return cleanInteger(raw);
  } catch (err) {
    console.error('[Trading] getBadDebt failed:', err.message);
    return 0;
  }
}

/**
 * approveBadDebtClear — Owner menghapus bad debt user (dianggap "write
 * off"/dihapuskan). Dipakai /debt-approve.
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

const PENDING_ORDER_TTL_SECONDS = 600;

async function placeOrder(userId, assetCode, side, quantity) {
  const redis = getRedis();
  if (!redis) return { ok: false, error: 'Redis tidak dikonfigurasi.' };

  const def = getAssetDefinition(assetCode);
  if (!def) return { ok: false, error: 'Aset tidak dikenal.' };
  if (side !== 'buy' && side !== 'sell') return { ok: false, error: 'Sisi order harus buy atau sell.' };

  const qty = cleanInteger(quantity);
  if (qty <= 0) return { ok: false, error: 'Jumlah harus lebih dari 0.' };
  if (qty > def.maxOrderQuantity) {
    return { ok: false, error: `Maksimal ${def.maxOrderQuantity} unit per order untuk ${assetCode.toUpperCase()}.` };
  }

  const price = await getPrice(assetCode);
  if (side === 'buy') {
    const balance = await getBalance(userId);
    const estimatedCost = cleanInteger(price * qty);
    if (balance < estimatedCost) {
      return { ok: false, error: `Saldo tidak cukup buat estimasi order ini. Estimasi biaya 💵 ${formatZYC(estimatedCost)} ZYC, saldo kamu 💵 ${formatZYC(balance)} ZYC.` };
    }
  } else {
    const owned = await getAssetQuantity(userId, assetCode);
    if (owned < qty) {
      return { ok: false, error: `Kepemilikan tidak cukup. Kamu punya 💰 ${owned} ${assetCode.toUpperCase()}.` };
    }
  }

  const orderData = { side, quantity: qty, assetCode: assetCode.toUpperCase(), placedAt: Date.now() };
  await redis.set(orderKey(userId, assetCode), orderData, { ex: PENDING_ORDER_TTL_SECONDS });

  return { ok: true, order: orderData };
}

async function cancelOrder(userId, assetCode) {
  const redis = getRedis();
  if (!redis) return { ok: false, error: 'Redis tidak dikonfigurasi.' };
  const existing = await redis.get(orderKey(userId, assetCode));
  if (!existing) return { ok: false, error: 'Kamu tidak punya order pending untuk aset ini.' };
  await redis.del(orderKey(userId, assetCode));
  return { ok: true, cancelledOrder: existing };
}

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

async function executeOrderAtEventPrice(userId, assetCode) {
  const redis = getRedis();
  if (!redis) return { executed: false };

  const order = await getOrder(userId, assetCode);
  if (!order) return { executed: false };

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
const EVENT_TTL_SECONDS = 300;

const EVENT_TYPES = {
  BULLISH: { label: 'Sentimen Bullish', direction: 1 },
  BEARISH: { label: 'Sentimen Bearish', direction: -1 },
};

function createMarketEvent(type, targetAssets = null) {
  const eventDef = EVENT_TYPES[type];
  if (!eventDef) return null;
  return {
    type,
    label: eventDef.label,
    direction: eventDef.direction,
    targetAssets,
    triggeredAt: Date.now(),
  };
}

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

function generateRandomPrediction() {
  const randomAsset = ASSET_CODES[Math.floor(Math.random() * ASSET_CODES.length)];
  const randomDirection = Math.random() < 0.5 ? 'melesat naik 📈' : 'anjlok turun 📉';
  return { asset: randomAsset, text: `${randomAsset} diperkirakan akan ${randomDirection}` };
}

async function applyEventToPrice(assetCode, eventData, baseMagnitudePercent) {
  const def = getAssetDefinition(assetCode);
  if (!def) return null;

  const currentPrice = await getPrice(assetCode);
  const magnitude = baseMagnitudePercent * def.eventSensitivity;
  const newPrice = currentPrice * (1 + eventData.direction * magnitude);

  return setPrice(assetCode, newPrice);
}

function isAssetTargetedByEvent(assetCode, eventData) {
  if (!eventData.targetAssets) return true;
  return eventData.targetAssets.includes(assetCode.toUpperCase());
}

/**
 * triggerMarketEventFlow — alur LENGKAP trigger event: simpan sebagai
 * active event, kirim pengumuman T-1 menit (dengan prediksi random
 * independen), lalu publish QStash delay job 60 detik yang nanti benar-
 * benar mengubah harga + eksekusi order pending.
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
/* saat accept, bisa gagal kalau saldo/aset sudah berubah.                */
/* ---------------------------------------------------------------------- */

const MAX_ITEMS_PER_SIDE = 5;
const TRADE_TTL_SECONDS = 600;

function cartKey(userId) {
  return `trading:cart:${userId}`;
}

function tradeKey(tradeId) {
  return `trading:trade:${tradeId}`;
}

function generateTradeId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

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
 * user. item.amount SELALU disanitasi dengan cleanInteger SEDINI MUNGKIN
 * — item cash/aset dalam trade selalu Integer bulat, disamakan persis
 * dengan aturan saldo & kepemilikan aset.
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

  const cleanAmount = cleanInteger(item.amount);
  if (cleanAmount <= 0) return { ok: false, error: 'Jumlah harus lebih dari 0.' };

  const cleanItem = { ...item, amount: cleanAmount };

  const cart = await getCart(userId);
  if (cart[side].length >= MAX_ITEMS_PER_SIDE) {
    return { ok: false, error: `Maksimal ${MAX_ITEMS_PER_SIDE} item per sisi.` };
  }

  cart[side].push(cleanItem);
  await redis.set(cartKey(userId), cart);
  return { ok: true, cart };
}

async function clearCart(userId) {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(cartKey(userId));
}

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

  for (const item of cart.offer) {
    if (item.type === 'cash') {
      const balance = await getBalance(fromUserId);
      if (balance < item.amount) {
        return { ok: false, error: `Saldo kamu tidak cukup buat menawarkan 💵 ${formatZYC(item.amount)} ZYC.` };
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

  for (const item of trade.offer) {
    if (item.type === 'cash') {
      const balance = await getBalance(trade.fromUserId);
      if (balance < item.amount) {
        await redis.del(tradeKey(tradeId));
        return { ok: false, error: `Trade gagal — pengirim tidak lagi punya cukup 💵 ${formatZYC(item.amount)} ZYC.` };
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
        return { ok: false, error: `Kamu tidak punya cukup 💵 ${formatZYC(item.amount)} ZYC buat memenuhi permintaan trade ini.` };
      }
    } else {
      const owned = await getAssetQuantity(respondingUserId, item.code);
      if (owned < item.amount) {
        await redis.del(tradeKey(tradeId));
        return { ok: false, error: `Kamu tidak punya cukup ${item.code} buat memenuhi permintaan trade ini.` };
      }
    }
  }

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
  cleanInteger,
  cleanNumber,
  formatZYC,
};
