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
 * 1. CONVERSATION MEMORY — riwayat chat per channel, bounded, dengan TTL.
 * Key: conv:{channelId}  ->  JSON array [{role, content}, ...]
 * ========================================================================= */

function conversationKey(channelId) {
  return `conv:${channelId}`;
}

async function getConversation(channelId) {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const data = await redis.get(conversationKey(channelId));
    if (!data) return [];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('[Redis] getConversation failed:', err.message);
    return [];
  }
}

async function appendConversation(channelId, userMessage, assistantReply) {
  const redis = getRedis();
  if (!redis) return;
  try {
    const history = await getConversation(channelId);
    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: assistantReply });
    const trimmed = history.slice(-(CONFIG.MAX_HISTORY * 2));
    await redis.set(conversationKey(channelId), trimmed, { ex: CONFIG.CONVERSATION_TTL_SECONDS });
  } catch (err) {
    console.error('[Redis] appendConversation failed:', err.message);
  }
}

async function clearConversation(channelId) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(conversationKey(channelId));
  } catch (err) {
    console.error('[Redis] clearConversation failed:', err.message);
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
  isUserBlocked,
  blockUser,
  unblockUser,
  listBlockedUsers,
  isMaintenanceMode,
  setMaintenanceMode,
  logSayCommand,
  getSayLogs,
};
