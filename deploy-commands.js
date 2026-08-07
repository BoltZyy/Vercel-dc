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
    ],
  },
  {
    name: 'model',
    description: '[Owner] Lihat status model AI yang aktif',
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
