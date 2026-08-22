# 🤖 Discord Bot — Vercel Serverless (Backup Engine)

> Bot Discord berbasis HTTP Interactions, jalan sepenuhnya di Vercel Serverless Functions — tanpa gateway/WebSocket, tanpa server yang harus nyala 24/7.

<p>
  <img alt="platform" src="https://img.shields.io/badge/platform-Vercel%20Serverless-black">
  <img alt="commands" src="https://img.shields.io/badge/commands-27-blueviolet">
  <img alt="queue" src="https://img.shields.io/badge/queue-Upstash%20QStash-00e9a3">
  <img alt="storage" src="https://img.shields.io/badge/storage-Upstash%20Redis-dc382d">
</p>

---

## 📑 Daftar Isi
- [Struktur Project](#-struktur-project)
- [Daftar Command](#-daftar-command)
- [Environment Variables](#-environment-variables)
- [Fitur-Fitur Utama](#-fitur-fitur-utama)
- [Arsitektur QStash](#-arsitektur-qstash-kenapa-ribet-amat)
- [Langkah Deploy](#-langkah-deploy)
- [Catatan Region QStash](#-catatan-region-qstash)
- [Rencana Fitur](#-rencana-fitur-belum-dikerjakan)
- [Catatan Pengembangan](#-catatan-pengembangan-kode)
- [Penting: Soal Keamanan ENV](#️-penting)
- [Catatan dari Owner](#-catatan-owner-boltzy)

---

## 📂 Struktur Project

```
package.json
vercel.json
deploy-commands.js
api/
  index.js                  <- Webhook endpoint (Discord Interactions URL)
  process-ai.js              <- Dipanggil QStash -> eksekusi AI -> PATCH ke Discord
  process-status.js           <- Dipanggil QStash -> eksekusi /status -> PATCH ke Discord
  process-remind.js            <- Dipanggil QStash (setelah delay) -> kirim reminder
  process-export.js             <- Dipanggil QStash -> build file -> PATCH ke Discord
lib/
  config.js                        <- ENV terpusat
  aiEngine.js                        <- Client Saucepan Proxy (OpenAI-compatible)
  discordApi.js                        <- PATCH/POST/DM ke Discord API
  permissions.js                         <- Cek Owner / permission Discord (ManageMessages)
  ratelimit.js                             <- Rate-limit per user untuk command AI
  qstash.js                                  <- Publish job generik ke QStash (+ delay support)
  qstashVerify.js                              <- Shared verifikasi signature QStash
  errorLog.js                                    <- Notifikasi error ke channel + audit log
  timeParser.js                                    <- Parser waktu relatif & absolut (/remind)
  redis.js                                           <- Conversation, blocklist, stats, override, dst
  commands.js                                          <- processAiJob (eksekusi AI sesungguhnya)
  commands/
    avatar.js - userinfo.js - ping.js - say.js
    moderation.js         <- /block /unblock /blocklist /maintenance /reset
    aiJobs.js               <- /translate /ringkas (queue ke QStash)
    model.js                  <- /model (lihat & ganti model on-the-fly)
    riwayat.js                  <- /riwayat
    stats.js                      <- /stats
    status.js                       <- /status (queue ke QStash)
    fun.js                             <- /coinflip /roll
    leaderboard.js                       <- /leaderboard
    remind.js                              <- /remind (queue ke QStash + delay)
    exportChat.js                            <- /export (queue ke QStash)
    rate.js                                    <- /rate
    ship.js                                      <- /ship
    timezone.js                                    <- /timezone
    personality.js                                   <- /personality
    warn.js                                            <- /warn
    auditLog.js                                          <- /audit-log
    retryHandler.js                                        <- Handler tombol Retry
```

---

## 📜 Daftar Command

<details open>
<summary><strong>💬 AI & Percakapan</strong></summary>

| Command | Akses | Butuh AI? | Keterangan |
|---|---|---|---|
| `/tanya {pesan} {mode?}` | Semua | ✅ | Chat bebas, pakai history. `mode`: singkat/detail/kreatif |
| `/translate {teks} {bahasa?}` | Semua | ✅ | Terjemahan, tanpa history |
| `/ringkas {teks}` | Semua | ✅ | Ringkas teks, tanpa history |
| `/rate {sesuatu} {mode?}` | Semua | Opsional | `mode:random` instan gratis, `mode:ai` lewat AI |
| `/reset {user?} {scope?}` | Semua* | ❌ | Hapus riwayat percakapan. Owner bisa target user lain / seluruh channel / ALL |
| `/riwayat` | Semua | ❌ | Lihat ringkasan riwayat percakapanmu di channel ini |

</details>

<details open>
<summary><strong>🎉 Fun & Utility</strong></summary>

| Command | Akses | Keterangan |
|---|---|---|
| `/avatar {user?}` | Semua | Tampilkan avatar user |
| `/userinfo {user?}` | Semua | Info akun: dibuat kapan, join kapan, role |
| `/ping` | Semua | Cek bot hidup & latency |
| `/coinflip` | Semua | Lempar koin |
| `/roll {dice}` | Semua | Lempar dadu, format `d20`, `2d6`, dst |
| `/ship {user1} {user2}` | Semua | Persentase kecocokan + progress bar visual |
| `/timezone {waktu} {dari} {ke}` | Semua | Konversi waktu antar zona (nama populer/IANA) |
| `/remind {waktu} {pesan}` | Semua | Jadwalkan pengingat -- relatif (`10m`,`2h`,`1d`) atau absolut |
| `/leaderboard {periode?} {metric?}` | Semua | Top user pemakaian bot (sepanjang waktu / hari ini) |

</details>

<details open>
<summary><strong>🛡️ Moderasi & Owner</strong></summary>

| Command | Akses | Keterangan |
|---|---|---|
| `/model {set?}` | Owner | Lihat/ganti model AI aktif on-the-fly |
| `/personality {set?}` | Owner | Lihat/ganti kepribadian bot on-the-fly |
| `/say {pesan} {channel?}` | Owner atau `ManageMessages` | Bot kirim pesan atas nama bot, dual-logged |
| `/warn {user} {alasan}` | Owner atau `ManageMessages` | Kirim peringatan + DM konsekuensi ke user |
| `/block {user} {alasan?}` | Owner | Blokir user dari semua fitur bot |
| `/unblock {user}` | Owner | Buka blokir user |
| `/blocklist` | Owner | Lihat daftar user yang sedang diblokir |
| `/maintenance {status?}` | Owner | Cek/ubah mode maintenance |
| `/export {user} {format?}` | Owner | Ekspor riwayat percakapan user ke file (.md/.txt) |
| `/stats` | Owner | Statistik pemakaian bot hari ini (panggilan, token, top user) |
| `/status` | Owner | Cek kesehatan Redis, QStash, AI Gateway |
| `/audit-log {tipe?}` | Owner | Timeline gabungan block/say/warn/error |

</details>

> ⏱️ Command AI (`/tanya`, `/translate`, `/ringkas`, `/rate`) kena rate-limit per user (default **5x/60 detik**) -- Owner dikecualikan.
> 🔄 `/tanya`, `/translate`, dan `/ringkas` yang gagal akan menampilkan tombol **Coba Lagi** -- klik untuk mengulang tanpa ketik ulang command.

---

## 🔑 Environment Variables

<details>
<summary><strong>Klik untuk buka tabel lengkap ENV</strong></summary>

| Key | Wajib | Keterangan |
|---|---|---|
| `DISCORD_PUBLIC_KEY` | ✅ | Dari Discord Developer Portal -> General Information |
| `DISCORD_TOKEN` | ✅ | Bot Token -> Bot tab |
| `DISCORD_APPLICATION_ID` | ✅ | Application ID -> General Information |
| `OWNER_ID` | opsional | Default `1091901409668124805` |
| `VERCEL_PROXY_URL` | ✅ | Base URL proxy AI OpenAI-compatible kamu |
| `VERCEL_PROXY_KEY` | ✅ | API key proxy AI kamu (isi bebas kalau gateway kamu sendiri tidak mewajibkan key) |
| `VERCEL_PROXY_MODEL` | opsional | Default `gpt-4o-mini`. Bisa dioverride runtime lewat `/model set` |
| `MAX_HISTORY` | opsional | Default `6` -- jumlah pasangan pesan yang disimpan per channel |
| `AI_TIMEOUT_MS` | opsional | Default `25000` |
| `SYSTEM_PROMPT` | opsional | Override system prompt default untuk `/tanya`. Bisa dioverride runtime lewat `/personality set` |
| `DISCORD_GUILD_ID` | opsional, hanya untuk `deploy-commands.js` | Kalau diisi, command register instan ke 1 guild |
| `UPSTASH_REDIS_REST_URL` | opsional* | Dari Upstash Console -> Redis DB -> REST API |
| `UPSTASH_REDIS_REST_TOKEN` | opsional* | Dari Upstash Console -> Redis DB -> REST API |
| `CONVERSATION_TTL_SECONDS` | opsional | Default `3600` |
| `RATE_LIMIT_MAX` | opsional | Default `5` |
| `RATE_LIMIT_WINDOW_SECONDS` | opsional | Default `60` |
| `LOG_CHANNEL_ID` | opsional | Channel Discord untuk log real-time `/say`, `/warn`, dan error otomatis |
| `SAY_LOG_TTL_SECONDS` | opsional | Default `2592000` (30 hari) |
| `QSTASH_TOKEN` | ✅ | Dari Upstash Console -> QStash |
| `QSTASH_CURRENT_SIGNING_KEY` | ✅ | Dari Upstash Console -> QStash |
| `QSTASH_NEXT_SIGNING_KEY` | ✅ | Dari Upstash Console -> QStash |
| `QSTASH_URL` | opsional | Default `https://qstash-eu-central-1.upstash.io`. Ganti ke `https://qstash.upstash.io` untuk region US |
| `PUBLIC_BASE_URL` | ✅ | URL project Vercel ini sendiri, tanpa trailing slash |

*Redis opsional secara teknis (fail-open), tapi **wajib** untuk blocklist, rate-limit, `/say` logging, conversation memory, `/stats`, `/model set`, `/personality set`, `/riwayat`, `/leaderboard`, `/warn`, `/audit-log`, `/export`, `/remind`, dan tombol Retry -- tanpa Redis, fitur-fitur itu senyap tidak aktif (bot inti tetap jalan).

</details>

---

## ✨ Fitur-Fitur Utama

<details>
<summary><strong>📊 Stats & Token Usage</strong></summary>

`/stats` mencatat jumlah panggilan command AI per hari dan, **kalau** gateway AI kamu meneruskan field `usage.total_tokens` di response (format OpenAI-compatible standar), juga mencatat total token terpakai dan top user berdasarkan token. Ini best-effort -- kalau gateway kamu tidak mengirim field itu, `/stats` tetap jalan normal, cuma bagian token-nya menampilkan "Tidak tersedia".

</details>

<details>
<summary><strong>🔧 Model & Personality Override Runtime</strong></summary>

`/model set:<nama>` dan `/personality set:<teks>` menyimpan nilai ke Redis, dibaca `aiEngine.js` tiap kali sebelum memanggil AI (prioritas di atas ENV). Nama model **tidak divalidasi** oleh bot -- kalau salah ketik, errornya muncul natural dari gateway AI kamu saat command AI berikutnya dipanggil. Pakai `set:default` di masing-masing command untuk kembali ke ENV.

Personality override cuma berlaku untuk `/tanya` -- `/translate` dan `/ringkas` selalu pakai instruksi presisi sendiri supaya outputnya tidak "terbawa" gaya kepribadian custom.

</details>

<details>
<summary><strong>🔄 Retry Button</strong></summary>

Kalau `/tanya`, `/translate`, atau `/ringkas` gagal (AI error atau gagal publish job), pesan error disertai tombol **🔄 Coba Lagi**. Payload job asli disimpan sementara di Redis (TTL 15 menit, sama dengan masa berlaku interaction token Discord) -- klik tombol akan mengulang job yang sama tanpa perlu ketik command lagi.

</details>

<details>
<summary><strong>⏰ Reminder via QStash Delay</strong></summary>

`/remind {waktu} {pesan}` mendukung format waktu **relatif** (`10m`, `2h`, `1d`) maupun **absolut** (`2026-08-22 15:00`, diasumsikan WIB). Reminder dikirim lewat Bot Token langsung ke channel (bukan lewat interaction token, karena token itu expired setelah 15 menit -- sedangkan reminder bisa dijadwalkan sampai 30 hari ke depan).

</details>

<details>
<summary><strong>📄 Export Percakapan</strong></summary>

`/export {user} {format?}` mengekspor riwayat percakapan AI user tertentu di channel itu jadi file `.md` atau `.txt` yang bisa langsung didownload dari Discord -- pakai multipart upload asli (bukan sekadar teks panjang di embed).

</details>

<details>
<summary><strong>📋 Audit Log Gabungan</strong></summary>

`/audit-log {tipe?}` menampilkan timeline gabungan dari `/block`, `/unblock`, `/say`, `/warn`, dan error internal -- semua dalam satu command, bisa difilter per jenis. Berguna untuk lihat riwayat moderasi tanpa scroll channel log manual.

</details>

<details>
<summary><strong>🚨 Error Logging Otomatis</strong></summary>

Setiap error di `processAiJob` (AI gagal) atau di catch block utama `api/index.js` otomatis dikirim ke channel `LOG_CHANNEL_ID` (kalau diisi) -- berisi source error, user, channel, dan pesan error. Di-rate-limit sederhana (maks 1 notifikasi channel per 3 detik per warm instance) supaya error beruntun tidak spam channel -- tapi **semua** error tetap tercatat permanen ke audit log Redis, tidak ikut ter-rate-limit.

</details>

---

## 🏗️ Arsitektur QStash (kenapa ribet amat?)

Command yang butuh network call lama (panggil AI, atau beberapa network check paralel untuk `/status`) **tidak bisa** diproses langsung di request pertama -- Vercel Node Functions **tidak menjamin** kerja async lanjut berjalan setelah response HTTP pertama terkirim ke client. Solusinya, alurnya dipecah jadi dua request independen:

```
Discord --> POST /api                                    (request #1)
              |
              +- cek maintenance & blocklist & rate-limit (khusus command AI)
              +- publish job ke QStash (cepat, <1 detik)
              +- balas Type 5 (DEFERRED) ke Discord
                 ^ function #1 SELESAI di sini, tidak ada kerja lanjutan

QStash --> POST /api/process-ai . process-status . process-remind . process-export
              |                                            (request #2, independen)
              +- verifikasi signature QStash
              +- proses sesungguhnya, di-await penuh (aman karena request independen)
              +- PATCH hasil ke Discord webhook @original
                 ^ function #2 baru exit setelah semua tuntas
```

Command instan (`/model`, `/avatar`, `/userinfo`, `/ping`, `/say`, `/stats`, `/riwayat`, `/coinflip`, `/roll`, `/ship`, `/timezone`, `/warn`, `/audit-log`, `/personality`, dan semua command moderasi) tidak lewat alur ini -- dijawab langsung (Type 4) dalam response pertama.

<details>
<summary><strong>Perilaku tanpa Redis dikonfigurasi (klik untuk detail)</strong></summary>

Semua fitur berbasis Redis **fail-open**:
- Conversation memory, `/riwayat` -> kosong.
- Blocklist -> tidak ada user yang diblokir.
- Rate-limit -> tidak ada limit.
- Maintenance switch -> selalu OFF.
- `/say` & `/warn` logging ke Redis -> tidak tersimpan (log channel tetap jalan kalau `LOG_CHANNEL_ID` diisi).
- `/stats`, `/leaderboard`, `/audit-log` -> menampilkan pesan "tidak tersedia" / kosong.
- `/model set`, `/personality set` -> gagal dengan pesan error, tetap pakai ENV default.
- Tombol Retry -> tidak muncul (pesan error tanpa tombol).

</details>

<details>
<summary><strong>Sistem Permission /say & /warn (klik untuk detail)</strong></summary>

- **Owner** -> selalu boleh, di server manapun.
- **User dengan izin Discord `Manage Messages`** -> boleh, cuma di server itu.
- Setiap pemakaian `/say` tercatat dual: channel `LOG_CHANNEL_ID` (real-time) + Redis (permanen, lewat `/audit-log`).

</details>

---

## 🚀 Langkah Deploy

1. **Push project ini ke Vercel** (`vercel deploy` atau via GitHub import).
2. **Isi semua ENV** di atas pada Vercel Project Settings.
3. **Set Interactions Endpoint URL** di Discord Developer Portal dengan URL `/api` project kamu.
4. **Register slash commands** (jalankan sekali dari local/Termux):
   ```bash
   DISCORD_TOKEN=xxx DISCORD_APPLICATION_ID=xxx node deploy-commands.js
   ```
   Tambahkan `DISCORD_GUILD_ID=xxx` untuk testing instan di 1 server. Opsional, tapi sangat berguna untuk men-deploy slash-commands baru dengan cepat (misal untuk testing di 1 server khusus) -- kalau tidak diisi, maka hapus saja, tapi kalau bot sudah ada di beberapa server, slash-commands mungkin bisa memakan waktu ~1 jam untuk diperbarui dan muncul oleh Discord. Murni ketentuan Discord, bukan masalah kode.
5. **Undang bot ke server** dengan scope `applications.commands` + `bot`.

---

## 🌍 Catatan Region QStash

> Setiap akun QStash terikat **permanen** ke satu region (US atau EU) sejak pembuatan akun -- toggle tampilan di Upstash Console **tidak memindahkan akun**, cuma mengubah token mana yang ditampilkan.

Kalau muncul error `user not found in this region`, ambil ulang `QSTASH_TOKEN` + `QSTASH_CURRENT_SIGNING_KEY` + `QSTASH_NEXT_SIGNING_KEY` dari toggle yang sesuai region akun kamu, dan pastikan `QSTASH_URL` cocok. Ketiga nilai harus diambil **bersamaan dari toggle yang sama** -- jangan campur token region A dengan signing key region B.

---

## 🧭 Rencana Fitur (belum dikerjakan)

- [ ] Auto-block sementara setelah kena rate-limit berkali-kali
- [ ] `/serverinfo`, `/banner {user}`
- [ ] `/remind list` -- lihat semua reminder aktif milik user
- [ ] Persona per-channel (bukan cuma 1 slot global)
- [ ] `/whoami` -- status blocked/rate-limit/permission milik pemanggil
- [ ] Konfirmasi tombol sebelum aksi destruktif (`/reset scope:all`)
- [x] ~~Retry button saat AI gagal~~ selesai
- [x] ~~`/leaderboard`, `/coinflip`, `/roll`~~ selesai
- [x] ~~`/remind {waktu} {pesan}`~~ selesai
- [x] ~~Export percakapan ke file~~ selesai
- [x] ~~`/rate`, `/ship`, `/timezone`, `/personality`, `/warn`, `/audit-log`~~ selesai
- ~~"thinking..." lebih informatif~~ -- dilewati (Discord tidak izinkan custom teks deferred, dan PATCH ganda dianggap tidak worth it)

---

## 👨‍💻 Catatan pengembangan kode

Seluruh kode ini dibuat dan diuji langsung oleh owner, **BoltZy**. Dilengkapi dengan penalaran **Claude Sonnet 5** untuk troubleshoot masalah dan penambahan fitur slash commands, dan beberapa menggunakan **Gemini 3.6 flash** untuk memecahkan sebagian kecil masalah dan merancang struktur prompting untuk menghemat token Claude. Semua struktur kode itu adalah hasil vibe coding dari BoltZy dari hp langsung menggunakan **QuickEdit dan Termux**, disempurnakan dengan AI.

## ⚠️ Penting

> Jangan pernah **hardcoded .env** yang berisi API, token, dan hal sensitif lainnya lalu upload ke repo/fork github. Gunakan logika sync saja agar bisa menarik .env dari penyedia host (Vercel di environment and variable).

## 💬 Catatan Owner (BoltZy)

Kalau bot down di server gw, berarti sedang maintenance kode atau troubleshoot. **Jangan nanya kapan beresnya**, gw pun gatau karena project ini memang cuman ide iseng yang akhirnya jadi bot Discord di waktu senggang gw. Gw ngerjain kode ini purely karena gw seneng dan ada kemauan, bukan karena tuntutan semata. Kalo mau bikin bot sendiri berbasis repo ini, fork aja trus belajar gimana caranya hosting Vercel, ngerti Upstash redis kalo mau nyimpen history chat (opsional), QStash wajib biar bisa nipu ketentuan "3 detik" balasan discord (deferred type:5, queue QStash pas AI proses jawaban), masukin variabel ENV lgsg di dashboard hosting, troubleshoot (bisa pakai AI gratisan, asal mau comply sama usage limit mereka), dan yang pasti minimal ngerti struktur kodenya aja dulu (download .zip repo ini, terus lempar ke AI, suruh jelasin apa aja yg perlu diubah).
