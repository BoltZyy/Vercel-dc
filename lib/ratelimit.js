'use strict';

const { Ratelimit } = require('@upstash/ratelimit');
const { getRedis } = require('./redis');
const { CONFIG } = require('./config');

/* =========================================================================
 * RATE LIMITING — cegah spam/quota AI habis, per user, sliding window.
 * Dibangun di atas Redis yang sama dengan fitur lain (tidak butuh
 * infrastruktur tambahan). Fail-open kalau Redis tidak dikonfigurasi,
 * konsisten dengan fitur Redis lain di bot ini.
 * ========================================================================= */

let limiter = null;

function getLimiter() {
  const redis = getRedis();
  if (!redis) return null;
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(CONFIG.RATE_LIMIT_MAX, `${CONFIG.RATE_LIMIT_WINDOW_SECONDS} s`),
      prefix: 'ratelimit:tanya',
    });
  }
  return limiter;
}

/**
 * checkRateLimit — cek & konsumsi 1 quota untuk userId.
 * @returns {Promise<{ success: boolean, remaining: number, resetInSeconds: number }>}
 *   success=true selalu kalau Redis tidak dikonfigurasi (fail-open).
 */
async function checkRateLimit(userId) {
  const rl = getLimiter();
  if (!rl) {
    return { success: true, remaining: Infinity, resetInSeconds: 0 };
  }
  try {
    const result = await rl.limit(userId);
    const resetInSeconds = Math.max(0, Math.ceil((result.reset - Date.now()) / 1000));
    return { success: result.success, remaining: result.remaining, resetInSeconds };
  } catch (err) {
    console.error('[RateLimit] checkRateLimit failed:', err.message);
    return { success: true, remaining: Infinity, resetInSeconds: 0 }; // fail-open saat error
  }
}

module.exports = { checkRateLimit };
