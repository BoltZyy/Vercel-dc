'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { getInvokerId } = require('../../permissions');
const {
  BUFF_TITLES,
  getUserShares,
  getEquippedBuffTitle,
  equipBuffTitle,
  SHARE_TO_BUFF_TITLE,
} = require('../../gachaEngine');

/* =========================================================================
 * /equip title:<nama> — pasang Buff Title dari Founder Share yang
 * dimiliki. SLOT TERPISAH dari Shop Title kosmetik (yang auto-equip
 * saat /shop-buy, tidak butuh command manual).
 *
 * Autocomplete: dipanggil dari api/index.js saat interaction.type === 4
 * (APPLICATION_COMMAND_AUTOCOMPLETE, dispatch terpisah dari command
 * biasa type 2). HANYA menampilkan title yang share-nya dimiliki user
 * (bukan semua 3 title selalu muncul).
 * ========================================================================= */

async function handleEquipAutocomplete(interaction, res) {
  const userId = getInvokerId(interaction);
  const shares = await getUserShares(userId);

  const ownedTitleIds = shares
    ? Object.keys(shares).filter((shareId) => shares[shareId] > 0).map((shareId) => SHARE_TO_BUFF_TITLE[shareId]).filter(Boolean)
    : [];

  const choices = ownedTitleIds.map((titleId) => {
    const title = BUFF_TITLES[titleId];
    return { name: title.name, value: title.id };
  });

  // Nilai numerik 8 = APPLICATION_COMMAND_AUTOCOMPLETE_RESULT (dokumentasi
  // resmi Discord). Dipakai literal, BUKAN dari InteractionResponseType
  // package — belum bisa diverifikasi package versi berapa yang jalan di
  // deploy sesungguhnya punya konstanta ini ter-export dengan nama yang
  // sama. Kalau ternyata package sudah punya nama yang benar, ini aman
  // diganti nanti tanpa mengubah behavior.
  res.status(200).json({
    type: 8,
    data: { choices: choices.slice(0, 25) }, // Discord batasi maks 25 choices
  });
}

async function handleEquip(interaction, res) {
  const userId = getInvokerId(interaction);
  const options = interaction.data?.options || [];
  const titleOpt = options.find((o) => o.name === 'title');

  const titleId = titleOpt?.value;
  if (!titleId) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '⚠️ Pilih title dari daftar yang muncul saat mengetik.' },
    });
    return;
  }

  const result = await equipBuffTitle(userId, titleId);
  if (!result.ok) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: result.error },
    });
    return;
  }

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: '✅ Buff Title Dipasang',
          color: 0x2ecc71,
          description: `**${result.title.name}** sekarang aktif.\n_${result.title.description}_`,
        },
      ],
    },
  });
}

module.exports = { handleEquip, handleEquipAutocomplete };
