'use strict';

/* =========================================================================
 * DEPLOY-COMMANDS — Registrasi Slash Commands ke Discord API.
 * Jalankan manual sekali (atau tiap ada perubahan command):
 *   node deploy-commands.js
 *
 * Butuh ENV: DISCORD_TOKEN, DISCORD_APPLICATION_ID
 * Opsional: DISCORD_GUILD_ID (kalau diisi -> register per-guild, instan,
 *           cocok untuk testing. Kalau kosong -> register global, bisa
 *           delay sampai 1 jam propagasi ke semua server).
 * ========================================================================= */

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID; // optional

if (!DISCORD_TOKEN || !APPLICATION_ID) {
  console.error('❌ Missing DISCORD_TOKEN or DISCORD_APPLICATION_ID in environment.');
  process.exit(1);
}

const commands = [
  {
    name: 'tanya',
    description: 'Chat dengan AI (Saucepan Engine)',
    type: 1,
    options: [
      {
        name: 'pesan',
        description: 'Pesan atau pertanyaan yang ingin kamu tanyakan ke AI',
        type: 3, // STRING
        required: true,
      },
      {
        name: 'mode',
        description: 'Gaya jawaban (default: normal)',
        type: 3,
        required: false,
        choices: [
          { name: 'Singkat', value: 'singkat' },
          { name: 'Detail', value: 'detail' },
          { name: 'Kreatif', value: 'kreatif' },
        ],
      },
    ],
  },
  {
    name: 'translate',
    description: 'Terjemahkan teks ke bahasa lain',
    type: 1,
    options: [
      {
        name: 'teks',
        description: 'Teks yang mau diterjemahkan',
        type: 3,
        required: true,
      },
      {
        name: 'bahasa',
        description: 'Bahasa tujuan (default: Inggris)',
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: 'ringkas',
    description: 'Ringkas teks panjang jadi poin-poin inti',
    type: 1,
    options: [
      {
        name: 'teks',
        description: 'Teks yang mau diringkas',
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: 'model',
    description: '[Owner] Lihat atau ganti model AI yang aktif',
    type: 1,
    options: [
      {
        name: 'set',
        description: 'Nama model baru untuk diaktifkan, atau "default" untuk kembali ke ENV',
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: 'avatar',
    description: 'Tampilkan avatar user',
    type: 1,
    options: [
      {
        name: 'user',
        description: 'User yang avatarnya mau dilihat (default: diri sendiri)',
        type: 6, // USER
        required: false,
      },
    ],
  },
  {
    name: 'userinfo',
    description: 'Lihat info dasar akun user',
    type: 1,
    options: [
      {
        name: 'user',
        description: 'User yang mau dilihat infonya (default: diri sendiri)',
        type: 6, // USER
        required: false,
      },
    ],
  },
  {
    name: 'ping',
    description: 'Cek bot hidup & latency',
    type: 1,
  },
  {
    name: 'say',
    description: '[Moderator+] Kirim pesan atas nama bot',
    type: 1,
    options: [
      {
        name: 'pesan',
        description: 'Isi pesan yang mau dikirim',
        type: 3,
        required: true,
      },
      {
        name: 'channel',
        description: 'Channel tujuan (default: channel ini)',
        type: 7, // CHANNEL
        required: false,
      },
    ],
  },
  {
    name: 'block',
    description: '[Owner] Blokir user dari fitur bot',
    type: 1,
    options: [
      {
        name: 'user',
        description: 'User yang mau diblokir',
        type: 6,
        required: true,
      },
      {
        name: 'alasan',
        description: 'Alasan blokir (opsional)',
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: 'unblock',
    description: '[Owner] Buka blokir user',
    type: 1,
    options: [
      {
        name: 'user',
        description: 'User yang mau dibuka blokirnya',
        type: 6,
        required: true,
      },
    ],
  },
  {
    name: 'blocklist',
    description: '[Owner] Lihat daftar user yang sedang diblokir',
    type: 1,
  },
  {
    name: 'maintenance',
    description: '[Owner] Cek/ubah mode maintenance bot',
    type: 1,
    options: [
      {
        name: 'status',
        description: 'Set maintenance mode ON atau OFF (kosongkan untuk cek status saat ini)',
        type: 3,
        required: false,
        choices: [
          { name: 'ON', value: 'on' },
          { name: 'OFF', value: 'off' },
        ],
      },
    ],
  },
  {
    name: 'reset',
    description: 'Reset riwayat percakapan AI di channel ini',
    type: 1,
  },
  {
    name: 'riwayat',
    description: 'Lihat ringkasan riwayat percakapan AI di channel ini',
    type: 1,
  },
  {
    name: 'stats',
    description: '[Owner] Lihat statistik pemakaian bot hari ini',
    type: 1,
  },
  {
    name: 'status',
    description: '[Owner] Cek kesehatan Redis, QStash, dan AI Gateway',
    type: 1,
  },
];

async function main() {
  const url = GUILD_ID
    ? `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`
    : `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`;

  console.log(`Registering ${commands.length} command(s) to ${GUILD_ID ? `guild ${GUILD_ID}` : 'GLOBAL scope'}...`);

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`❌ Failed to register commands (${res.status}):`, errText);
    process.exit(1);
  }

  const data = await res.json();
  console.log(`✅ Successfully registered ${data.length} command(s):`);
  data.forEach((c) => console.log(`   • /${c.name} — ${c.description}`));
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err);
  process.exit(1);
});
