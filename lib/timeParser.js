'use strict';

/* =========================================================================
 * TIME PARSER — dipakai /remind. Dukung 2 format:
 * - Relatif: "10m", "2h", "1d", "30s" (angka + satuan s/m/h/d)
 * - Absolut: "2026-08-22 15:00" atau "2026-08-22T15:00" (WIB/UTC+7 asumsi,
 *   lihat catatan di parseAbsolute)
 * ========================================================================= */

const RELATIVE_PATTERN = /^(\d+)\s*(s|m|h|d)$/i;
const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };

// Timezone asumsi untuk format absolut tanpa offset eksplisit.
// WIB = UTC+7. Sesuaikan di sini kalau user-base bot pindah zona waktu.
const ASSUMED_TZ_OFFSET_MINUTES = 7 * 60;

function parseRelative(input) {
  const match = input.match(RELATIVE_PATTERN);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  return amount * UNIT_SECONDS[unit];
}

function parseAbsolute(input) {
  // Wajib match pola tanggal eksplisit dulu sebelum dicoba parse Date —
  // supaya string sembarang (misal "besok") tidak lolos ke new Date()
  // yang kadang menghasilkan Invalid Date secara diam-diam salah, atau
  // di beberapa environment malah "berhasil" parse dengan cara tak terduga.
  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?$/;
  const trimmedInput = input.trim();
  if (!DATE_PATTERN.test(trimmedInput)) return null;

  const normalized = trimmedInput.replace(' ', 'T');
  const hasExplicitOffset = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized);
  const isoString = hasExplicitOffset ? normalized : `${normalized}${normalized.split(':').length === 2 ? ':00' : ''}`;

  const parsed = hasExplicitOffset ? new Date(isoString) : new Date(`${isoString}Z`);
  if (isNaN(parsed.getTime())) return null;

  if (!hasExplicitOffset) {
    // Input dianggap waktu lokal WIB -> geser mundur sesuai offset supaya
    // hasil akhirnya representasi UTC yang benar.
    parsed.setMinutes(parsed.getMinutes() - ASSUMED_TZ_OFFSET_MINUTES);
  }
  return parsed;
}

/**
 * parseReminderTime — parse input {waktu} dari /remind.
 * @returns {{ ok: true, delaySeconds: number, targetDate: Date } | { ok: false, error: string }}
 */
function parseReminderTime(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Waktu tidak boleh kosong.' };
  }

  // Coba format relatif dulu (lebih umum & sering dipakai).
  const relativeSeconds = parseRelative(trimmed);
  if (relativeSeconds !== null) {
    if (relativeSeconds < 10) {
      return { ok: false, error: 'Minimal 10 detik dari sekarang.' };
    }
    if (relativeSeconds > 30 * 86400) {
      return { ok: false, error: 'Maksimal 30 hari dari sekarang.' };
    }
    const targetDate = new Date(Date.now() + relativeSeconds * 1000);
    return { ok: true, delaySeconds: relativeSeconds, targetDate };
  }

  // Fallback: coba format absolut.
  const targetDate = parseAbsolute(trimmed);
  if (!targetDate) {
    return {
      ok: false,
      error: 'Format tidak dikenali. Pakai relatif (`10m`, `2h`, `1d`) atau absolut (`2026-08-22 15:00`).',
    };
  }

  const delaySeconds = Math.floor((targetDate.getTime() - Date.now()) / 1000);
  if (delaySeconds < 10) {
    return { ok: false, error: 'Waktu yang diminta sudah lewat atau kurang dari 10 detik dari sekarang.' };
  }
  if (delaySeconds > 30 * 86400) {
    return { ok: false, error: 'Maksimal 30 hari dari sekarang.' };
  }

  return { ok: true, delaySeconds, targetDate };
}

module.exports = { parseReminderTime };
