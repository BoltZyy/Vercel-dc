'use strict';

/* =========================================================================
 * SETUP-PRICE-SCHEDULE — jalankan SEKALI dari Termux (mirip
 * deploy-commands.js) untuk mendaftarkan QStash Schedule (cron recurring)
 * yang memanggil /api/process-price-update tiap 30 menit.
 *
 * TIDAK otomatis jalan begitu kode di-deploy ke Vercel — schedule QStash
 * didaftarkan terpisah lewat API mereka, bukan lewat kode yang jalan.
 *
 * Jalankan:
 *   QSTASH_TOKEN=xxx QSTASH_URL=xxx PUBLIC_BASE_URL=xxx node scripts/setup-price-schedule.js
 *
 * Kalau mau ubah interval nanti, hapus schedule lama dulu lewat Upstash
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

const CRON_EXPRESSION = '*/30 * * * *'; // tiap 30 menit

async function main() {
  const client = new Client({ token: QSTASH_TOKEN, baseUrl: QSTASH_URL });
  const destination = `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/process-price-update`;

  console.log(`Mendaftarkan schedule ke ${destination}, cron: ${CRON_EXPRESSION}...`);

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
