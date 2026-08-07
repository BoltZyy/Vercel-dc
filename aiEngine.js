'use strict';

const { CONFIG } = require('./config');

/* =========================================================================
 * AI ENGINE — Saucepan Proxy Client
 * Custom OpenAI-Compatible Gateway. Tidak pakai SDK provider manapun,
 * murni fetch native ke VERCEL_PROXY_URL dengan format chat.completions.
 * ========================================================================= */

const OWNER_VERIFIED_CONTEXT =
  'Pengirim pesan ini adalah BoltZy, owner sah dan pencipta kamu (identitas terverifikasi lewat Discord user ID, bukan cuma klaim teks). Sambut dan layani dia dengan hormat, manis, dan penuh perhatian.';

const STANDARD_CONTEXT_NOTE = null; // tidak ada catatan tambahan untuk user biasa

function withContextNote(baseSystemPrompt, note) {
  if (!note) return baseSystemPrompt;
  return `${baseSystemPrompt}\n\n[Catatan internal — jangan disebutkan eksplisit ke user]: ${note}`;
}

function buildSystemPrompt(isOwner) {
  const base = CONFIG.DEFAULT_SYSTEM_PROMPT;
  return withContextNote(base, isOwner ? OWNER_VERIFIED_CONTEXT : STANDARD_CONTEXT_NOTE);
}

/**
 * fetchWithTimeout — native fetch dibungkus AbortController supaya tidak
 * pernah menggantung melebihi batas waktu function Vercel.
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * askAI — kirim request chat.completions ke Saucepan Proxy.
 * @param {Object} params
 * @param {string} params.userMessage
 * @param {boolean} params.isOwner
 * @param {Array<{role:string, content:string}>} [params.history]
 * @param {string} [params.modelOverride]
 * @returns {Promise<string>} teks balasan AI
 */
async function askAI({ userMessage, isOwner, history = [], modelOverride }) {
  if (!CONFIG.VERCEL_PROXY_URL || !CONFIG.VERCEL_PROXY_KEY) {
    throw new Error('AI proxy is not configured (VERCEL_PROXY_URL / VERCEL_PROXY_KEY missing).');
  }

  const systemPrompt = buildSystemPrompt(isOwner);
  const model = modelOverride || CONFIG.VERCEL_PROXY_MODEL;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const endpoint = `${CONFIG.VERCEL_PROXY_URL.replace(/\/+$/, '')}/chat/completions`;

  let response;
  try {
    response = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CONFIG.VERCEL_PROXY_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.7,
        }),
      },
      CONFIG.AI_TIMEOUT_MS
    );
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('AI proxy request timed out.');
    }
    throw new Error(`AI proxy network error: ${err.message}`);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`AI proxy returned ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json().catch(() => null);
  const text = data?.choices?.[0]?.message?.content;

  if (!text || !text.trim()) {
    throw new Error('AI proxy returned an empty response.');
  }

  return text.trim();
}

/**
 * splitMessage — pecah teks panjang jadi beberapa chunk sesuai limit Discord.
 */
function splitMessage(text, limit = CONFIG.DISCORD_MSG_LIMIT) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

module.exports = { askAI, splitMessage, buildSystemPrompt };
