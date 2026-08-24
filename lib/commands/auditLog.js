'use strict';

const { InteractionResponseType } = require('discord-interactions');
const { isOwner } = require('../permissions');
const { getAuditLog } = require('../redis');

/* =========================================================================
 * /audit-log {tipe?} — timeline gabungan: block, unblock, say, warn, dan
 * error. Owner-only, instan (baca dari Redis, tidak panggil AI).
 * ========================================================================= */

const TYPE_EMOJI = {
  block: '🚫',
  unblock: '✅',
  say: '📢',
  warn: '⚠️',
  error: '❌',
};

function formatEntry(entry) {
  const emoji = TYPE_EMOJI[entry.type] || '•';
  const time = entry.at ? new Date(entry.at).toLocaleString('id-ID') : '?';

  switch (entry.type) {
    case 'block':
      return `${emoji} **Block** — <@${entry.userId}> oleh <@${entry.moderatorId}> (${entry.reason || 'no reason'}) — _${time}_`;
    case 'unblock':
      return `${emoji} **Unblock** — <@${entry.userId}> oleh <@${entry.moderatorId}> — _${time}_`;
    case 'say':
      return `${emoji} **Say** — <@${entry.userId}> di <#${entry.channelId}>: "${entry.content}" — _${time}_`;
    case 'warn':
      return `${emoji} **Warn** — <@${entry.userId}> oleh <@${entry.moderatorId}> (${entry.reason}) — _${time}_`;
    case 'error':
      return `${emoji} **Error** — \`${entry.source}\`: ${entry.message?.slice(0, 100)} — _${time}_`;
    default:
      return `${emoji} ${entry.type} — _${time}_`;
  }
}

async function handleAuditLog(interaction, res) {
  if (!isOwner(interaction)) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❌ Command ini khusus Owner.' },
    });
    return;
  }

  const options = interaction.data?.options || [];
  const tipeOpt = options.find((o) => o.name === 'tipe');
  const type = tipeOpt?.value; // undefined | 'block' | 'unblock' | 'say' | 'warn' | 'error'

  const entries = await getAuditLog({ limit: 15, type });

  if (!entries.length) {
    res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '📭 Belum ada entri audit log.' },
    });
    return;
  }

  const lines = entries.map(formatEntry);

  res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: `📋 Audit Log${type ? ` — ${type}` : ''} (${entries.length} entri terbaru)`,
          color: 0x5865f2,
          description: lines.join('\n'),
        },
      ],
    },
  });
}

module.exports = { handleAuditLog };
