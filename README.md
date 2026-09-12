# 🤖 Discord Bot — Vercel Serverless (Backup Engine)

> Bot Discord berbasis HTTP Interactions, jalan sepenuhnya di Vercel Serverless Functions — tanpa gateway/WebSocket, tanpa server yang harus nyala 24/7.

![owner](https://img.shields.io/badge/owner-BoltZy-003366?logo=discord&logoColor=white) ![platform](https://img.shields.io/badge/platform-Vercel%20Serverless-black?logo=vercel&logoColor=white) ![language](https://img.shields.io/badge/language-JavaScript-F7DF1E?logo=javascript&logoColor=black) ![commands](https://img.shields.io/badge/commands-57-blueviolet?logo=gnubash&logoColor=white) ![queue](https://img.shields.io/badge/queue-Upstash%20QStash-00e9a3?logo=upstash&logoColor=white) ![storage](https://img.shields.io/badge/storage-Upstash%20Redis-dc382d?logo=redis&logoColor=white) ![economy](https://img.shields.io/badge/economy-ZYC%20Trading-f1c40f?logo=tether&logoColor=black) ![license](https://img.shields.io/badge/license-MIT-yellow?logo=github&logoColor=white)

---

## 🤔 Kenapa Ribet Amat? (Vercel + AI Gateway + Redis + QStash)

Wajar kalau nanya "kenapa nggak pakai BotGhost/Wick/dashboard bot instan aja?" — jawaban jujurnya:

**Vercel, bukan BotGhost/dashboard bot instan** — karena gw mau **kontrol penuh atas kodenya**, bukan dibatasin fitur yang di-lock di balik paywall. Semua yang ada di bot ini (blocklist, rate-limit, retry button, sistem bank, dst) gw yang tentuin sendiri kapan dan gimana caranya, bukan nunggu fitur itu di-approve sama provider dashboard. Plus, Vercel free tier ini beneran gratis buat skala bot personal kayak gini.

**AI Gateway sendiri (Saucepan Proxy), bukan API 1 provider** — biar bebas gonta-ganti Groq/Gemini/Cerebras/OpenRouter kapan aja tanpa bot-nya tau bedanya (tinggal ganti `VERCEL_PROXY_URL`/`VERCEL_PROXY_MODEL`). Banyak provider itu ada tier gratisnya, jadi gw bisa combine buat hemat kuota, dan kalau 1 provider down/limit, gampang pindah ke yang lain.

**Redis + QStash, bukan cuma proses langsung** — ini BUKAN pilihan gaya-gayaan, ini **solusi dari masalah nyata** yang gw temuin sendiri lewat trial-error (baca aja histori troubleshoot-nya, panjang 😅): Discord maksa balasan dalam 3 detik, tapi manggil AI bisa lebih lama dari itu. Vercel Serverless juga nggak jamin proses lanjut jalan di background setelah response pertama dikirim. QStash itu yang "nge-akalin" 2 masalah itu sekaligus (deferred + queue), dan Redis buat nyimpen state (history, blocklist, saldo, utang, dll) karena serverless function itu sendiri nggak punya memory yang nempel.

**Yang paling penting: semua ini BISA GRATIS kalau lo mau belajar.** Vercel, Upstash Redis, Upstash QStash, provider AI gratisan — semuanya punya free tier yang lebih dari cukup buat bot personal. Bedanya cuma effort belajar di awal vs tinggal klik-klik di dashboard berbayar. Kalau lo baca repo ini dan mikir "kok ribet", ya emang — tapi itu harga dari ngerti apa yang sebenernya kejadian di balik layar, bukan cuma pencet tombol doang.

---

## 📑 Daftar Isi

- [Kenapa Ribet Amat?](#-kenapa-ribet-amat-vercel--ai-gateway--redis--qstash)
- [Daftar Command](#-daftar-command-57)
- [Environment Variables](#-environment-variables)
- [Ekonomi Trading ZYC](#-ekonomi-trading-zyc)
- [Bank & Pinjaman](#-bank--pinjaman)
- [Shop, Kosmetik & Money Sink](#-shop-kosmetik--money-sink)
- [Dev & Moderasi](#-dev--moderasi)
- [Arsitektur QStash](#-arsitektur-qstash-kenapa-ribet-amat)
- [Langkah Deploy](#-langkah-deploy)
- [Catatan Region QStash](#-catatan-region-qstash)
- [Rencana Fitur](#-rencana-fitur-belum-dikerjakan)
- [Catatan Pengembangan](#-catatan-pengembangan-kode)
- [Penting: Soal Keamanan ENV](#️-penting)
- [Lisensi](#-lisensi)
- [Catatan dari Owner](#-catatan-owner-boltzy)

---

## 📜 Daftar Command (57)

### 💬 AI & Chat

| Command | Akses | Butuh AI? | Keterangan |
|---|---|---|---|
| `/tanya {pesan} {mode?}` | Semua | ✅ | Chat bebas, pakai history. `mode`: singkat/detail/kreatif |
| `/translate {teks} {bahasa?}` | Semua | ✅ | Terjemahan, tanpa history |
| `/ringkas {teks}` | Semua | ✅ | Ringkas teks, tanpa history |
| `/rate {sesuatu} {mode?}` | Semua | Opsional | `mode:random` instan gratis, `mode:ai` lewat AI |
| `/reset {user?} {scope?}` | Semua* | ❌ | Hapus riwayat percakapan. Owner bisa target user lain / seluruh channel / ALL |
| `/riwayat` | Semua | ❌ | Lihat ringkasan riwayat percakapanmu di channel ini |

> 🔄 `/tanya`, `/translate`, dan `/ringkas` yang gagal akan menampilkan tombol **Coba Lagi (Retry Button)** — klik untuk mengulang tanpa ketik ulang command.

### 🎉 Fun & Utility

| Command | Akses | Keterangan |
|---|---|---|
| `/avatar {user?}` | Semua | Tampilkan avatar user |
| `/userinfo {user?}` | Semua | Info akun: dibuat kapan, join kapan, role |
| `/ping` | Semua | Cek bot hidup & latency |
| `/coinflip` | Semua | Lempar koin |
| `/roll {dice}` | Semua | Lempar dadu, format `d20`, `2d6`, dst |
| `/ship {user1} {user2}` | Semua | Persentase kecocokan + progress bar visual |
| `/timezone {waktu} {dari} {ke}` | Semua | Konversi waktu antar zona (nama populer/IANA) |
| `/remind {waktu} {pesan}` | Semua | Jadwalkan pengingat lewat QStash delay — relatif (`10m`,`2h`,`1d`) atau absolut |
| `/leaderboard {periode?} {metric?}` | Semua | Top user pemakaian bot (sepanjang waktu / hari ini) |

### 💹 Ekonomi ZYC Trading

| Command | Akses | Keterangan |
|---|---|---|
| `/portfolio` | Semua | Saldo, kepemilikan aset, kosmetik profil, koleksi mewah |
| `/market` | Semua | Harga & tren 4 aset (NORA/VOLT/KRYN/PLUM) saat ini |
| `/buy {aset} {jumlah}` | Semua | Beli aset instan di harga sekarang |
| `/sell {aset} {jumlah}` | Semua | Jual aset instan di harga sekarang |
| `/posisi {aset} {jumlah?}` | Semua | Pasang/batalkan order pending — ancang-ancang sebelum event pasar |
| `/work` | Semua | Kerja untuk dapat ZYC secara pasif (cooldown) |
| `/grant {user} {tipe} {kode?} {jumlah}` | Owner | Koreksi manual saldo/aset (boleh negatif) |
| `/trade-add-item`, `/trade-request-item`, `/trade-send`, `/trade-accept`, `/trade-reject`, `/trade-clear` | Semua | Barter 2-way antar-user via keranjang bertahap, TTL 10 menit |
| `/market-event {tipe} {aset?}` | Owner | Picu event pasar manual (pengumuman T-1 menit) |
| `/market-set-price {aset} {harga}` | Owner | Set harga aset manual (override random walk) |

### 🏦 Bank & Pinjaman

| Command | Akses | Keterangan |
|---|---|---|
| `/bank-deposit {jumlah}` | Semua | Setor ZYC ke bank |
| `/bank-withdraw {jumlah} {passcard?}` | Semua | Tarik ZYC dari bank. Pakai **Surat Pelicin** (`BANK_PASSCARD`) untuk skip penalti |
| `/bank-status` | Semua | Lihat saldo bank, bunga, dan status |
| `/pinjam {jumlah}` | Semua | Pinjam ZYC tanpa bunga, tenor `LOAN_DUE_DAYS` hari (default 7) |
| `/bayar-utang {jumlah}` | Semua | Cicil/lunasi pinjaman aktif |
| `/debt` | Semua | Lihat status pinjaman & bad debt milikmu |
| `/debt-approve {user}` | Owner | Hapus bad debt user yang tidak bisa ditagih lagi |

> 💳 Status nunggak dicek setiap kali user memanggil command trading (bukan cron terpisah). Nunggak → aset disita otomatis mulai dari yang termahal. Kalau sitaan tidak cukup menutup utang → sisa berubah jadi **bad debt**, butuh `/debt-approve` (Owner) untuk dihapuskan.

### 🛍️ Shop & Kosmetik

| Command | Akses | Keterangan |
|---|---|---|
| `/shop {kategori?}` | Semua | Lihat katalog shop — utilitas, kosmetik, atau kategori luxury tertentu |
| `/shop-buy {item}` | Semua | Beli item dari shop. Item luxury bersifat **permanen**, tidak bisa dijual balik |
| `/leak` | Semua | Pakai 1x 🕵️ Sinyal Orang Dalam untuk mengintip arah event pasar aktif |

> 🏎️ Item luxury (supercar, villa, space station, dst) punya validator bertingkat (saldo, bebas utang, prasyarat kepemilikan, liquidity check, syarat kategori) dan berfungsi sebagai **money sink permanen** — ZYC yang dipakai hilang selamanya dari ekonomi.

### 🛠️ Dev & Moderasi

| Command | Akses | Keterangan |
|---|---|---|
| `/bypass {status?}` | Owner | **Dev Bypass mode** — skip cooldown/limit/bad debt saat testing |
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

> ⏱️ Command AI (`/tanya`, `/translate`, `/ringkas`, `/rate`) kena rate-limit per user (default **5x/60 detik**) — Owner dikecualikan, atau kalau `/bypass` aktif.

---

## 🔑 Environment Variables

| Key | Wajib | Keterangan |
|---|---|---|
| `DISCORD_PUBLIC_KEY` | ✅ | Dari Discord Developer Portal → General Information |
| `DISCORD_TOKEN` | ✅ | Bot Token → Bot tab |
| `DISCORD_APPLICATION_ID` | ✅ | Application ID → General Information |
| `OWNER_ID` | opsional | Discord User ID owner (BoltZy) |
| `VERCEL_PROXY_URL` | ✅ | Base URL Saucepan Proxy (AI Gateway OpenAI-compatible) kamu |
| `VERCEL_PROXY_KEY` | ✅ | API key proxy AI kamu |
| `VERCEL_PROXY_MODEL` | opsional | Default model AI. Bisa dioverride runtime lewat `/model set` |
| `MAX_HISTORY` | opsional | Jumlah pasangan pesan yang disimpan per channel |
| `AI_TIMEOUT_MS` | opsional | Timeout panggilan AI dalam milidetik |
| `SYSTEM_PROMPT` | opsional | Override system prompt default `/tanya`. Bisa dioverride runtime lewat `/personality set` |
| `DISCORD_GUILD_ID` | opsional, hanya untuk `deploy-commands.js` | Kalau diisi, command register instan ke 1 guild |
| `UPSTASH_REDIS_REST_URL` | opsional* | Dari Upstash Console → Redis DB → REST API |
| `UPSTASH_REDIS_REST_TOKEN` | opsional* | Dari Upstash Console → Redis DB → REST API |
| `CONVERSATION_TTL_SECONDS` | opsional | TTL memori percakapan |
| `RATE_LIMIT_MAX` | opsional | Batas pemanggilan command AI per window |
| `RATE_LIMIT_WINDOW_SECONDS` | opsional | Durasi window rate-limit |
| `LOG_CHANNEL_ID` | opsional | Channel Discord untuk log real-time `/say`, `/warn`, dan error otomatis |
| `SAY_LOG_TTL_SECONDS` | opsional | TTL log `/say` di Redis |
| `QSTASH_TOKEN` | ✅ | Dari Upstash Console → QStash |
| `QSTASH_CURRENT_SIGNING_KEY` | ✅ | Dari Upstash Console → QStash |
| `QSTASH_NEXT_SIGNING_KEY` | ✅ | Dari Upstash Console → QStash |
| `QSTASH_URL` | opsional | Default region EU. Ganti ke region US kalau akun QStash kamu US |
| `PUBLIC_BASE_URL` | ✅ | URL project Vercel ini sendiri, tanpa trailing slash |
| `STARTING_BALANCE` | opsional | Modal awal ZYC untuk user baru |
| `LOAN_DUE_DAYS` | opsional | Tenor pinjaman sebelum aset disita otomatis |
| `MARKET_ANNOUNCEMENT_CHANNEL_ID` | opsional | Channel pengumuman event pasar (fallback ke `LOG_CHANNEL_ID`) |
| `RANDOM_EVENT_CHANCE` | opsional | Peluang event pasar acak tiap price-update |
| `BANK_PASSCARD` | opsional | Kode "Surat Pelicin" untuk skip penalti `/bank-withdraw` |

*Redis opsional secara teknis (fail-open untuk fitur non-ekonomi), tapi **wajib** untuk blocklist, rate-limit, conversation memory, dan **seluruh sistem trading, bank, & shop ZYC** — tanpa Redis, fitur-fitur itu senyap tidak aktif (bot inti tetap jalan).

---

## 💹 Ekonomi Trading ZYC

> Sistem ekonomi fiktif lengkap — bukan sekadar "poin klaim harian". Ada 4 aset dengan karakter beda, event pasar acak, order pending, sampai barter antar-user. Semuanya jalan murni di atas Redis, tanpa exchange rate ke uang asli apa pun.

### 📈 4 Aset & Mekanisme Harga

| Aset | Karakter | Mekanisme |
|---|---|---|
| 🟡 **NORA** | Stabil | Hard Floor/Ceiling ketat, Mean Reversion kuat |
| ⚡ **VOLT** | Volatilitas tinggi, ekstrem | Range lebar, Mean Reversion lemah |
| 📊 **KRYN** | Trending musiman | `trendBias` mendominasi, Mean Reversion sedang |
| 💜 **PLUM** | Paling sensitif event | Lonjakan besar saat event pasar terpicu |

Tiap aset punya **Hard Floor & Ceiling** (batas harga tidak boleh dilewati) dan **Mean Reversion** (harga cenderung "ditarik" balik ke rata-rata seiring waktu), dengan bobot berbeda-beda sesuai karakter masing-masing aset. Harga di-random-walk otomatis lewat job berjadwal QStash setiap interval tertentu, dan tiap update punya kemungkinan (`RANDOM_EVENT_CHANCE`) memicu event pasar acak.

### 🎲 Event Pasar & Order Pending (`/posisi`)

Event pasar bisa terjadi otomatis (random) atau dipicu manual Owner lewat `/market-event`. Begitu event terpicu, bot mengumumkan **T-1 menit** ke `MARKET_ANNOUNCEMENT_CHANNEL_ID` lengkap dengan "prediksi" — yang sengaja **acak dan tidak terkait event asli**, murni elemen gambling.

`/posisi` memungkinkan user pasang ancang-ancang **sebelum** tahu hasil event: order dieksekusi di harga **setelah** event berlangsung, bukan saat dipasang. Maksimal 1 order aktif per aset per user, dan divalidasi ulang saat eksekusi.

### 🤝 Trade Antar-User (Barter 2-Way)

Sistem barter pakai keranjang bertahap: `/trade-add-item` (barang yang kamu tawarkan) dan `/trade-request-item` (barang yang kamu minta), maksimal 5 item per sisi. Hanya boleh **1 keranjang aktif** per user secara global. Setelah siap, `/trade-send` mengirim penawaran ke user tujuan, yang membalas lewat `/trade-accept` atau `/trade-reject` — penawaran kedaluwarsa otomatis dalam 10 menit. Sisi "minta" boleh dikosongkan untuk memberi barang secara cuma-cuma (gift sepihak).

---

## 🏦 Bank & Pinjaman

Sistem bank terpisah dari saldo cash biasa — tempat "parkir" ZYC yang lebih aman dari fluktuasi trading:

- **`/bank-deposit {jumlah}`** — setor ZYC dari saldo cash ke bank.
- **`/bank-withdraw {jumlah} {passcard?}`** — tarik ZYC dari bank. Penarikan normal kena penalti; kalau punya item **Surat Pelicin** (`BANK_PASSCARD`), penalti bisa di-skip.
- **`/bank-status`** — cek saldo bank & status akun.
- **`/pinjam {jumlah}`** — pinjam ZYC bebas nominal tanpa bunga, tenor `LOAN_DUE_DAYS` hari (default 7).
- **`/bayar-utang {jumlah}`** — cicil atau lunasi pinjaman aktif.
- **`/debt`** — cek status pinjaman & bad debt sendiri.
- **`/debt-approve {user}`** (Owner) — hapus bad debt yang tidak bisa ditagih lagi.

**Autosita & bad debt** berjalan otomatis: status nunggak dicek setiap kali user memanggil command trading apa pun (bukan cron terpisah). Begitu terdeteksi lewat tenor, aset disita otomatis mulai dari yang termahal. Kalau nilai sitaan cukup menutup utang, sisa aset (kalau ada) tetap milik user. Kalau tidak cukup, sisa utang berubah jadi **bad debt** dan butuh `/debt-approve` (Owner) untuk dihapuskan secara manual.

---

## 🛍️ Shop, Kosmetik & Money Sink

> Tempat ZYC "menguap" dari peredaran. Prinsipnya sederhana: item luxury tidak pernah bisa dijual balik — begitu dibeli, ZYC-nya hilang permanen dari ekonomi, mencegah inflasi tanpa perlu mengubah sistem trading/utang inti.

**🕵️ Utilitas & Consumable** — saat ini **Sinyal Orang Dalam** (`LEAK_TOKEN`), item sekali pakai. Dipakai lewat `/leak`, membaca event pasar aktif (data sesungguhnya, bukan prediksi acak seperti pengumuman publik) dan menampilkan arah pergerakannya sebelum diumumkan.

**🎨 Kosmetik Profil** — item `equipable` (warna tema embed, gelar/title) langsung tampil di header `/portfolio` begitu dipasang, murni disimpan di Redis, tidak butuh Discord Role.

**🏎️ Luxury Collectibles** — kategori terbesar: supercar, superbike, motorsport, properti, fleet mewah, flex-art, sampai **Ultimate Flex** (Space Station). Semua **permanen**, tidak ada mekanisme jual balik. Beberapa item flagship punya validator bertingkat sebelum bisa dibeli lewat `/shop-buy`:

1. **Saldo cukup** — gerbang paling dasar, semua item kena ini.
2. **Bebas utang** — dealer barang mewah "menolak" transaksi kalau kamu masih punya pinjaman aktif.
3. **Prasyarat kepemilikan** — beberapa item mewajibkan sudah punya item entry-level tertentu lebih dulu.
4. **Liquidity check** — sisa saldo setelah checkout wajib menyisakan persentase minimum dari harga barang.
5. **Syarat kategori** — item flagship tertentu mewajibkan kombinasi kepemilikan kategori lain sekaligus.

---

## 🛠️ Dev & Moderasi

- **`/bypass {status?}`** (Owner) — Dev Bypass mode, untuk skip cooldown, rate-limit, dan pengecekan bad debt saat testing fitur baru tanpa harus menunggu atau bikin akun bersih.
- **`/model`, `/personality`** — override runtime, prioritas di atas ENV, disimpan di Redis.
- **`/say`, `/warn`** — Owner atau user dengan izin Discord `Manage Messages`, dual-logged (channel real-time + Redis permanen).
- **`/block`, `/unblock`, `/blocklist`** — kontrol akses user ke seluruh fitur bot.
- **`/maintenance`** — matikan sementara fitur non-esensial saat troubleshoot.
- **`/export`** — ekspor riwayat percakapan user ke file `.md`/`.txt`.
- **`/stats`, `/status`, `/audit-log`** — observability: statistik pemakaian, kesehatan Redis/QStash/AI Gateway, dan timeline gabungan aktivitas moderasi & error.

---

## 🏗️ Arsitektur QStash (kenapa ribet amat?)

Command yang butuh network call lama (panggil AI, atau beberapa network check paralel) **tidak bisa** diproses langsung di request pertama — Vercel Node Functions **tidak menjamin** kerja async lanjut berjalan setelah response HTTP pertama terkirim ke client. Solusinya, alurnya dipecah jadi dua request independen:

```
Discord --> POST /api                                    (request #1 — Deferred)
              |
              +- cek maintenance & blocklist & rate-limit (khusus command AI)
              +- publish job ke QStash (cepat, <1 detik)
              +- balas Type 5 (DEFERRED) ke Discord
                 ^ function #1 SELESAI di sini, tidak ada kerja lanjutan

QStash --> POST /api/process-*                            (request #2 — Executed via QStash)
              |                                            (independen, dipicu QStash)
              +- verifikasi signature QStash
              +- proses sesungguhnya, di-await penuh (aman karena request independen)
              +- PATCH hasil ke Discord webhook @original
                 ^ function #2 baru exit setelah semua tuntas
```

Command instan (`/model`, `/avatar`, `/userinfo`, `/ping`, `/say`, `/stats`, `/riwayat`, `/coinflip`, `/roll`, `/ship`, `/timezone`, `/warn`, `/audit-log`, `/personality`, `/bypass`, dan semua command moderasi) tidak lewat alur ini — dijawab langsung (Type 4) dalam response pertama.

---

## 🚀 Langkah Deploy

1. **Push project ini ke Vercel** (`vercel deploy` atau via GitHub import).
2. **Isi semua ENV** di atas pada Vercel Project Settings.
3. **Set Interactions Endpoint URL** di Discord Developer Portal dengan URL `/api` project kamu.
4. **Register slash commands** (jalankan sekali dari local/Termux):
   ```bash
   DISCORD_TOKEN=xxx DISCORD_APPLICATION_ID=xxx node deploy-commands.js
   ```
   Tambahkan `DISCORD_GUILD_ID=xxx` untuk testing instan di 1 server. Opsional, tapi sangat berguna untuk men-deploy slash-commands baru dengan cepat — kalau bot sudah ada di beberapa server, slash-commands mungkin bisa memakan waktu ~1 jam untuk diperbarui dan muncul oleh Discord. Murni ketentuan Discord, bukan masalah kode.
5. **Undang bot ke server** dengan scope `applications.commands` + `bot`.

---

## 🌍 Catatan Region QStash

> Setiap akun QStash terikat **permanen** ke satu region (US atau EU) sejak pembuatan akun — toggle tampilan di Upstash Console **tidak memindahkan akun**, cuma mengubah token mana yang ditampilkan.

Kalau muncul error `user not found in this region`, ambil ulang `QSTASH_TOKEN` + `QSTASH_CURRENT_SIGNING_KEY` + `QSTASH_NEXT_SIGNING_KEY` dari toggle yang sesuai region akun kamu, dan pastikan `QSTASH_URL` cocok. Ketiga nilai harus diambil **bersamaan dari toggle yang sama** — jangan campur token region A dengan signing key region B.

---

## 🧭 Rencana Fitur (belum dikerjakan)

- [ ] Auto-block sementara setelah kena rate-limit berkali-kali
- [ ] `/serverinfo`, `/banner {user}`
- [ ] `/remind list` — lihat semua reminder aktif milik user
- [ ] Persona per-channel (bukan cuma 1 slot global)
- [ ] `/whoami` — status blocked/rate-limit/permission milik pemanggil
- [ ] Konfirmasi tombol sebelum aksi destruktif (`/reset scope:all`)
- [ ] Buff temporer trading (mis. badge "Insider" sementara, fee waiver)
- [ ] `/flex` terpisah kalau daftar koleksi luxury makin panjang untuk ditampilkan di `/portfolio`
- [ ] Bunga bank dinamis mengikuti kondisi pasar
- [x] ~~Retry button saat AI gagal~~ selesai
- [x] ~~`/leaderboard`, `/coinflip`, `/roll`~~ selesai
- [x] ~~`/remind {waktu} {pesan}`~~ selesai
- [x] ~~Export percakapan ke file~~ selesai
- [x] ~~`/rate`, `/ship`, `/timezone`, `/personality`, `/warn`, `/audit-log`~~ selesai
- [x] ~~Sistem trading ZYC: 4 aset, event pasar, pinjaman + bad debt, barter antar-user~~ selesai
- [x] ~~Shop: utilitas (`/leak`), kosmetik profil, luxury collectibles money sink~~ selesai
- [x] ~~Sistem bank: deposit, withdraw, Surat Pelicin~~ selesai
- [x] ~~Dev Bypass mode (`/bypass`)~~ selesai
- ~~"thinking..." lebih informatif~~ — dilewati (Discord tidak izinkan custom teks deferred, dan PATCH ganda dianggap tidak worth it)

---

## 👨‍💻 Catatan pengembangan kode

Seluruh kode ini dibuat dan diuji langsung oleh owner, **BoltZy**. Dilengkapi dengan penalaran **Claude Sonnet 5** untuk troubleshoot masalah dan penambahan fitur slash commands, dan beberapa menggunakan **Gemini 3.6 Flash** untuk memecahkan sebagian kecil masalah dan merancang struktur prompting untuk menghemat token Claude. Semua struktur kode ini adalah hasil vibe coding dari BoltZy langsung dari HP menggunakan **QuickEdit dan Termux**, disempurnakan dengan AI. 90% kodenya adalah hasil AI, jadi jangan berharap kesempurnaan mutlak.

## ⚠️ Penting

> Jangan pernah **hardcode `.env`** yang berisi API, token, dan hal sensitif lainnya lalu upload ke repo/fork GitHub. Gunakan logika sync saja agar bisa menarik `.env` dari penyedia host (Vercel di Environment Variables).

## 📄 Lisensi

Project ini dirilis di bawah **MIT License** — bebas dipakai, diubah, di-fork, bahkan dikomersialkan siapa saja, **TAPI** disediakan apa adanya ("AS IS") **tanpa jaminan apa pun**. Kalau kamu fork ini terus ada yang error, rusak, atau menimbulkan masalah di server kamu — itu tanggung jawab kamu sendiri, bukan owner repo ini. Baca lengkapnya di file [`LICENSE`](./LICENSE).

```
MIT License

Copyright (c) 2026 BoltZy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 💬 Catatan Owner (BoltZy)

Kalau bot down di server gw, berarti sedang maintenance kode atau troubleshoot. **Jangan nanya kapan beresnya**, gw pun gatau karena project ini memang cuman ide iseng yang akhirnya jadi bot Discord di waktu senggang gw. Gw ngerjain kode ini purely karena gw seneng dan ada kemauan, bukan karena tuntutan semata. Kalo mau bikin bot sendiri berbasis repo ini, fork aja terus belajar gimana caranya hosting Vercel, ngerti Upstash Redis kalau mau nyimpen history chat (opsional), QStash wajib biar bisa "menipu" ketentuan 3 detik balasan Discord (deferred type 5, queue QStash pas AI proses jawaban), masukin variabel ENV langsung di dashboard hosting, troubleshoot (bisa pakai AI gratisan, asal mau comply sama usage limit mereka), dan yang pasti minimal ngerti struktur kodenya dulu (download `.zip` repo ini, lempar ke AI, suruh jelasin apa aja yang perlu diubah).
