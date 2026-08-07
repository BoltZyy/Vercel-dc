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

  // Upstash Redis — Conversation Memory, Blocklist, Maintenance Switch
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL || '',
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN || '',
  CONVERSATION_TTL_SECONDS: Number(process.env.CONVERSATION_TTL_SECONDS || 3600),

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
  // Redis sengaja TIDAK wajib — tanpa konfigurasi, fitur memory/blocklist/
  // maintenance otomatis fail-open (nonaktif) tanpa mematikan bot inti.
  return missing;
}

module.exports = { CONFIG, requireEnv, validateRuntimeEnv };
