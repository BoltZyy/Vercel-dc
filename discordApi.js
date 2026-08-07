'use strict';

const { CONFIG } = require('./config');

/* =========================================================================
 * DISCORD REST HELPERS — tanpa discord.js, murni fetch native ke
 * Discord API v10. Dipakai untuk follow-up message setelah deferred
 * response (Type 5), dan untuk edit/patch webhook message.
 * ========================================================================= */

const DISCORD_API_BASE = 'https://discord.com/api/v10';

function webhookUrl(applicationId, interactionToken) {
  return `${DISCORD_API_BASE}/webhooks/${applicationId}/${interactionToken}`;
}

/**
 * editOriginalInteractionResponse — PATCH ke @original, dipakai untuk
 * mengisi hasil final setelah DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE.
 */
async function editOriginalInteractionResponse(interactionToken, payload) {
  const url = `${webhookUrl(CONFIG.DISCORD_APPLICATION_ID, interactionToken)}/messages/@original`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Discord PATCH @original failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  return res.json().catch(() => null);
}

/**
 * sendFollowupMessage — POST pesan tambahan (dipakai untuk chunk ke-2+
 * saat balasan AI melebihi limit karakter Discord).
 */
async function sendFollowupMessage(interactionToken, payload) {
  const url = webhookUrl(CONFIG.DISCORD_APPLICATION_ID, interactionToken);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Discord POST followup failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  return res.json().catch(() => null);
}

module.exports = { editOriginalInteractionResponse, sendFollowupMessage };
