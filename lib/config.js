'use strict';

/* =========================================================================
 * CONFIG — single source of truth untuk semua ENV & konstanta.
 * Semua modul lain import dari sini, bukan baca process.env langsung.
 * ========================================================================= */

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

const CONFIG = {
  // Discord app credentials
  DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY || '',
  DISCORD_TOKEN: process.env.DISCORD_TOKEN || '',
  DISCORD_APPLICATION_ID: process.env.DISCORD_APPLICATION_ID || '',

  // Owner recognition
  OWNER_ID: process.env.OWNER_ID || '1091901409668124805',

  // AI Proxy (Saucepan Engine) — OpenAI-compatible gateway
  VERCEL_PROXY_URL: process.env.VERCEL_PROXY_URL || '',
  VERCEL_PROXY_KEY: process.env.VERCEL_PROXY_KEY || '',
  VERCEL_PROXY_MODEL: process.env.VERCEL_PROXY_MODEL || 'gpt-4o-mini',

  // Upstash Redis — Conversation Memory, Blocklist, Maintenance Switch,
  // Rate-limiting, Say-log
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL || '',
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN || '',
  CONVERSATION_TTL_SECONDS: Number(process.env.CONVERSATION_TTL_SECONDS || 3600),

  // Rate-limiting untuk /tanya — N request per WINDOW_SECONDS per user.
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX || 5),
  RATE_LIMIT_WINDOW_SECONDS: Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 60),

  // Channel Discord privat untuk log real-time (dipakai /say, dan bisa
  // dipakai command sensitif lain nanti). Opsional — kalau kosong, log
  // real-time ke channel di-skip (tetap tercatat ke Redis).
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || '',
  SAY_LOG_TTL_SECONDS: Number(process.env.SAY_LOG_TTL_SECONDS || 2592000), // 30 hari

  // Upstash QStash — job queue untuk memisahkan proses AI dari response
  // Discord awal (menghindari function Vercel dibekukan pasca-response).
  QSTASH_TOKEN: process.env.QSTASH_TOKEN || '',
  QSTASH_CURRENT_SIGNING_KEY: process.env.QSTASH_CURRENT_SIGNING_KEY || '',
  QSTASH_NEXT_SIGNING_KEY: process.env.QSTASH_NEXT_SIGNING_KEY || '',
  // Base URL API QStash sesuai region akun kamu. WAJIB diisi eksplisit —
  // tanpa ini, SDK bisa memakai default region yang beda dari akun kamu
  // dan menyebabkan error "user not found in this region".
  // US region: https://qstash.upstash.io
  // EU region: https://qstash-eu-central-1.upstash.io
  // (Akun ini terkonfirmasi berada di region EU — lihat catatan di README.)
  QSTASH_URL: process.env.QSTASH_URL || 'https://qstash-eu-central-1.upstash.io',

  // URL publik project Vercel ini sendiri (tanpa trailing slash), dipakai
  // QStash untuk tahu endpoint mana yang harus dipanggil balik.
  // Contoh: https://vercel-dc.vercel.app
  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

  // Behavior
  MAX_HISTORY: Number(process.env.MAX_HISTORY || 6),
  DISCORD_MSG_LIMIT: 2000,
  AI_TIMEOUT_MS: Number(process.env.AI_TIMEOUT_MS || 25000),

  // System prompts
  DEFAULT_SYSTEM_PROMPT:
    process.env.SYSTEM_PROMPT ||
    'Kamu adalah asisten Discord yang ramah dan membantu. Jawab dalam Bahasa Indonesia secara ringkas dan jelas.',

  OWNER_CONTEXT_NOTE:
    'Pengirim pesan ini adalah BoltZy, owner sah dan pencipta kamu (identitas terverifikasi lewat Discord user ID). Sambut dan layani dia dengan hormat dan penuh perhatian.',
};

function validateRuntimeEnv() {
  const missing = [];
  if (!CONFIG.DISCORD_PUBLIC_KEY) missing.push('DISCORD_PUBLIC_KEY');
  if (!CONFIG.DISCORD_TOKEN) missing.push('DISCORD_TOKEN');
  if (!CONFIG.DISCORD_APPLICATION_ID) missing.push('DISCORD_APPLICATION_ID');
  if (!CONFIG.VERCEL_PROXY_URL) missing.push('VERCEL_PROXY_URL');
  if (!CONFIG.VERCEL_PROXY_KEY) missing.push('VERCEL_PROXY_KEY');
  if (!CONFIG.QSTASH_TOKEN) missing.push('QSTASH_TOKEN');
  if (!CONFIG.QSTASH_CURRENT_SIGNING_KEY) missing.push('QSTASH_CURRENT_SIGNING_KEY');
  if (!CONFIG.QSTASH_NEXT_SIGNING_KEY) missing.push('QSTASH_NEXT_SIGNING_KEY');
  if (!CONFIG.PUBLIC_BASE_URL) missing.push('PUBLIC_BASE_URL');
  // Redis sengaja TIDAK wajib — tanpa konfigurasi, fitur memory/blocklist/
  // maintenance otomatis fail-open (nonaktif) tanpa mematikan bot inti.
  return missing;
}

module.exports = { CONFIG, requireEnv, validateRuntimeEnv };
