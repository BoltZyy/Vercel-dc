# Discord Bot — Vercel Serverless (Backup Engine)

## Struktur
```
package.json
vercel.json
deploy-commands.js
api/
  index.js                 <- Webhook endpoint (Discord Interactions URL)
  process-ai.js              <- Dipanggil QStash, eksekusi AI + PATCH ke Discord
  process-status.js           <- Dipanggil QStash, eksekusi /status + PATCH ke Discord
lib/
  config.js                     <- ENV terpusat
  aiEngine.js                     <- Client Saucepan Proxy (OpenAI-compatible)
  discordApi.js                     <- PATCH/POST ke Discord Webhook & Channel API
  permissions.js                      <- Cek Owner / permission Discord (ManageMessages)
  ratelimit.js                          <- Rate-limit per user untuk command AI
  qstash.js                               <- Publish job generik ke QStash
  qstashVerify.js                           <- Shared verifikasi signature QStash (dipakai process-ai & process-status)
  errorLog.js                                 <- Kirim notifikasi error ke channel log Discord
  redis.js                                      <- Conversation, blocklist, maintenance, say-log, stats, model override
  commands.js                                     <- processAiJob (eksekusi AI, dipanggil dari process-ai.js)
  commands/
    avatar.js
    userinfo.js
    ping.js
    say.js
    moderation.js                                       <- /block /unblock /blocklist /maintenance /reset
    aiJobs.js                                              <- /translate /ringkas (queue ke QStash)
    model.js                                                <- /model (lihat & ganti model on-the-fly)
    riwayat.js                                                <- /riwayat
    stats.js                                                    <- /stats
    status.js                                                     <- /status (queue ke QStash)
```

## Daftar Command

| Command | Akses | Butuh AI? | Keterangan |
|---|---|---|---|
| `/tanya {pesan} {mode?}` | Semua | Ya | Chat bebas, pakai history. `mode`: singkat/detail/kreatif |
| `/translate {teks} {bahasa?}` | Semua | Ya | Terjemahan, tanpa history |
| `/ringkas {teks}` | Semua | Ya | Ringkas teks, tanpa history |
| `/avatar {user?}` | Semua | Tidak | Tampilkan avatar user |
| `/userinfo {user?}` | Semua | Tidak | Info akun: dibuat kapan, join kapan, role |
| `/ping` | Semua | Tidak | Cek bot hidup & latency |
| `/reset` | Semua | Tidak | Hapus riwayat percakapan AI di channel ini |
| `/riwayat` | Semua | Tidak | Lihat ringkasan riwayat percakapan tersimpan |
| `/model {set?}` | Owner | Tidak | Lihat status model aktif, atau ganti on-the-fly (`set:default` untuk kembali ke ENV) |
| `/say {pesan} {channel?}` | Owner **atau** `ManageMessages` di server itu | Tidak | Bot kirim pesan atas nama bot, dual-logged |
| `/block {user} {alasan?}` | Owner | Tidak | Blokir user dari semua fitur bot |
| `/unblock {user}` | Owner | Tidak | Buka blokir user |
| `/blocklist` | Owner | Tidak | Lihat daftar user yang sedang diblokir |
| `/maintenance {status?}` | Owner | Tidak | Cek/ubah mode maintenance |
| `/stats` | Owner | Tidak | Statistik pemakaian bot hari ini (panggilan, token, top user) |
| `/status` | Owner | Tidak | Cek kesehatan Redis, QStash, AI Gateway (via QStash job) |

Command AI (`/tanya`, `/translate`, `/ringkas`) kena rate-limit per user
(default 5x/60 detik) — Owner dikecualikan dari rate-limit.

## Environment Variables (Vercel Project Settings -> Environment Variables)

| Key | Wajib | Keterangan |
|---|---|---|
| `DISCORD_PUBLIC_KEY` | ✅ | Dari Discord Developer Portal -> General Information |
| `DISCORD_TOKEN` | ✅ | Bot Token -> Bot tab |
| `DISCORD_APPLICATION_ID` | ✅ | Application ID -> General Information |
| `OWNER_ID` | opsional | Default `1091901409668124805` |
| `VERCEL_PROXY_URL` | ✅ | Base URL proxy AI OpenAI-compatible kamu |
| `VERCEL_PROXY_KEY` | ✅ | API key proxy AI kamu (isi bebas kalau gateway kamu sendiri tidak mewajibkan key) |
| `VERCEL_PROXY_MODEL` | opsional | Default `gpt-4o-mini`. Bisa dioverride runtime lewat `/model set` |
| `MAX_HISTORY` | opsional | Default `6` — jumlah pasangan pesan yang disimpan per channel |
| `AI_TIMEOUT_MS` | opsional | Default `25000` |
| `SYSTEM_PROMPT` | opsional | Override system prompt default untuk `/tanya` |
| `DISCORD_GUILD_ID` | opsional, hanya untuk `deploy-commands.js` | Kalau diisi, command register instan ke 1 guild |
| `UPSTASH_REDIS_REST_URL` | opsional* | Dari Upstash Console -> Redis DB -> REST API |
| `UPSTASH_REDIS_REST_TOKEN` | opsional* | Dari Upstash Console -> Redis DB -> REST API |
| `CONVERSATION_TTL_SECONDS` | opsional | Default `3600` |
| `RATE_LIMIT_MAX` | opsional | Default `5` |
| `RATE_LIMIT_WINDOW_SECONDS` | opsional | Default `60` |
| `LOG_CHANNEL_ID` | opsional | Channel Discord untuk log real-time `/say` dan error otomatis |
| `SAY_LOG_TTL_SECONDS` | opsional | Default `2592000` (30 hari) |
| `QSTASH_TOKEN` | ✅ | Dari Upstash Console -> QStash |
| `QSTASH_CURRENT_SIGNING_KEY` | ✅ | Dari Upstash Console -> QStash |
| `QSTASH_NEXT_SIGNING_KEY` | ✅ | Dari Upstash Console -> QStash |
| `QSTASH_URL` | opsional | Default `https://qstash-eu-central-1.upstash.io`. Ganti ke `https://qstash.upstash.io` untuk region US |
| `PUBLIC_BASE_URL` | ✅ | URL project Vercel ini sendiri, tanpa trailing slash |

*Redis opsional secara teknis (fail-open), tapi **wajib** untuk blocklist, rate-limit, `/say` logging, conversation memory, `/stats`, `/model set`, dan `/riwayat` — tanpa Redis, fitur-fitur itu senyap tidak aktif.

## Fitur Baru: Stats & Token Usage

`/stats` mencatat jumlah panggilan command AI per hari dan, **kalau**
gateway AI kamu meneruskan field `usage.total_tokens` di response
(format OpenAI-compatible standar), juga mencatat total token terpakai
dan top user berdasarkan token. Ini best-effort — kalau gateway kamu
tidak mengirim field itu, `/stats` tetap jalan normal, cuma bagian
token-nya menampilkan "Tidak tersedia".

## Fitur Baru: Model Override Runtime

`/model set:<nama>` menyimpan nama model ke Redis, dibaca `aiEngine.js`
setiap kali sebelum memanggil AI (prioritas di atas `VERCEL_PROXY_MODEL`
ENV). Nama model **tidak divalidasi** oleh bot — kalau salah ketik,
errornya muncul natural dari gateway AI kamu saat command AI berikutnya
dipanggil. Pakai `/model set:default` untuk kembali ke ENV.

## Fitur Baru: Error Logging Otomatis

Setiap error di `processAiJob` (AI gagal) atau di catch block utama
`api/index.js` otomatis dikirim ke channel `LOG_CHANNEL_ID` (kalau
diisi) — berisi source error, user, channel, dan pesan error. Di-rate-
limit sederhana (maks 1 log per 3 detik per warm instance) supaya error
beruntun tidak spam channel.

## Arsitektur `/tanya`, `/translate`, `/ringkas`, `/status` (QStash-based)

Command-command ini butuh network call yang bisa lebih dari beberapa
detik (panggil AI, atau 3x network check paralel untuk `/status`), tapi
Vercel Node Functions **tidak menjamin** kerja async lanjut berjalan
setelah response HTTP pertama terkirim ke client. Solusinya, alurnya
dipecah jadi dua request independen:

```
Discord -> POST /api                       (request #1)
  -> cek maintenance & blocklist & rate-limit (khusus command AI)
  -> publish job ke QStash (cepat, <1 detik)
  -> balas Type 5 (DEFERRED) ke Discord
  -> function #1 SELESAI di sini, tidak ada kerja lanjutan

QStash -> POST /api/process-ai atau /api/process-status   (request #2, independen)
  -> verifikasi signature QStash
  -> proses sesungguhnya (panggil AI, atau cek Redis/QStash/gateway),
     di-await penuh karena request ini independen dan aman ditunggu
  -> PATCH hasil ke Discord webhook @original
  -> function #2 baru exit setelah semua tuntas
```

Command lain (`/model`, `/avatar`, `/userinfo`, `/ping`, `/say`, `/stats`,
`/riwayat`, dan semua command moderasi) tidak lewat alur ini karena
instan — dijawab langsung (Type 4) dalam response pertama.

### Perilaku tanpa Redis dikonfigurasi
Semua fitur berbasis Redis **fail-open**:
- Conversation memory, `/riwayat` -> kosong.
- Blocklist -> tidak ada user yang diblokir.
- Rate-limit -> tidak ada limit.
- Maintenance switch -> selalu OFF.
- `/say` logging ke Redis -> tidak tersimpan (log channel tetap jalan kalau `LOG_CHANNEL_ID` diisi).
- `/stats` -> menampilkan pesan "tidak tersedia".
- `/model set` -> gagal dengan pesan error, model tetap pakai ENV default.

### Sistem Permission `/say`
- **Owner** -> selalu boleh, di server manapun.
- **User dengan izin Discord `Manage Messages`** -> boleh, cuma di server itu.
- Setiap pemakaian tercatat dual: channel `LOG_CHANNEL_ID` (real-time) + Redis (permanen).

## Langkah Deploy

1. **Push project ini ke Vercel** (`vercel deploy` atau via GitHub import).
2. **Isi semua ENV** di atas pada Vercel Project Settings.
3. **Set Interactions Endpoint URL** di Discord Developer Portal dengan URL `/api` project kamu.
4. **Register slash commands** (jalankan sekali dari local/Termux):
   ```bash
   DISCORD_TOKEN=xxx DISCORD_APPLICATION_ID=xxx node deploy-commands.js
   ```
   Tambahkan `DISCORD_GUILD_ID=xxx` untuk testing instan di 1 server. Opsional, tapi sangat berguna untuk men-deploy slash-commands baru dengan cepat (misal untuk testing di 1 server khusus), jika tidak diisi, maka hapus saja tetapi mungkin jika bot sudah ada di beberapa server, slash-commands mungkin bisa memakan waktu ~1 jam untuk diperbarui dan muncul oleh Discord. Murni ketentuan Discord, bukan masalah kode.
5. **Undang bot ke server** dengan scope `applications.commands` + `bot`.

## Catatan Region QStash
Setiap akun QStash terikat permanen ke satu region (US atau EU) sejak
pembuatan akun — toggle tampilan di Upstash Console tidak memindahkan
akun, cuma mengubah token mana yang ditampilkan. Kalau muncul error
`user not found in this region`, ambil ulang `QSTASH_TOKEN` +
`QSTASH_CURRENT_SIGNING_KEY` + `QSTASH_NEXT_SIGNING_KEY` dari toggle
yang sesuai region akun kamu, dan pastikan `QSTASH_URL` cocok. Ketiga
nilai harus diambil **bersamaan dari toggle yang sama**.

## Rencana Fitur (belum dikerjakan)

Dicatat dari sesi brainstorming, urutan bebas:
- Retry button saat AI gagal (butuh handle interaction type MESSAGE_COMPONENT baru)
- Auto-block sementara setelah kena rate-limit berkali-kali
- `/leaderboard`, `/serverinfo`, `/banner`, `/coinflip`, `/roll`
- `/remind {waktu} {pesan}` (butuh QStash schedule, beda dari publish biasa)
- Export percakapan ke file, Persona per-channel
- "thinking..." lebih informatif — dilewati (Discord tidak izinkan custom teks deferred, dan PATCH ganda dianggap tidak worth it)

## Catatan pengembangan kode
Seluruh kode ini dibuat dan diuji langsung oleh owner, **BoltZy**. Dilengkapi dengan penalaran **Claude Sonnet 5** untuk troubleshoot masalah dan penambahan fitur slash commands, dan beberapa menggunakan **Gemini 3.6 flash** untuk memecahkan sebagian kecil masalah dan merancang struktur prompting untuk menghemat token Claude. Semua struktur kode itu adalah hasil vibe coding dari BoltZy dari hp langsung menggunakan **QuickEdit dan Termux**, disempurnakan dengan AI.

## Penting
Jangan pernah **hardcoded .env** yang berisi API, token, dan hal sensitif lainnya lalu upload ke repo/fork github. Gunakan logika sync saja agar bisa menarik .env dari penyedia host (Vercel di environment and variable).

## Catatan Owner (BoltZy)
Kalau bot down di server gw, berarti sedang maintenance kode atau troubleshoot. **Jangan nanya kapan beresnya**, gw pun gatau karena project ini memang cuman ide iseng yang akhirnya jadi bot Discord di waktu senggang gw. Gw ngerjain kode ini purely karena gw seneng dan ada kemauan, bukan karena tuntutan semata. Kalo mau bikin bot sendiri berbasis repo ini, fork aja trus belajar gimana caranya hosting Vercel, ngerti Upstash redis kalo mau nyimpen history chat (opsional), QStash wajib biar bisa nipu ketentuan "3 detik" balasan discord (deferred type:5, queue QStash pas AI proses jawaban), masukin variabel ENV lgsg di dashboard hosting, troubleshoot (bisa pakai AI gratisan, asal mau comply sama usage limit mereka), dan yang pasti minimal ngerti struktur kodenya aja dulu (download .zip repo ini, terus lempar ke AI, suruh jelasin apa aja yg perlu diubah).