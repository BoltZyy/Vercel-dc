'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const {
  checkAndHandleOverdueLoan,
  executeShopPurchase,
  consumeInventoryItem,
  getInventory,
  formatZYC,
} = require('../../trading');
const { SHOP_ITEM_IDS, getShopItem, getShopItemsByCategory } = require('../../shopItems');
const { isDevBypassed } = require('../../devHelper');
const {
  getLeakCooldownStatus,
  markLeakUsed,
  resetLeakCooldown,
  getMacroSentiment,
  getAlphaIntel,
} = require('../../leakEngine');

/* =========================================================================
 * /shop            — lihat katalog (baca statis, tidak sentuh Redis)
 * /shop-buy {item} — checkout. Selalu cek nunggak dulu (konsisten dengan
 *                    semua command trading lain), lalu satu jalur resmi
 *                    executeShopPurchase() di trading.js.
 * /leak {buka_intel?} — dual-layer (lihat lib/leakEngine.js):
 *                    - Sentimen Makro: GRATIS, selalu tampil, cooldown
 *                      15 menit per-user.
 *                    - Alpha Intel: opsional, konsumsi 1x INSIDER_PASS,
 *                      SEKALIGUS reset cooldown (boleh langsung /leak
 *                      lagi tanpa nunggu).
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
  const descText = item.description ? `\n  _${item.description}_` : '';
  return `\`${item.id}\` — ${item.name} — 💵 ${item.price.toLocaleString('id-ID')} ZYC${tagText}${descText}`;
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
  const bypassed = await isDevBypassed(userId);

  const options = interaction.data?.options || [];
  const bukaIntelOpt = options.find((o) => o.name === 'buka_intel');
  const wantsIntel = bukaIntelOpt?.value === true;

  // Cooldown dicek DULUAN, sebelum apa pun lain — kecuali user berniat
  // pakai INSIDER_PASS (yang FUNGSINYA memang buat bypass cooldown ini)
  // ATAU dev bypass mode sedang aktif. Kalau wantsIntel true, cooldown
  // TIDAK menghalangi sama sekali; validasi kepemilikan INSIDER_PASS
  // tetap jalan normal di bawah.
  if (!wantsIntel && !bypassed) {
    const cooldownStatus = await getLeakCooldownStatus(userId);
    if (cooldownStatus.onCooldown) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `⏳ /leak masih cooldown. Bisa dipakai lagi <t:${Math.floor(cooldownStatus.nextAvailableAt / 1000)}:R>, atau pakai \`buka_intel:true\` (konsumsi 1x INSIDER_PASS) untuk langsung buka sekarang.` },
      });
      return;
    }
  }

  const macro = await getMacroSentiment();
  const embedFields = [
    { name: macro.headline, value: macro.body, inline: false },
  ];

  let usedInsiderPass = false;
  let consumeResult = null;

  if (wantsIntel) {
    const inventory = await getInventory(userId);
    if (inventory === null) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '⚠️ Sistem trading tidak tersedia (Redis tidak dikonfigurasi).' },
      });
      return;
    }
    if ((inventory.INSIDER_PASS || 0) <= 0) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '⚠️ Kamu belum punya 🕵️ Insider Pass untuk buka Alpha Intel. Beli dulu lewat `/shop-buy item:INSIDER_PASS`, atau panggil `/leak` tanpa `buka_intel` untuk lihat sentimen makro gratis saja.' },
      });
      return;
    }

    consumeResult = await consumeInventoryItem(userId, 'INSIDER_PASS');
    if (!consumeResult.ok) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `⚠️ ${consumeResult.error}` },
      });
      return;
    }

    usedInsiderPass = true;
    const alpha = await getAlphaIntel();
    embedFields.push({ name: alpha.headline, value: alpha.body, inline: false });
    embedFields.push({ name: '📦 Sisa Insider Pass', value: `${consumeResult.newQuantity}`, inline: false });

    // INSIDER_PASS mereset cooldown sepenuhnya — bukan cuma "izinkan
    // sekali ini", tapi user boleh langsung /leak lagi tanpa nunggu.
    await resetLeakCooldown(userId);
  } else {
    embedFields.push({
      name: '🔒 Alpha Intel (Terkunci)',
      value: 'Pakai `/leak buka_intel:true` (konsumsi 1x 🕵️ Insider Pass) untuk buka info spesifik per-koin.',
      inline: false,
    });
    // Dev bypass: JANGAN set cooldown sama sekali — supaya begitu
    // bypass dimatikan lagi, tidak ada cooldown "warisan" dari sesi
    // testing yang tiba-tiba berlaku ke pemakaian normal berikutnya.
    if (!bypassed) {
      await markLeakUsed(userId);
    }
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: '📰 Market Intel',
          color: usedInsiderPass ? 0x9b59b6 : 0x3498db,
          fields: embedFields,
        },
      ],
    },
  });
}

module.exports = { handleShop, handleShopBuy, handleLeak };
