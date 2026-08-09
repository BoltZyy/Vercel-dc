'use strict';

const { CONFIG } = require('./config');

/* =========================================================================
 * PERMISSIONS — pengecekan akses command sensitif.
 *
 * Dua tingkat:
 * 1. isOwner        -> cocok dengan OWNER_ID (User ID Discord kamu),
 *                      berlaku di SEMUA server, tanpa syarat apa pun.
 * 2. hasManageMessages -> permission Discord bawaan (Manage Messages),
 *                      berlaku HANYA di server tempat user itu punya
 *                      izin tersebut (bukan lintas server).
 *
 * Discord mengirim permission pemanggil command sebagai bitfield string
 * di interaction.member.permissions. Bit ManageMessages = 1 << 13.
 * Referensi: https://discord.com/developers/docs/topics/permissions
 * ========================================================================= */

const PERMISSION_BITS = {
  MANAGE_MESSAGES: 1n << 13n,
  MANAGE_GUILD: 1n << 5n,
  ADMINISTRATOR: 1n << 3n,
};

function getInvokerId(interaction) {
  return interaction.member?.user?.id || interaction.user?.id || null;
}

function isOwner(interaction) {
  const invokerId = getInvokerId(interaction);
  return Boolean(invokerId) && invokerId === CONFIG.OWNER_ID;
}

/**
 * hasPermission — cek apakah pemanggil command punya bit permission
 * tertentu di server ini. Hanya valid untuk interaction yang terjadi
 * di dalam guild (server) — DM tidak punya member.permissions.
 */
function hasPermission(interaction, bit) {
  const permsStr = interaction.member?.permissions;
  if (!permsStr) return false;
  try {
    const perms = BigInt(permsStr);
    // ADMINISTRATOR selalu punya semua izin lain secara implisit.
    if ((perms & PERMISSION_BITS.ADMINISTRATOR) === PERMISSION_BITS.ADMINISTRATOR) {
      return true;
    }
    return (perms & bit) === bit;
  } catch (err) {
    return false;
  }
}

function hasManageMessages(interaction) {
  return hasPermission(interaction, PERMISSION_BITS.MANAGE_MESSAGES);
}

/**
 * canUseSay — Owner (di server manapun) ATAU user dengan ManageMessages
 * di server tempat command ini dipanggil.
 */
function canUseSay(interaction) {
  return isOwner(interaction) || hasManageMessages(interaction);
}

module.exports = {
  PERMISSION_BITS,
  getInvokerId,
  isOwner,
  hasPermission,
  hasManageMessages,
  canUseSay,
};
