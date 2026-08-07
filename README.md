# Discord Bot — Vercel Serverless (Backup Engine)

## Struktur
```
package.json
vercel.json
deploy-commands.js
api/
  index.js          <- Webhook endpoint (Discord Interactions URL)
lib/
  config.js         <- ENV terpusat
  aiEngine.js        <- Client Saucepan Proxy (OpenAI-compatible)
  discordApi.js       <- PATCH/POST followup ke Discord Webhook API
  commands.js         <- Handler /tanya dan /model
  redis.js            <- Upstash Redis: conversation memory, blocklist, maintenance
```

## Environment Variables (Vercel Project Settings -> Environment Variables)

| Key | Wajib | Keterangan |
|---|---|---|
| `DISCORD_PUBLIC_KEY` | ✅ | Dari Discord Developer Portal -> General Information |
| `DISCORD_TOKEN` | ✅ | Bot Token -> Bot tab |
| `DISCORD_APPLICATION_ID` | ✅ | Application ID -> General Information |
| `OWNER_ID` | opsional | Default `1091901409668124805` |
| `VERCEL_PROXY_URL` | ✅ | Base URL proxy AI OpenAI-compatible kamu (tanpa `/chat/completions`) |
| `VERCEL_PROXY_KEY` | ✅ | API key proxy AI kamu |
| `VERCEL_PROXY_MODEL` | opsional | Default `gpt-4o-mini` |
| `MAX_HISTORY` | opsional | Default `6` (belum dipakai aktif di versi stateless ini) |
| `AI_TIMEOUT_MS` | opsional | Default `25000` |
| `SYSTEM_PROMPT` | opsional | Override system prompt default |
| `DISCORD_GUILD_ID` | opsional, hanya untuk `deploy-commands.js` | Kalau diisi, command register instan ke 1 guild (testing) |
| `UPSTASH_REDIS_REST_URL` | opsional | Dari Upstash Console -> Redis DB -> REST API |
| `UPSTASH_REDIS_REST_TOKEN` | opsional | Dari Upstash Console -> Redis DB -> REST API |
| `CONVERSATION_TTL_SECONDS` | opsional | Default `3600` — riwayat chat per channel expired otomatis |

### Perilaku tanpa Redis dikonfigurasi
Semua 3 fitur Redis **fail-open** kalau `UPSTASH_REDIS_REST_URL`/`TOKEN` kosong atau Redis error saat runtime:
- Conversation memory -> kosong (bot tetap jawab, tanpa histori).
- Blocklist -> tidak ada user yang diblokir.
- Maintenance switch -> selalu dianggap OFF (bot tetap jalan normal).

Ini disengaja supaya Redis down/belum di-setup TIDAK mematikan bot inti.

### Emergency Maintenance Switch
Set key `MAINTENANCE_MODE` ke `"1"` di Upstash Redis (lewat Upstash Console atau CLI) untuk mengunci semua command kecuali dari `OWNER_ID`. Set kembali ke `"0"` atau hapus key untuk menonaktifkan.

## Langkah Deploy

1. **Push project ini ke Vercel** (`vercel deploy` atau via GitHub import).
2. **Isi semua ENV** di atas pada Vercel Project Settings.
3. **Ambil URL endpoint** hasil deploy, contoh: `https://bot-kamu.vercel.app/api`
4. **Set Interactions Endpoint URL** di Discord Developer Portal -> General Information -> `INTERACTIONS ENDPOINT URL` -> isi dengan URL di atas. Discord akan langsung mengirim PING ke situ; kalau `DISCORD_PUBLIC_KEY` benar, otomatis tervalidasi (dijawab PONG oleh `api/index.js`).
5. **Register slash commands** (jalankan sekali dari local/CI, bukan dari Vercel):
   ```bash
   DISCORD_TOKEN=xxx DISCORD_APPLICATION_ID=xxx node deploy-commands.js
   ```
   Tambahkan `DISCORD_GUILD_ID=xxx` untuk testing instan di 1 server saja.
6. **Undang bot ke server** dengan scope `applications.commands` + `bot` (permission minimal: Send Messages).

## Alur Request

```
Discord -> POST /api (signature header)
  -> verifyKey() [Ed25519]
  -> type PING?      -> balas PONG
  -> type COMMAND?   -> balas Type 5 (DEFERRED) < 3 detik
                      -> lanjut async: call Saucepan Proxy -> PATCH @original
```

Tidak ada state di memori antar-request (serverless = stateless per invocation). Riwayat percakapan per-channel TIDAK dipertahankan lintas command di versi ini — setiap `/tanya` independen. Kalau butuh conversation memory lintas-command, perlu backing store eksternal (KV/Redis/Postgres), bukan `Map()` in-memory seperti bot lama (karena tiap invocation Vercel bisa jadi instance berbeda).
