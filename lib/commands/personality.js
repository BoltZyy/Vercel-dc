'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { CONFIG } = require('../config');
const { isOwner } = require('../permissions');
const { getPersonalityOverride, setPersonalityOverride, clearPersonalityOverride } = require('../redis');

/* =========================================================================
 * /personality {set?} — lihat atau ganti kepribadian bot on-the-fly tanpa
 * redeploy. Owner-only, instan (baca/tulis Redis, tidak panggil AI).
 * Pola persis sama dengan /model set.
 *
 * Cuma berlaku untuk /tanya (chat bebas) — /translate dan /ringkas TIDAK
 * terpengaruh karena keduanya butuh output presisi/murni dengan system
 * prompt sendiri (lihat catatan di lib/aiEngine.js).
 *
 * Tanpa opsi 'set'   -> tampilkan personality aktif saat ini.
 * Dengan opsi 'set'  -> "default" mengembalikan ke ENV SYSTEM_PROMPT,
 *                       teks lain disimpan sebagai personality baru.
 * ========================================================================= */

async function handlePersonality(interaction, res) {
  if (!isOwner(interaction)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❌ Command ini khusus Owner.' },
    });
    return;
  }

  const options = interaction.data?.options || [];
  const setOpt = options.find((o) => o.name === 'set');

  if (setOpt) {
    const newPersonality = setOpt.value.trim();
    try {
      if (newPersonality.toLowerCase() === 'default') {
        await clearPersonalityOverride();
        res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '✅ Personality dikembalikan ke default ENV.' },
        });
      } else {
        await setPersonalityOverride(newPersonality);
        res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `✅ Personality bot diubah. Cuma berlaku untuk \`/tanya\` (bukan \`/translate\`/\`/ringkas\`).` },
        });
      }
    } catch (err) {
      res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '⚠️ Gagal mengubah personality (Redis tidak dikonfigurasi atau error).' },
      });
    }
    return;
  }

  // Tanpa opsi 'set' -> tampilkan status saat ini.
  const override = await getPersonalityOverride();
  const activePersonality = override || CONFIG.DEFAULT_SYSTEM_PROMPT;

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: '🎭 Personality Status',
          color: 0x5865f2,
          fields: [
            { name: 'Sumber', value: override ? 'Override (Redis)' : 'Default (ENV)', inline: true },
            { name: 'Isi Aktif', value: `\`\`\`${activePersonality.slice(0, 500)}\`\`\`` },
          ],
          footer: { text: 'Pakai /personality set:<teks> untuk ganti, atau set:default untuk kembali ke ENV.' },
        },
      ],
    },
  });
}

module.exports = { handlePersonality };
