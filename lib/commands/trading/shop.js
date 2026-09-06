'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const {
  checkAndHandleOverdueLoan,
  executeShopPurchase,
  consumeInventoryItem,
  getInventory,
  getActiveEvent,
  formatZYC,
} = require('../../trading');
const { SHOP_ITEM_IDS, getShopItem, getShopItemsByCategory } = require('../../shopItems');

/* =========================================================================
 * /shop            — lihat katalog (baca statis, tidak sentuh Redis)
 * /shop-buy {item} — checkout. Selalu cek nunggak dulu (konsisten dengan
 *                    semua command trading lain), lalu satu jalur resmi
 *                    executeShopPurchase() di trading.js.
 * /leak            — pakai LEAK_TOKEN consumable, intip event pasar aktif.
 *                    Murni READ terhadap getActiveEvent() yang sudah ada
 *                    untuk /market-event — tidak menambah state trading
 *                    baru sama sekali.
 * ========================================================================= */

const CATEGORY_LABELS = {
  utility: '🕵️ Utilitas',
  cosmetic: '🎨 Kosmetik',
  supercar: '🏎️ Supercar & Hypercar',
  superbike: '🏍️ Superbike',
  motorsport: '🏁 Motorsport & Race Cars',
  property: '🏙️ Properti',
  fleet: '🛥️ Fleet Mewah',
  art: '🖼️ Flex-Art & Collectibles',
  ultimate: '🛰️ Ultimate Flex',
};

function formatItemLine(item) {
  const tags = [];
  if (item.requiresDebtFree) tags.push('bebas utang');
  if (typeof item.minReserveCash === 'number') tags.push(`reserve ${item.minReserveCash * 100}%`);
  if (item.requiredItems?.length) tags.push('butuh item lain');
  if (item.requiredCategories?.length) tags.push('butuh kategori lain');
  const tagText = tags.length ? ` _(${tags.join(', ')})_` : '';
  return `\`${item.id}\` — ${item.name} — 💵 ${item.price.toLocaleString('id-ID')} ZYC${tagText}`;
}

async function handleShop(interaction, res) {
  const options = interaction.data?.options || [];
  const categoryOpt = options.find((o) => o.name === 'kategori');
  const category = categoryOpt?.value;

  const categories = category ? [category] : Object.keys(CATEGORY_LABELS);
  const fields = [];
  for (const cat of categories) {
    const items = getShopItemsByCategory(cat);
    if (!items.length) continue;
    fields.push({
      name: CATEGORY_LABELS[cat] || cat,
      value: items.map(formatItemLine).join('\n'),
      inline: false,
    });
  }

  if (!fields.length) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Kategori tidak dikenal atau tidak ada item.' },
    });
    return;
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: '🛍️ Katalog Shop',
          description: 'Pakai `/shop-buy item:<kode>` untuk checkout. Item luxury bersifat PERMANEN, tidak bisa dijual balik.',
          color: 0xf1c40f,
          fields,
        },
      ],
    },
  });
}

async function handleShopBuy(interaction, res) {
  const userId = getInvokerId(interaction);
  await checkAndHandleOverdueLoan(userId);

  const options = interaction.data?.options || [];
  const itemOpt = options.find((o) => o.name === 'item');
  const itemId = itemOpt?.value;

  const item = getShopItem(itemId);
  if (!item) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ Item tidak dikenal. Cek \`/shop\` untuk daftar kode item yang valid.` },
    });
    return;
  }

  const result = await executeShopPurchase(userId, itemId);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: result.error },
    });
    return;
  }

  const lines = [
    `✅ Berhasil checkout **${result.item.name}** seharga 💵 ${formatZYC(result.item.price)} ZYC`,
    `💵 Sisa saldo: ${formatZYC(result.newBalance)} ZYC`,
  ];
  if (result.equipped) {
    lines.push('🎨 Item langsung ter-pasang di profil kamu.');
  } else {
    lines.push(`📦 Total dimiliki: ${result.newQuantity} unit`);
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: '🧾 Checkout Berhasil',
          color: 0x2ecc71,
          description: lines.join('\n'),
        },
      ],
    },
  });
}

async function handleLeak(interaction, res) {
  const userId = getInvokerId(interaction);

  const inventory = await getInventory(userId);
  if (inventory === null) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' },
    });
    return;
  }

  if ((inventory.LEAK_TOKEN || 0) <= 0) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Kamu belum punya 🕵️ Sinyal Orang Dalam. Beli dulu lewat `/shop-buy item:LEAK_TOKEN`.' },
    });
    return;
  }

  const consumeResult = await consumeInventoryItem(userId, 'LEAK_TOKEN');
  if (!consumeResult.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ ${consumeResult.error}` },
    });
    return;
  }

  const activeEvent = await getActiveEvent();
  let content;
  if (!activeEvent) {
    content = '🕵️ Token dipakai... tapi belum ada sinyal apa pun dari pasar saat ini. Coba lagi nanti.';
  } else {
    const direction = activeEvent.direction === 'up' ? '📈 NAIK' : '📉 TURUN';
    const targets = activeEvent.targetAssets?.length ? activeEvent.targetAssets.join(', ') : 'SEMUA aset';
    content = [
      '🕵️ **Sinyal Orang Dalam Diaktifkan**',
      `Ada indikasi pergerakan pasar akan **${direction}** pada: ${targets}.`,
      '_(Ingat: prediksi pengumuman publik SENGAJA acak dan tidak selalu akurat — tapi sinyal ini berasal dari data event aktif sesungguhnya.)_',
      `📦 Sisa token kamu: ${consumeResult.newQuantity}`,
    ].join('\n');
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content },
  });
}

module.exports = { handleShop, handleShopBuy, handleLeak };
