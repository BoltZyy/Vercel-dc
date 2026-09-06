'use strict';

const { getBalance, adjustBalance, cleanInteger } = require('./trading');

/* =========================================================================
 * GAMBLING ENGINE — house edge 5% diterapkan lewat payout MULTIPLIER
 * yang dikurangi dari nilai "fair" secara matematis (bukan lewat
 * manipulasi peluang menang), supaya transparan dan gampang diaudit:
 *
 *   coinflip : peluang 50% -> fair payout 2.0x -> actual 1.9x
 *   dice     : peluang 1/6 (16.67%) -> fair payout 6.0x -> actual 5.7x
 *   roulette : peluang 18/37 (~48.6%) untuk red/black/odd/even -> 1.9x
 *              (angka ini SUDAH ditetapkan eksplisit di spesifikasi,
 *              bukan hasil kalkulasi fair-odds -- house edge roulette
 *              di sini datang dari angka 0 sebagai zonk universal,
 *              1.9x adalah nilai yang diminta langsung)
 *   slots    : payout tetap (5x/1.5x/0x) sesuai spesifikasi, bukan
 *              hasil kalkulasi fair-odds otomatis
 *
 * SEMUA taruhan dibatasi maksimal 100% saldo cash user (tidak ada limit
 * lain) — divalidasi di validateBet() sebelum taruhan diproses.
 * ========================================================================= */

const HOUSE_EDGE = 0.05;
const COINFLIP_PAYOUT_MULTIPLIER = 1.9; // (1 / 0.5) * (1 - 0.05) = 1.9
const DICE_PAYOUT_MULTIPLIER = 5.7; // (1 / (1/6)) * (1 - 0.05) = 5.7
const ROULETTE_EVEN_MONEY_MULTIPLIER = 1.9; // ditetapkan eksplisit di spesifikasi

const SLOTS_SYMBOLS = ['🍒', '🍋', '🍇', '🔔', '💎', '7️⃣'];
const SLOTS_JACKPOT_MULTIPLIER = 5;
const SLOTS_PAIR_MULTIPLIER = 1.5;

const ROULETTE_CHOICES = {
  red: { label: '🔴 Red', multiplier: ROULETTE_EVEN_MONEY_MULTIPLIER },
  black: { label: '⬛ Black', multiplier: ROULETTE_EVEN_MONEY_MULTIPLIER },
  odd: { label: '🔢 Odd', multiplier: ROULETTE_EVEN_MONEY_MULTIPLIER },
  even: { label: '🔢 Even', multiplier: ROULETTE_EVEN_MONEY_MULTIPLIER },
};

// Pembagian warna roulette standar (European, angka 1-36, 0 = hijau/zonk).
const ROULETTE_RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * parseBetAmount — parsing input {bet} yang mendukung "all in"/"allin"/
 * "all-in" (case-insensitive) ATAU angka nominal eksak. Fungsi MURNI,
 * butuh balance sebagai parameter (bukan fetch sendiri) supaya gampang
 * di-test tanpa Redis.
 */
function parseBetAmount(input, balance) {
  const normalized = String(input).trim().toLowerCase().replace(/[\s-]/g, '');
  if (normalized === 'allin') {
    return { ok: true, amount: cleanInteger(balance) };
  }
  const parsed = Number(String(input).replace(/,/g, ''));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false, error: '⚠️ Format taruhan tidak valid. Contoh: `6700` atau `all in`.' };
  }
  return { ok: true, amount: cleanInteger(parsed) };
}

/**
 * validateBet — cek saldo cukup. Taruhan dibatasi maksimal 100% saldo
 * (bebas limit lain) sesuai spesifikasi.
 */
function validateBet(amount, balance) {
  if (amount <= 0) return { ok: false, error: '⚠️ Jumlah taruhan harus lebih dari 0.' };
  if (amount > balance) {
    return { ok: false, error: `⚠️ Saldo tidak cukup. Saldo kamu 💵 ${balance.toLocaleString('id-ID')} ZYC.` };
  }
  return { ok: true };
}

/* ---------------------------------------------------------------------- */
/* COINFLIP                                                                 */
/* ---------------------------------------------------------------------- */

function playCoinflip(betAmount) {
  const isWin = Math.random() < 0.5;
  const payout = isWin ? cleanInteger(betAmount * COINFLIP_PAYOUT_MULTIPLIER) : 0;
  const netChange = payout - betAmount; // bisa negatif (kalah) atau positif (menang)
  return { isWin, result: isWin ? 'Heads' : 'Tails', payout, netChange };
}

/* ---------------------------------------------------------------------- */
/* DICE — tebak angka 1-6, command BARU (tidak ada sebelumnya)             */
/* ---------------------------------------------------------------------- */

function playDice(betAmount, guessedNumber) {
  const rolled = randomInt(1, 6);
  const isWin = rolled === guessedNumber;
  const payout = isWin ? cleanInteger(betAmount * DICE_PAYOUT_MULTIPLIER) : 0;
  const netChange = payout - betAmount;
  return { isWin, rolled, payout, netChange };
}

/* ---------------------------------------------------------------------- */
/* SLOTS                                                                    */
/* ---------------------------------------------------------------------- */

function playSlots(betAmount) {
  const reels = [
    SLOTS_SYMBOLS[randomInt(0, SLOTS_SYMBOLS.length - 1)],
    SLOTS_SYMBOLS[randomInt(0, SLOTS_SYMBOLS.length - 1)],
    SLOTS_SYMBOLS[randomInt(0, SLOTS_SYMBOLS.length - 1)],
  ];

  const allSame = reels[0] === reels[1] && reels[1] === reels[2];
  const anyPair = !allSame && (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]);

  let multiplier = 0;
  let outcome = 'zonk';
  if (allSame) {
    multiplier = SLOTS_JACKPOT_MULTIPLIER;
    outcome = 'jackpot';
  } else if (anyPair) {
    multiplier = SLOTS_PAIR_MULTIPLIER;
    outcome = 'pair';
  }

  const payout = cleanInteger(betAmount * multiplier);
  const netChange = payout - betAmount;
  return { reels, outcome, payout, netChange };
}

/* ---------------------------------------------------------------------- */
/* ROULETTE                                                                 */
/* ---------------------------------------------------------------------- */

function getRouletteChoice(choiceId) {
  if (!choiceId) return null;
  return ROULETTE_CHOICES[choiceId.toLowerCase()] || null;
}

/**
 * playRoulette — angka 0-36. 0 SELALU zonk untuk red/black/odd/even
 * (house edge structural, konsisten dengan roulette sungguhan) terlepas
 * dari pilihan user.
 */
function playRoulette(betAmount, choiceId) {
  const choice = getRouletteChoice(choiceId);
  const rolled = randomInt(0, 36);

  let isWin = false;
  if (rolled !== 0) {
    if (choiceId === 'red') isWin = ROULETTE_RED_NUMBERS.has(rolled);
    else if (choiceId === 'black') isWin = !ROULETTE_RED_NUMBERS.has(rolled);
    else if (choiceId === 'odd') isWin = rolled % 2 === 1;
    else if (choiceId === 'even') isWin = rolled % 2 === 0;
  }

  const payout = isWin ? cleanInteger(betAmount * choice.multiplier) : 0;
  const netChange = payout - betAmount;
  const rolledColor = rolled === 0 ? 'green' : ROULETTE_RED_NUMBERS.has(rolled) ? 'red' : 'black';

  return { isWin, rolled, rolledColor, payout, netChange };
}

/* ---------------------------------------------------------------------- */
/* ORCHESTRATOR — potong taruhan dulu, baru kreditkan payout (all-or-     */
/* nothing terhadap validasi, tapi 2 tahap terhadap Redis karena payout   */
/* memang harus dihitung SETELAH taruhan "dipotong" secara konsep)        */
/* ---------------------------------------------------------------------- */

/**
 * executeGamble — dipakai oleh SEMUA command judi (coinflip/dice/slots/
 * roulette). `playFn` adalah salah satu dari playCoinflip/playDice/dst,
 * dipanggil dengan betAmount (+ argumen tambahan lewat extraArgs).
 */
async function executeGamble(userId, betInput, playFn, extraArgs = []) {
  const balance = await getBalance(userId);
  if (balance === null) return { ok: false, error: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' };

  const parsed = parseBetAmount(betInput, balance);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const validation = validateBet(parsed.amount, balance);
  if (!validation.ok) return { ok: false, error: validation.error };

  const playResult = playFn(parsed.amount, ...extraArgs);

  // netChange negatif (kalah) -> adjustBalance kurangi taruhan.
  // netChange positif (menang) -> adjustBalance tambah SELISIH BERSIH
  // (payout - taruhan), bukan payout penuh, karena taruhan sudah
  // "keluar" dari saldo secara konseptual saat dipasang.
  await adjustBalance(userId, playResult.netChange);

  return { ok: true, betAmount: parsed.amount, ...playResult };
}

module.exports = {
  HOUSE_EDGE,
  COINFLIP_PAYOUT_MULTIPLIER,
  DICE_PAYOUT_MULTIPLIER,
  ROULETTE_EVEN_MONEY_MULTIPLIER,
  SLOTS_SYMBOLS,
  SLOTS_JACKPOT_MULTIPLIER,
  SLOTS_PAIR_MULTIPLIER,
  ROULETTE_CHOICES,
  ROULETTE_RED_NUMBERS,
  parseBetAmount,
  validateBet,
  playCoinflip,
  playDice,
  playSlots,
  playRoulette,
  getRouletteChoice,
  executeGamble,
};
