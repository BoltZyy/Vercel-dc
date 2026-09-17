'use strict';

/* =========================================================================
 * SETUP-DIVIDEND-SCHEDULE — jalankan SEKALI dari Termux (mirip
 * setup-price-schedule.js) untuk mendaftarkan QStash Schedule (cron
 * recurring) yang memanggil /api/process-dividend tiap hari jam
 * 00:00 WIB.
 *
 * KONVERSI WAKTU: WIB = UTC+7, jadi 00:00 WIB = 17:00 UTC HARI
 * SEBELUMNYA. QStash Schedule selalu pakai waktu server (UTC), jadi
 * cron '0 17 * * *' berarti jalan jam 17:00 UTC setiap hari — yang
 * dari sudut pandang WIB adalah jam 00:00 keesokan harinya.
 *
 * TIDAK otomatis jalan begitu kode di-deploy ke Vercel — schedule QStash
 * didaftarkan terpisah lewat API mereka, bukan lewat kode yang jalan.
 *
 * Jalankan:
 *   QSTASH_TOKEN=xxx QSTASH_URL=xxx PUBLIC_BASE_URL=xxx node scripts/setup-dividend-schedule.js
 *
 * Kalau mau ubah jam nanti, hapus schedule lama dulu lewat Upstash
 * Console -> QStash -> Schedules, baru jalankan skrip ini lagi.
 * ========================================================================= */

const { Client } = require('@upstash/qstash');

const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
const QSTASH_URL = process.env.QSTASH_URL || 'https://qstash-eu-central-1.upstash.io';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

if (!QSTASH_TOKEN || !PUBLIC_BASE_URL) {
  console.error('❌ Missing QSTASH_TOKEN atau PUBLIC_BASE_URL di environment.');
  process.exit(1);
}

const CRON_EXPRESSION = '0 17 * * *'; // 17:00 UTC = 00:00 WIB keesokan harinya

async function main() {
  const client = new Client({ token: QSTASH_TOKEN, baseUrl: QSTASH_URL });
  const destination = `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/process-dividend`;

  console.log(`Mendaftarkan schedule ke ${destination}, cron: ${CRON_EXPRESSION} (00:00 WIB)...`);

  const result = await client.schedules.create({
    destination,
    cron: CRON_EXPRESSION,
  });

  console.log('✅ Schedule berhasil dibuat!');
  console.log('Schedule ID:', result.scheduleId);
  console.log('');
  console.log('⚠️ SIMPAN Schedule ID ini kalau nanti mau hapus/ubah schedule.');
  console.log('   Untuk hapus manual: Upstash Console -> QStash -> Schedules.');
}

main().catch((err) => {
  console.error('❌ Gagal membuat schedule:', err.message);
  process.exit(1);
});
