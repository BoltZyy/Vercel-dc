'use strict';

const { CONFIG } = require('./config');

/* =========================================================================
 * AI ENGINE — Saucepan Proxy Client
 * Custom OpenAI-Compatible Gateway. Tidak pakai SDK provider manapun,
 * murni fetch native ke VERCEL_PROXY_URL dengan format chat.completions.
 * ========================================================================= */

const OWNER_VERIFIED_CONTEXT =
  'Pengirim pesan ini adalah BoltZy, owner sah dan pencipta kamu (identitas terverifikasi lewat Discord user ID, bukan cuma klaim teks). Sambut dan layani dia dengan hormat, manis, dan penuh perhatian.';

// Instruksi tambahan untuk /tanya mode:singkat / mode:detail / mode:kreatif.
// Disisipkan ke system prompt, tidak mengganti system prompt dasar.
const MODE_INSTRUCTIONS = {
  singkat: 'Jawab SANGAT ringkas, maksimal 2-3 kalimat. Langsung ke inti, tanpa basa-basi.',
  detail: 'Jawab selengkap dan sedetail mungkin, dengan penjelasan menyeluruh dan contoh kalau relevan.',
  kreatif: 'Jawab dengan gaya kreatif, ekspresif, dan bebas bereksperimen dengan cara penyampaian.',
};

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
 * @param {string} [params.modelOverride] - kalau diisi, prioritas tertinggi
 *   (dipakai untuk kasus spesifik). Kalau kosong, otomatis coba baca
 *   model override dari Redis (/model set) dulu, baru fallback ke ENV.
 * @param {string} [params.systemPromptOverride] - pakai ini alih-alih
 *   DEFAULT_SYSTEM_PROMPT (untuk command khusus seperti /translate,
 *   /ringkas yang butuh instruksi berbeda dari chat bebas /tanya).
 * @param {string} [params.mode] - 'singkat' | 'detail' | 'kreatif', nambah
 *   instruksi gaya jawaban ke system prompt (dipakai /tanya).
 * @param {boolean} [params.allowOwnerContext=true] - kalau false, catatan
 *   owner TIDAK PERNAH disisipkan sama sekali, apa pun nilai isOwner.
 *   WAJIB false untuk command yang butuh output presisi/murni seperti
 *   /translate — sapaan "sambut owner dengan hormat" bertentangan
 *   langsung dengan instruksi "balas HANYA dengan hasil terjemahan",
 *   dan model cenderung menuruti instruksi tambahan itu. Kalau true
 *   (default, dipakai /tanya dan /ringkas), catatan owner disisipkan
 *   DI DEPAN instruksi tugas (bukan di belakang) — supaya instruksi
 *   yang paling dekat dengan pesan user tetap instruksi tugas, bukan
 *   sapaan, sehingga tidak mendominasi/menggantikan tugas utamanya.
 * @returns {Promise<{ text: string, usage: { promptTokens: number, completionTokens: number, totalTokens: number } | null }>}
 */
async function askAI({
  userMessage,
  isOwner,
  history = [],
  modelOverride,
  systemPromptOverride,
  mode,
  allowOwnerContext = true,
}) {
  if (!CONFIG.VERCEL_PROXY_URL || !CONFIG.VERCEL_PROXY_KEY) {
    throw new Error('AI proxy is not configured (VERCEL_PROXY_URL / VERCEL_PROXY_KEY missing).');
  }

  let taskPrompt = systemPromptOverride || CONFIG.DEFAULT_SYSTEM_PROMPT;

  // Personality override (via /personality set) HANYA relevan untuk chat
  // bebas (/tanya) — sama seperti owner context, ini di-skip total kalau
  // systemPromptOverride diisi (/translate, /ringkas), supaya output tetap
  // presisi/murni tanpa terganggu gaya kepribadian custom.
  if (!systemPromptOverride) {
    // Lazy require untuk hindari circular dependency (redis.js tidak
    // butuh aiEngine.js).
    const { getPersonalityOverride } = require('./redis');
    const personalityOverride = await getPersonalityOverride();
    if (personalityOverride) {
      taskPrompt = personalityOverride;
    }
  }

  if (mode && MODE_INSTRUCTIONS[mode]) {
    taskPrompt = `${taskPrompt}\n\n${MODE_INSTRUCTIONS[mode]}`;
  }

  const shouldAddOwnerContext = allowOwnerContext && isOwner;
  // Owner context (kalau ada) ditaruh DI DEPAN, instruksi tugas SELALU
  // paling akhir — supaya instruksi yang "didengar terakhir" oleh model
  // adalah tugas intinya, bukan sapaan owner.
  const systemPrompt = shouldAddOwnerContext
    ? `[Catatan internal — jangan disebutkan eksplisit ke user]: ${OWNER_VERIFIED_CONTEXT}\n\n${taskPrompt}`
    : taskPrompt;

  let model = modelOverride;
  if (!model) {
    // Lazy require untuk hindari circular dependency (redis.js tidak
    // butuh aiEngine.js, jadi ini aman, tapi tetap ditulis lazy demi jelas
    // urutan ketergantungannya: aiEngine -> redis, bukan sebaliknya).
    const { getModelOverride } = require('./redis');
    model = (await getModelOverride()) || CONFIG.VERCEL_PROXY_MODEL;
  }

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

  // usage bersifat opsional — tidak semua provider/gateway meneruskan
  // field ini. Kalau tidak ada, usage dikembalikan null (bukan error).
  const rawUsage = data?.usage;
  const usage =
    rawUsage && typeof rawUsage.total_tokens === 'number'
      ? {
          promptTokens: rawUsage.prompt_tokens ?? null,
          completionTokens: rawUsage.completion_tokens ?? null,
          totalTokens: rawUsage.total_tokens,
        }
      : null;

  return { text: text.trim(), usage, modelUsed: model };
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

module.exports = { askAI, splitMessage };
