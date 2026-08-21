'use strict';

const { Redis } = require('@upstash/redis');
const { CONFIG } = require('./config');

/* =========================================================================
 * REDIS CLIENT (Upstash) — REST-based, aman dipakai di serverless
 * (tidak butuh persistent connection). Client dibuat sekali per cold
 * start dan dipakai ulang selama warm invocation.
 * ========================================================================= */

let redisClient = null;

function getRedis() {
  if (!CONFIG.UPSTASH_REDIS_REST_URL || !CONFIG.UPSTASH_REDIS_REST_TOKEN) {
    return null; // Redis opsional — fitur terkait di-skip kalau tidak dikonfigurasi
  }
  if (!redisClient) {
    redisClient = new Redis({
      url: CONFIG.UPSTASH_REDIS_REST_URL,
      token: CONFIG.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redisClient;
}

/* =========================================================================
 * 1. CONVERSATION MEMORY — riwayat chat PER USER PER CHANNEL, bounded,
 * dengan TTL. Key: conv:{channelId}:{userId} -> JSON array [{role, content}].
 *
 * Dipisah per user (bukan cuma per channel) supaya identitas/konteks satu
 * user (misal Owner) tidak "bocor" ke user lain yang kebetulan ngobrol di
 * channel yang sama — riwayat User A tidak pernah terlihat oleh User B.
 * ========================================================================= */

function conversationKey(channelId, userId) {
  return `conv:${channelId}:${userId}`;
}

async function getConversation(channelId, userId) {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const data = await redis.get(conversationKey(channelId, userId));
    if (!data) return [];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('[Redis] getConversation failed:', err.message);
    return [];
  }
}

async function appendConversation(channelId, userId, userMessage, assistantReply) {
  const redis = getRedis();
  if (!redis) return;
  try {
    const history = await getConversation(channelId, userId);
    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: assistantReply });
    const trimmed = history.slice(-(CONFIG.MAX_HISTORY * 2));
    await redis.set(conversationKey(channelId, userId), trimmed, { ex: CONFIG.CONVERSATION_TTL_SECONDS });
  } catch (err) {
    console.error('[Redis] appendConversation failed:', err.message);
  }
}

async function clearConversation(channelId, userId) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(conversationKey(channelId, userId));
  } catch (err) {
    console.error('[Redis] clearConversation failed:', err.message);
  }
}

/**
 * clearAllConversationsInChannel — hapus riwayat SEMUA user di 1 channel
 * tertentu. Owner-only (dicek di layer command, bukan di sini). Pakai
 * SCAN (bukan KEYS) supaya tidak memblokir Redis pada dataset besar —
 * aman untuk skala bot personal.
 * @returns {Promise<number>} jumlah key yang terhapus
 */
async function clearAllConversationsInChannel(channelId) {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const pattern = `conv:${channelId}:*`;
    let cursor = 0;
    let deletedCount = 0;
    do {
      const [nextCursor, keys] = await redis.scan(cursor, { match: pattern, count: 100 });
      cursor = Number(nextCursor);
      if (keys.length > 0) {
        await redis.del(...keys);
        deletedCount += keys.length;
      }
    } while (cursor !== 0);
    return deletedCount;
  } catch (err) {
    console.error('[Redis] clearAllConversationsInChannel failed:', err.message);
    return 0;
  }
}

/**
 * clearAllConversations — hapus SEMUA riwayat percakapan di semua
 * channel & user (wipe total). Owner-only (dicek di layer command).
 * @returns {Promise<number>} jumlah key yang terhapus
 */
async function clearAllConversations() {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const pattern = 'conv:*';
    let cursor = 0;
    let deletedCount = 0;
    do {
      const [nextCursor, keys] = await redis.scan(cursor, { match: pattern, count: 100 });
      cursor = Number(nextCursor);
      if (keys.length > 0) {
        await redis.del(...keys);
        deletedCount += keys.length;
      }
    } while (cursor !== 0);
    return deletedCount;
  } catch (err) {
    console.error('[Redis] clearAllConversations failed:', err.message);
    return 0;
  }
}

/* =========================================================================
 * 2. BLOCKLIST SYSTEM — cek status blokir user sebelum eksekusi command.
 * Key: blocklist:{userId}  ->  JSON { blockedAt, reason }
 * ========================================================================= */

function blocklistKey(userId) {
  return `blocklist:${userId}`;
}

async function isUserBlocked(userId) {
  const redis = getRedis();
  if (!redis) return false; // Redis tidak dikonfigurasi -> fail-open (tidak blokir siapa pun)
  try {
    const entry = await redis.get(blocklistKey(userId));
    return Boolean(entry);
  } catch (err) {
    console.error('[Redis] isUserBlocked failed:', err.message);
    return false; // fail-open saat error, jangan sampai Redis down mengunci semua user
  }
}

async function blockUser(userId, reason = 'No reason provided') {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  await redis.set(blocklistKey(userId), { blockedAt: new Date().toISOString(), reason });
}

async function unblockUser(userId) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  await redis.del(blocklistKey(userId));
}

/**
 * listBlockedUsers — ambil semua userId yang sedang diblokir beserta
 * detail (blockedAt, reason). Dipakai command /blocklist.
 */
async function listBlockedUsers() {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const keys = await redis.keys('blocklist:*');
    if (!keys.length) return [];
    const entries = await Promise.all(
      keys.map(async (key) => {
        const data = await redis.get(key);
        return { userId: key.replace('blocklist:', ''), ...(data || {}) };
      })
    );
    return entries;
  } catch (err) {
    console.error('[Redis] listBlockedUsers failed:', err.message);
    return [];
  }
}

/* =========================================================================
 * 3. EMERGENCY MAINTENANCE SWITCH — key tunggal global.
 * Key: MAINTENANCE_MODE  ->  "1" / "true" (aktif)  atau tidak ada / "0" (nonaktif)
 * ========================================================================= */

const MAINTENANCE_KEY = 'MAINTENANCE_MODE';

async function isMaintenanceMode() {
  const redis = getRedis();
  if (!redis) return false; // fail-open: kalau Redis tidak dikonfigurasi, bot tetap jalan normal
  try {
    const val = await redis.get(MAINTENANCE_KEY);
    return val === '1' || val === 1 || val === true || val === 'true';
  } catch (err) {
    console.error('[Redis] isMaintenanceMode failed:', err.message);
    return false; // fail-open saat error, jangan sampai Redis down mematikan seluruh bot
  }
}

async function setMaintenanceMode(enabled) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  await redis.set(MAINTENANCE_KEY, enabled ? '1' : '0');
}

/* =========================================================================
 * 4. SAY LOG — backup permanen (di luar channel log Discord) pemakaian
 * /say: siapa, kapan, isi pesan, channel tujuan. Disimpan sebagai list,
 * bertambah tiap pemakaian, dengan TTL panjang (default 30 hari).
 * Key: saylog  ->  list of JSON entries (push ke kiri, terbaru duluan)
 * ========================================================================= */

const SAY_LOG_KEY = 'saylog';
const SAY_LOG_MAX_ENTRIES = 500;

async function logSayCommand({ userId, username, channelId, content }) {
  const redis = getRedis();
  if (!redis) return;
  try {
    const entry = JSON.stringify({
      userId,
      username,
      channelId,
      content,
      at: new Date().toISOString(),
    });
    await redis.lpush(SAY_LOG_KEY, entry);
    await redis.ltrim(SAY_LOG_KEY, 0, SAY_LOG_MAX_ENTRIES - 1);
    await redis.expire(SAY_LOG_KEY, CONFIG.SAY_LOG_TTL_SECONDS);
  } catch (err) {
    console.error('[Redis] logSayCommand failed:', err.message);
  }
}

async function getSayLogs(limit = 20) {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const raw = await redis.lrange(SAY_LOG_KEY, 0, limit - 1);
    return raw
      .map((item) => {
        try {
          return typeof item === 'string' ? JSON.parse(item) : item;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    console.error('[Redis] getSayLogs failed:', err.message);
    return [];
  }
}

module.exports = {
  getRedis,
  getConversation,
  appendConversation,
  clearConversation,
  clearAllConversationsInChannel,
  clearAllConversations,
  isUserBlocked,
  blockUser,
  unblockUser,
  listBlockedUsers,
  isMaintenanceMode,
  setMaintenanceMode,
  logSayCommand,
  getSayLogs,
  recordUsage,
  getStats,
  getLeaderboard,
  setModelOverride,
  getModelOverride,
  clearModelOverride,
};

/* =========================================================================
 * 5. USAGE STATS — hitung pemakaian command AI per user & total token,
 * per hari (key baru tiap hari UTC, auto-expire 35 hari). Dipakai /stats.
 *
 * Key: stats:{YYYY-MM-DD}            -> Hash { "count" -> total, "tokens" -> total }
 * Key: stats:{YYYY-MM-DD}:users      -> Hash { userId -> jumlah panggilan }
 * Key: stats:{YYYY-MM-DD}:tokens     -> Hash { userId -> jumlah token }
 * ========================================================================= */

const STATS_TTL_SECONDS = 35 * 24 * 3600; // 35 hari, cukup untuk lihat tren bulanan

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/**
 * recordUsage — catat 1 pemanggilan command AI. tokenCount opsional —
 * kalau gateway AI kamu tidak mengembalikan field usage/total_tokens,
 * cukup panggil tanpa tokenCount (tetap tercatat jumlah panggilannya,
 * cuma token-nya tidak ikut terhitung). Best-effort, tidak pernah throw.
 */
async function recordUsage({ userId, commandName, tokenCount }) {
  const redis = getRedis();
  if (!redis) return;
  try {
    const day = todayKey();
    const pipeline = redis.pipeline();
    pipeline.hincrby(`stats:${day}`, 'count', 1);
    pipeline.hincrby(`stats:${day}:users`, userId, 1);
    pipeline.hincrby(`stats:${day}:commands`, commandName, 1);
    if (typeof tokenCount === 'number' && tokenCount > 0) {
      pipeline.hincrby(`stats:${day}`, 'tokens', tokenCount);
      pipeline.hincrby(`stats:${day}:tokens`, userId, tokenCount);
    }
    pipeline.expire(`stats:${day}`, STATS_TTL_SECONDS);
    pipeline.expire(`stats:${day}:users`, STATS_TTL_SECONDS);
    pipeline.expire(`stats:${day}:commands`, STATS_TTL_SECONDS);
    pipeline.expire(`stats:${day}:tokens`, STATS_TTL_SECONDS);
    // Leaderboard sepanjang waktu — key TANPA tanggal, TIDAK di-expire,
    // jadi terus terakumulasi selama bot dipakai. Dipakai /leaderboard.
    pipeline.hincrby('leaderboard:alltime:calls', userId, 1);
    if (typeof tokenCount === 'number' && tokenCount > 0) {
      pipeline.hincrby('leaderboard:alltime:tokens', userId, tokenCount);
    }
    await pipeline.exec();
  } catch (err) {
    console.error('[Redis] recordUsage failed:', err.message);
  }
}

/**
 * getStats — ambil ringkasan pemakaian hari ini: total panggilan, total
 * token, breakdown per command, dan top user (by jumlah panggilan & token).
 */
async function getStats() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const day = todayKey();
    const [totals, byUser, byCommand, tokensByUser] = await Promise.all([
      redis.hgetall(`stats:${day}`),
      redis.hgetall(`stats:${day}:users`),
      redis.hgetall(`stats:${day}:commands`),
      redis.hgetall(`stats:${day}:tokens`),
    ]);

    const topUsers = Object.entries(byUser || {})
      .map(([userId, count]) => ({ userId, count: Number(count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const topTokenUsers = Object.entries(tokensByUser || {})
      .map(([userId, tokens]) => ({ userId, tokens: Number(tokens) }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5);

    return {
      day,
      totalCalls: Number(totals?.count || 0),
      totalTokens: Number(totals?.tokens || 0),
      byCommand: byCommand || {},
      topUsers,
      topTokenUsers,
    };
  } catch (err) {
    console.error('[Redis] getStats failed:', err.message);
    return null;
  }
}

/**
 * getLeaderboard — top user berdasarkan jumlah panggilan ATAU token,
 * bisa scope 'today' (data hari ini, sama dengan getStats) atau
 * 'alltime' (kumulatif sejak bot dipakai, tidak pernah reset).
 */
async function getLeaderboard({ scope = 'alltime', metric = 'calls', limit = 10 } = {}) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    let key;
    if (scope === 'today') {
      const day = todayKey();
      key = metric === 'tokens' ? `stats:${day}:tokens` : `stats:${day}:users`;
    } else {
      key = metric === 'tokens' ? 'leaderboard:alltime:tokens' : 'leaderboard:alltime:calls';
    }

    const data = await redis.hgetall(key);
    const entries = Object.entries(data || {})
      .map(([userId, value]) => ({ userId, value: Number(value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);

    return { scope, metric, entries };
  } catch (err) {
    console.error('[Redis] getLeaderboard failed:', err.message);
    return null;
  }
}

/* =========================================================================
 * 6. MODEL OVERRIDE — ganti model AI aktif on-the-fly tanpa redeploy.
 * Key: active_model -> string nama model, atau tidak ada (pakai default
 * ENV VERCEL_PROXY_MODEL).
 * ========================================================================= */

const MODEL_OVERRIDE_KEY = 'active_model';

async function setModelOverride(modelName) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  await redis.set(MODEL_OVERRIDE_KEY, modelName);
}

async function getModelOverride() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const val = await redis.get(MODEL_OVERRIDE_KEY);
    return val || null;
  } catch (err) {
    console.error('[Redis] getModelOverride failed:', err.message);
    return null;
  }
}

async function clearModelOverride() {
  const redis = getRedis();
  if (!redis) throw new Error('Redis is not configured.');
  await redis.del(MODEL_OVERRIDE_KEY);
}
