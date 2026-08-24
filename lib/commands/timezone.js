'use strict';

const { InteractionResponseType } = require('discord-interactions');

/* =========================================================================
 * /timezone convert {waktu} {dari} {ke} — konversi waktu antar zona.
 * Coba cocokkan nama populer dulu (WIB, Tokyo, London, dst), fallback ke
 * kode IANA standar (Asia/Jakarta, Europe/London) kalau tidak ketemu.
 * Instan, murni Intl API bawaan Node, tanpa AI/Redis.
 * ========================================================================= */

// Alias nama populer -> kode IANA. Daftar tidak lengkap secara global,
// fokus ke zona yang paling sering dipakai (Indonesia + kota besar dunia).
const TIMEZONE_ALIASES = {
  wib: 'Asia/Jakarta',
  wita: 'Asia/Makassar',
  wit: 'Asia/Jayapura',
  jakarta: 'Asia/Jakarta',
  london: 'Europe/London',
  tokyo: 'Asia/Tokyo',
  'new york': 'America/New_York',
  newyork: 'America/New_York',
  'los angeles': 'America/Los_Angeles',
  losangeles: 'America/Los_Angeles',
  singapore: 'Asia/Singapore',
  sydney: 'Australia/Sydney',
  paris: 'Europe/Paris',
  dubai: 'Asia/Dubai',
  beijing: 'Asia/Shanghai',
  shanghai: 'Asia/Shanghai',
  seoul: 'Asia/Seoul',
  moscow: 'Europe/Moscow',
  utc: 'UTC',
  gmt: 'UTC',
};

function resolveTimezone(input) {
  const normalized = input.trim().toLowerCase();
  if (TIMEZONE_ALIASES[normalized]) return TIMEZONE_ALIASES[normalized];

  // Fallback: anggap input sudah berupa kode IANA (Asia/Jakarta, dst).
  // Validasi dengan coba format — kalau gagal, Intl akan throw.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.trim() });
    return input.trim();
  } catch (err) {
    return null;
  }
}

// Format waktu input: "HH:mm" saja (tanggal diasumsikan hari ini di zona asal).
const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

async function handleTimezoneConvert(interaction, res) {
  const options = interaction.data?.options || [];
  const waktuOpt = options.find((o) => o.name === 'waktu');
  const dariOpt = options.find((o) => o.name === 'dari');
  const keOpt = options.find((o) => o.name === 'ke');

  const waktuInput = (waktuOpt?.value || '').trim();
  const dariInput = (dariOpt?.value || '').trim();
  const keInput = (keOpt?.value || '').trim();

  const match = waktuInput.match(TIME_PATTERN);
  if (!match) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Format waktu harus `HH:mm`, contoh: `14:30`.' },
    });
    return;
  }

  const dariTz = resolveTimezone(dariInput);
  const keTz = resolveTimezone(keInput);

  if (!dariTz) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ Zona waktu "${dariInput}" tidak dikenali. Coba nama populer (WIB, Tokyo, London) atau kode IANA (Asia/Jakarta).` },
    });
    return;
  }
  if (!keTz) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ Zona waktu "${keInput}" tidak dikenali. Coba nama populer (WIB, Tokyo, London) atau kode IANA (Asia/Jakarta).` },
    });
    return;
  }

  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour > 23 || minute > 59) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Jam harus 0-23, menit harus 0-59.' },
    });
    return;
  }

  try {
    // Trik konversi: bikin Date "hari ini jam X:Y" DIANGGAP UTC, cari
    // selisih offset zona asal terhadap UTC, lalu geser sesuai selisih
    // itu supaya representasi UTC-nya benar, baru format ke zona tujuan.
    const now = new Date();
    const baseUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute));

    const offsetAtZone = (date, timeZone) => {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      const parts = dtf.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
      const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour === '24' ? 0 : parts.hour, parts.minute, parts.second);
      return (asUTC - date.getTime()) / 60000; // menit
    };

    const dariOffsetMinutes = offsetAtZone(baseUTC, dariTz);
    const actualUTC = new Date(baseUTC.getTime() - dariOffsetMinutes * 60000);

    const formatter = new Intl.DateTimeFormat('id-ID', {
      timeZone: keTz,
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: 'short',
      hour12: false,
    });
    const resultText = formatter.format(actualUTC);

    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `🕐 **${waktuInput}** (${dariInput}) → **${resultText}** (${keInput})`,
      },
    });
  } catch (err) {
    console.error('[handleTimezoneConvert] error:', err.message);
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Gagal mengonversi waktu. Cek lagi format zona waktunya.' },
    });
  }
}

module.exports = { handleTimezoneConvert };
