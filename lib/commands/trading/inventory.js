'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const { getInventory, getCosmetics } = require('../../trading');
const { getShopItem } = require('../../shopItems');
const { getUserShares, getEquippedBuffTitle, BUFF_TITLES, SHARE_TO_BUFF_TITLE } = require('../../gachaEngine');

/* =========================================================================
 * /inventory — 3 tab (Buff Titles, Consumables/Passes, Koleksi Mewah),
 * navigasi via tombol (MESSAGE_COMPONENT), bukan dropdown — Discord
 * button lebih sederhana untuk 3 pilihan tetap dibanding select menu,
 * dan proyek ini belum pernah pakai select menu sebelumnya.
 *
 * PRIVASI: response SELALU ephemeral (flags: 64) — inventory itu data
 * pribadi, tidak pantas terlihat semua orang di channel. custom_id
 * tombol menyertakan userId pemilik asli, divalidasi di handler supaya
 * cuma pemilik yang bisa klik tombol tab-nya sendiri (orang lain yang
 * somehow bisa lihat pesan ephemeral ini — walau secara teknis harusnya
 * tidak bisa — tetap tidak akan bisa berinteraksi).
 *
 * custom_id format: "inventory:{tab}:{ownerId}"
 *   tab: 'buff' | 'consumable' | 'luxury'
 * ========================================================================= */

const TABS = ['buff', 'consumable', 'luxury'];

const TAB_LABELS = {
  buff: '🏆 Buff Titles',
  consumable: '📦 Consumables',
  luxury: '🏝️ Koleksi Mewah',
};

function buildTabButtons(activeTab, ownerId) {
  return [
    {
      type: 1, // ACTION_ROW
      components: TABS.map((tab) => ({
        type: 2, // BUTTON
        style: tab === activeTab ? 1 : 2, // PRIMARY kalau aktif, SECONDARY kalau tidak
        label: TAB_LABELS[tab],
        custom_id: `inventory:${tab}:${ownerId}`,
        disabled: tab === activeTab, // tab yang lagi aktif tidak perlu diklik ulang
      })),
    },
  ];
}

/**
 * buildBuffTab — daftar SEMUA buff title yang share-nya dimiliki user,
 * tandai mana yang sedang di-equip. Beda dari /equip yang cuma
 * menampilkan title yang BISA dipasang — ini murni informasi.
 */
async function buildBuffTab(userId) {
  const [shares, equippedTitleId] = await Promise.all([
    getUserShares(userId),
    getEquippedBuffTitle(userId),
  ]);

  if (!shares || Object.keys(shares).length === 0) {
    return 'Kamu belum punya Founder Share apa pun. Coba `/gacha` untuk kesempatan dapat Share eksklusif!';
  }

  const lines = Object.keys(shares)
    .filter((shareId) => shares[shareId] > 0)
    .map((shareId) => {
      const titleId = SHARE_TO_BUFF_TITLE[shareId];
      const title = BUFF_TITLES[titleId];
      const equippedMark = titleId === equippedTitleId ? ' ✅ **(Aktif)**' : '';
      return `**${shareId}** [${shares[shareId]}x] → ${title.name}${equippedMark}\n_${title.description}_`;
    });

  return lines.join('\n\n') + '\n\nPakai `/equip title:<nama>` untuk ganti Buff Title aktif.';
}

/**
 * buildConsumableTab — semua item type 'consumable' dari inventory.
 */
async function buildConsumableTab(userId) {
  const inventory = await getInventory(userId);
  if (inventory === null) return '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).';

  const lines = Object.keys(inventory)
    .filter((id) => inventory[id] > 0)
    .map((id) => ({ id, def: getShopItem(id), qty: inventory[id] }))
    .filter((entry) => entry.def && entry.def.type === 'consumable')
    .map((entry) => `${entry.def.name} x${entry.qty}`);

  if (lines.length === 0) {
    return 'Kamu belum punya consumable/pass apa pun. Cek `/shop kategori:utility` untuk beli.';
  }
  return lines.join('\n');
}

/**
 * buildLuxuryTab — semua item type 'luxury' dari inventory. Logic SAMA
 * PERSIS dengan field "🏝️ Koleksi Mewah" di /portfolio, cuma dipindah
 * ke tab sendiri di sini.
 */
async function buildLuxuryTab(userId) {
  const inventory = await getInventory(userId);
  if (inventory === null) return '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).';

  const lines = Object.keys(inventory)
    .filter((id) => inventory[id] > 0)
    .map((id) => ({ id, def: getShopItem(id), qty: inventory[id] }))
    .filter((entry) => entry.def && entry.def.type === 'luxury')
    .map((entry) => `${entry.def.name}${entry.qty > 1 ? ` x${entry.qty}` : ''}`);

  if (lines.length === 0) {
    return 'Belum ada koleksi mewah. Cek `/shop` untuk lihat katalog luxury items.';
  }
  return lines.join(', ');
}

async function buildTabContent(tab, userId) {
  if (tab === 'buff') return buildBuffTab(userId);
  if (tab === 'consumable') return buildConsumableTab(userId);
  if (tab === 'luxury') return buildLuxuryTab(userId);
  return '⚠️ Tab tidak dikenal.';
}

async function buildInventoryEmbed(tab, userId) {
  const cosmetics = await getCosmetics(userId);
  const content = await buildTabContent(tab, userId);

  return {
    embeds: [
      {
        title: `🎒 Inventory — ${TAB_LABELS[tab]}`,
        color: cosmetics?.color ? parseInt(cosmetics.color, 16) || 0x9b59b6 : 0x9b59b6,
        description: content,
      },
    ],
    components: buildTabButtons(tab, userId),
  };
}

async function handleInventory(interaction, res) {
  const userId = getInvokerId(interaction);
  const embedData = await buildInventoryEmbed('buff', userId);

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { ...embedData, flags: 64 }, // 64 = EPHEMERAL, inventory itu data pribadi
  });
}

/**
 * handleInventoryTabSwitch — dipanggil dari api/index.js saat
 * MESSAGE_COMPONENT custom_id berformat "inventory:{tab}:{ownerId}".
 * Update pesan yang sama (type 7 UPDATE_MESSAGE) ke tab yang diklik.
 */
async function handleInventoryTabSwitch(interaction, res) {
  const customId = interaction.data?.custom_id || '';
  const match = customId.match(/^inventory:(buff|consumable|luxury):(.+)$/);

  if (!match) {
    res.status(200).json({ type: 6 }); // DEFERRED_UPDATE_MESSAGE, aman minimal
    return;
  }

  const [, tab, ownerId] = match;
  const clickerId = getInvokerId(interaction);

  // Validasi kepemilikan — HANYA pemilik asli boleh ganti tab. Orang
  // lain yang klik (seharusnya tidak mungkin karena pesan ephemeral,
  // tapi dijaga eksplisit) dapat pesan privat sendiri tanpa mengubah
  // apa pun.
  if (clickerId !== ownerId) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Ini bukan inventory kamu.', flags: 64 },
    });
    return;
  }

  const embedData = await buildInventoryEmbed(tab, ownerId);

  // Flags (ephemeral) TIDAK diulang di sini — Discord API tidak
  // mengizinkan mengubah flags lewat UPDATE_MESSAGE, dan flags dari
  // pesan asli otomatis tetap berlaku untuk semua update selanjutnya.
  res.status(200).json({
    type: 7, // UPDATE_MESSAGE
    data: embedData,
  });
}

module.exports = { handleInventory, handleInventoryTabSwitch };
