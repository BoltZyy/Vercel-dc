'use strict';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!DISCORD_TOKEN || !APPLICATION_ID || !GUILD_ID) {
  console.error('❌ Missing DISCORD_TOKEN, DISCORD_APPLICATION_ID, atau DISCORD_GUILD_ID.');
  process.exit(1);
}

async function main() {
  const url = `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`;
  console.log(`Menghapus SEMUA command di scope guild ${GUILD_ID}...`);
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([]),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`❌ Gagal (${res.status}):`, errText);
    process.exit(1);
  }
  console.log('✅ Semua command di scope guild berhasil dihapus. Command global tetap aktif.');
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err);
  process.exit(1);
});
