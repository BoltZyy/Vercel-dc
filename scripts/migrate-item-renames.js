'use strict';

/* =========================================================================
 * MIGRATE-ITEM-RENAMES — jalankan SEKALI dari Termux (mirip
 * setup-price-schedule.js) untuk memindahkan kuantitas item consumable
 * lama ke nama baru di SEMUA hash trading:inventory:{userId} yang ada.
 *
 *   LEAK_TOKEN     -> INSIDER_PASS
 *   BANK_PASSCARD  -> ADVANCED_PASSCARD
 *
 * Redis TIDAK punya HRENAME native, jadi migrasi ini per-key melakukan:
 *   1. HGET field lama
 *   2. Kalau ada isinya (>0): HINCRBY field baru sejumlah itu (bukan
 *      HSET langsung — supaya kalau entah kenapa field baru SUDAH ada
 *      isinya duluan sebelum migrasi dijalankan, jumlahnya DITAMBAHKAN,
 *      bukan ditimpa dan hilang)
 *   3. HDEL field lama
 *
 * AMAN dijalankan berkali-kali (idempotent) — begitu field lama sudah
 * tidak ada isinya (sudah ke-HDEL di run sebelumnya), run berikutnya
 * otomatis skip user itu tanpa efek apa pun.
 *
 * TIDAK otomatis jalan begitu kode di-deploy ke Vercel — ini script
 * terpisah yang HARUS dijalankan manual sekali setelah deploy kode
 * rename (lib/shopItems.js, lib/commands/trading/shop.js, bank.js).
 *
 * Jalankan:
 *   UPSTASH_REDIS_REST_URL=xxx UPSTASH_REDIS_REST_TOKEN=xxx node scripts/migrate-item-renames.js
 * ========================================================================= */

const { Redis } = require('@upstash/redis');

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error('❌ Missing UPSTASH_REDIS_REST_URL atau UPSTASH_REDIS_REST_TOKEN di environment.');
  process.exit(1);
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const RENAME_MAP = [
  { oldField: 'LEAK_TOKEN', newField: 'INSIDER_PASS' },
  { oldField: 'BANK_PASSCARD', newField: 'ADVANCED_PASSCARD' },
];

async function migrateKey(key) {
  let migratedAny = false;

  for (const { oldField, newField } of RENAME_MAP) {
    const oldQty = await redis.hget(key, oldField);
    const cleanedQty = Number(oldQty);

    if (!oldQty || !Number.isFinite(cleanedQty) || cleanedQty <= 0) {
      continue; // tidak ada isinya di field lama untuk key ini, skip
    }

    await redis.hincrby(key, newField, cleanedQty);
    await redis.hdel(key, oldField);
    console.log(`  ${key}: ${oldField} (${cleanedQty}) -> ${newField}`);
    migratedAny = true;
  }

  return migratedAny;
}

async function run() {
  console.log('🔄 Memulai migrasi rename item consumable...\n');

  const pattern = 'trading:inventory:*';
  let cursor = 0;
  let totalKeysScanned = 0;
  let totalKeysMigrated = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: pattern, count: 100 });
    cursor = Number(nextCursor);
    totalKeysScanned += keys.length;

    for (const key of keys) {
      const migrated = await migrateKey(key);
      if (migrated) totalKeysMigrated++;
    }
  } while (cursor !== 0);

  console.log(`\n✅ Migrasi selesai. ${totalKeysScanned} user inventory di-scan, ${totalKeysMigrated} di antaranya ada perubahan.`);
}

run().catch((err) => {
  console.error('❌ Migrasi gagal:', err);
  process.exit(1);
});
