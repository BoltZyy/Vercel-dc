# Discord Bot — Vercel Serverless (Backup Engine)

## Struktur
```
package.json
vercel.json
deploy-commands.js
api/
  index.js               <- Webhook endpoint (Discord Interactions URL)
  process-ai.js           <- Dipanggil QStash, eksekusi AI + PATCH ke Discord
lib/
  config.js               <- ENV terpusat
  aiEngine.js              <- Client Saucepan Proxy (OpenAI-compatible)
  discordApi.js             <- PATCH/POST ke Discord Webhook & Channel API
  permissions.js             <- Cek Owner / permission Discord (ManageMessages)
  ratelimit.js                <- Rate-limit per user untuk command AI
  qstash.js                    <- Publish job AI ke QStash
  redis.js                      <- Conversation memory, blocklist, maintenance, say-log
  commands.js                    <- processAiJob (eksekusi AI sesungguhnya, dipanggil dari process-ai.js)
  commands/
    avatar.js                     <- /avatar
    userinfo.js                    <- /userinfo
    ping.js                         <- /ping
    say.js                           <- /say
    moderation.js                     <- /block /unblock /blocklist /maintenance /reset
    aiJobs.js                          <- /translate /ringkas (queue ke QStash)
```

## Daftar Command

| Command | Akses | Butuh AI? | Keterangan |
|---|---|---|---|
| `/tanya {pesan}` | Semua | Ya | Chat bebas dengan AI, pakai conversation history per channel |
| `/translate {teks} {bahasa?}` | Semua | Ya | Terjemahan, tanpa history (independen per panggilan) |
| `/ringkas {teks}` | Semua | Ya | Ringkas teks jadi poin inti, tanpa history |
| `/avatar {user?}` | Semua | Tidak | Tampilkan avatar user (default: diri sendiri) |
| `/userinfo {user?}` | Semua | Tidak | Info akun: dibuat kapan, join kapan, role |
| `/ping` | Semua | Tidak | Cek bot hidup & latency kasar |
| `/reset` | Semua | Tidak | Hapus riwayat percakapan AI di channel ini |
| `/model` | Owner | Tidak | Lihat status model AI aktif |
| `/say {pesan} {channel?}` | Owner **atau** `ManageMessages` di server itu | Tidak | Bot kirim pesan atas nama bot, dual-logged (channel log + Redis) |
| `/block {user} {alasan?}` | Owner | Tidak | Blokir user dari semua fitur bot |
| `/unblock {user}` | Owner | Tidak | Buka blokir user |
| `/blocklist` | Owner | Tidak | Lihat daftar user yang sedang diblokir |
| `/maintenance {status?}` | Owner | Tidak | Cek/ubah mode maintenance (kosongkan status untuk cek saja) |

Command AI (`/tanya`, `/translate`, `/ringkas`) kena rate-limit per user
(default 5x/60 detik) — Owner dikecualikan dari rate-limit.

## Environment Variables (Vercel Project Settings -> Environment Variables)

| Key | Wajib | Keterangan |
|---|---|---|
| `DISCORD_PUBLIC_KEY` | ✅ | Dari Discord Developer Portal -> General Information |
| `DISCORD_TOKEN` | ✅ | Bot Token -> Bot tab |
| `DISCORD_APPLICATION_ID` | ✅ | Application ID -> General Information |
| `OWNER_ID` | opsional | Default `1091901409668124805` |
| `VERCEL_PROXY_URL` | ✅ | Base URL proxy AI OpenAI-compatible kamu (tanpa `/chat/completions`) |
| `VERCEL_PROXY_KEY` | ✅ | API key proxy AI kamu (isi bebas kalau gateway kamu sendiri tidak mewajibkan key) |
| `VERCEL_PROXY_MODEL` | opsional | Default `gpt-4o-mini` |
| `MAX_HISTORY` | opsional | Default `6` — jumlah pasangan pesan yang disimpan per channel |
| `AI_TIMEOUT_MS` | opsional | Default `25000` |
| `SYSTEM_PROMPT` | opsional | Override system prompt default untuk `/tanya` |
| `DISCORD_GUILD_ID` | opsional, hanya untuk `deploy-commands.js` | Kalau diisi, command register instan ke 1 guild (testing) |
| `UPSTASH_REDIS_REST_URL` | opsional* | Dari Upstash Console -> Redis DB -> REST API |
| `UPSTASH_REDIS_REST_TOKEN` | opsional* | Dari Upstash Console -> Redis DB -> REST API |
| `CONVERSATION_TTL_SECONDS` | opsional | Default `3600` — riwayat chat per channel expired otomatis |
| `RATE_LIMIT_MAX` | opsional | Default `5` — maks pemanggilan command AI per window |
| `RATE_LIMIT_WINDOW_SECONDS` | opsional | Default `60` — panjang window rate-limit (detik) |
| `LOG_CHANNEL_ID` | opsional | Channel Discord untuk log real-time `/say`. Kosongkan untuk skip log channel (tetap tercatat ke Redis) |
| `SAY_LOG_TTL_SECONDS` | opsional | Default `2592000` (30 hari) — masa simpan log `/say` di Redis |
| `QSTASH_TOKEN` | ✅ | Dari Upstash Console -> QStash |
| `QSTASH_CURRENT_SIGNING_KEY` | ✅ | Dari Upstash Console -> QStash |
| `QSTASH_NEXT_SIGNING_KEY` | ✅ | Dari Upstash Console -> QStash |
| `QSTASH_URL` | opsional | Default `https://qstash-eu-central-1.upstash.io`. Ganti ke `https://qstash.upstash.io` kalau akun QStash kamu di region US |
| `PUBLIC_BASE_URL` | ✅ | URL project Vercel ini sendiri, tanpa trailing slash. Contoh: `https://vercel-dc.vercel.app` |

*Redis secara teknis opsional (fail-open kalau kosong), tapi **wajib diisi** kalau mau pakai blocklist, rate-limit, `/say` logging, atau conversation memory — tanpa Redis, fitur-fitur itu senyap tidak aktif tanpa bot mati.

## Arsitektur `/tanya`, `/translate`, `/ringkas` (QStash-based)

Ketiga command ini butuh panggil AI (bisa beberapa detik), tapi Vercel Node
Functions **tidak menjamin** kerja async lanjut berjalan setelah response
HTTP pertama terkirim ke client. Kalau dipaksakan (deferred lalu proses AI
di background), hasilnya bot macet di "thinking..." lalu Discord menyerah
dengan "the application did not respond" — karena function-nya dibekukan
sebelum sempat PATCH balik ke Discord.

Solusinya, alurnya dipecah jadi dua request independen:

```
Discord -> POST /api                     (request #1)
  -> cek maintenance & blocklist & rate-limit
  -> publish job ke QStash (cepat, <1 detik), sertakan jobType
     ('tanya' / 'translate' / 'ringkas')
  -> balas Type 5 (DEFERRED) ke Discord
  -> function #1 SELESAI di sini, tidak ada kerja lanjutan

QStash -> POST /api/process-ai            (request #2, independen)
  -> verifikasi signature QStash
  -> processAiJob() panggil AI sesuai jobType (bisa beberapa detik, di-await
     penuh) — 'tanya' pakai conversation history, 'translate'/'ringkas' tidak
  -> PATCH hasil ke Discord webhook @original
  -> function #2 baru exit setelah semua tuntas
```

Karena request #2 adalah HTTP request baru yang berdiri sendiri, function
itu "hidup" untuk melayani dirinya sendiri sampai selesai — tidak ada
ketergantungan pada asumsi "tetap hidup setelah response lain terkirim".

Command lain (`/model`, `/avatar`, `/userinfo`, `/ping`, `/say`, dan semua
command moderasi) tidak lewat alur ini sama sekali karena tidak panggil
AI — semua dijawab langsung (Type 4) dalam response pertama.

### Perilaku tanpa Redis dikonfigurasi
Semua fitur berbasis Redis **fail-open** kalau `UPSTASH_REDIS_REST_URL`/`TOKEN` kosong atau Redis error saat runtime:
- Conversation memory -> kosong (bot tetap jawab, tanpa histori).
- Blocklist -> tidak ada user yang diblokir (`/block` akan gagal dengan pesan error, tapi bot tetap jalan).
- Rate-limit -> tidak ada limit (semua request lolos).
- Maintenance switch -> selalu dianggap OFF (bot tetap jalan normal).
- `/say` logging ke Redis -> tidak tersimpan (log channel Discord tetap jalan kalau `LOG_CHANNEL_ID` diisi).

Ini disengaja supaya Redis down/belum di-setup TIDAK mematikan bot inti.

### Emergency Maintenance Switch
Pakai `/maintenance status:ON` atau `/maintenance status:OFF` (Owner-only) — lebih cepat dari toggle manual di Upstash Console. Command ini mengunci semua command kecuali dari Owner selama maintenance aktif.

### Sistem Permission `/say`
- **Owner** (`OWNER_ID`) -> selalu boleh, di server manapun.
- **User dengan izin Discord `Manage Messages`** -> boleh, tapi cuma di server tempat dia punya izin itu (bukan lintas server).
- Selain itu -> ditolak.

Setiap pemakaian `/say` tercatat dua kali: real-time ke channel `LOG_CHANNEL_ID` (kalau diisi) dan permanen ke Redis (kalau Redis dikonfigurasi) — masing-masing independen, kegagalan salah satu tidak menggagalkan command utama.

## Langkah Deploy

1. **Push project ini ke Vercel** (`vercel deploy` atau via GitHub import).
2. **Isi semua ENV** di atas pada Vercel Project Settings.
3. **Ambil URL endpoint** hasil deploy, contoh: `https://bot-kamu.vercel.app/api`
4. **Set Interactions Endpoint URL** di Discord Developer Portal -> General Information -> `INTERACTIONS ENDPOINT URL` -> isi dengan URL di atas.
5. **Register slash commands** (jalankan sekali dari local/Termux, bukan dari Vercel):
   ```bash
   DISCORD_TOKEN=xxx DISCORD_APPLICATION_ID=xxx node deploy-commands.js
   ```
   Tambahkan `DISCORD_GUILD_ID=xxx` untuk testing instan di 1 server saja.
6. **Undang bot ke server** dengan scope `applications.commands` + `bot`.

## Catatan Region QStash
Setiap akun QStash terikat permanen ke satu region (US atau EU) sejak
pembuatan akun — toggle tampilan di Upstash Console tidak memindahkan
akun, cuma mengubah token mana yang ditampilkan. Kalau muncul error
`user not found in this region`, ambil ulang `QSTASH_TOKEN` +
`QSTASH_CURRENT_SIGNING_KEY` + `QSTASH_NEXT_SIGNING_KEY` dari toggle
yang sesuai region akun kamu, dan pastikan `QSTASH_URL` cocok:
- US: `https://qstash.upstash.io`
- EU: `https://qstash-eu-central-1.upstash.io`

Ketiga nilai token/key harus diambil **bersamaan dari toggle yang sama** —
jangan campur token region A dengan signing key region B.

## Catatan pengembangan kode
Seluruh kode ini dibuat dan diuji langsung oleh owner, **BoltZy**. Dilengkapi dengan penalaran **Claude Sonnet 5** untuk troubleshoot masalah dan penambahan fitur slash commands, dan beberapa menggunakan **Gemini 3.6 flash** untuk memecahkan sebagian kecil masalah dan merancang struktur prompting untuk menghemat token Claude. Semua struktur kode itu adalah hasil vibe coding dari BoltZy dari hp langsung menggunakan **QuickEdit dan Termux**, disempurnakan dengan AI.

## Penting
jangan pernah **hardcoded .env** lalu upload ke repo/fork github. Gunakan logika sync saja agar bisa menarik .env dari penyedia host (Vercel di environment and variable).