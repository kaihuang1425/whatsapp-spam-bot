'use strict';

const { findParticipant, serialized } = require('./ids');

// Pinned to whatsapp-web.js 1.34.7 plus upstream fixes to 28 Sep 2026 (vendor/) and modern WhatsApp Web.
// Its public Message.delete(true) can silently fall back to deleting only the local copy.
// Use the same revoke capability, but refuse that fallback and await an event.
async function revokeInPage({ messageId, groupId, senderId }) {
  // Runs inside WhatsApp Web, where an ID's text form is _serialized on older builds and $1 since July 2026.
  const text = id => (id ? id._serialized || id.$1 : undefined);
  const collections = window.require('WAWebCollections');
  const target = collections.Msg.get(messageId);
  if (!target || text(target.id) !== messageId || target.id.fromMe ||
      text(target.id.remote) !== groupId || text(target.id.participant) !== senderId) {
    return { status: 'skipped', reason: 'message-unavailable-or-changed' };
  }
  if (!window.WWebJS.compareWwebVersions(window.Debug.VERSION, '>=', '2.3000.0')) {
    throw new Error('Unsupported WhatsApp Web version; deletion requires review.');
  }
  if (!window.require('WAWebMsgActionCapability').canAdminRevokeMsg(target)) {
    return { status: 'skipped', reason: 'not-admin-or-message-not-revocable' };
  }
  const group = collections.Chat.get(target.id.remote);
  if (!group) return { status: 'skipped', reason: 'group-unavailable' };
  const commands = window.require('WAWebCmd').Cmd;
  if (typeof commands.sendRevokeMsgs !== 'function') throw new Error('Revoke API unavailable; deletion requires review.');
  await commands.sendRevokeMsgs(group, { list: [target], type: 'message' }, { clearMedia: true });
  return { status: 'requested' };
}

async function deleteGroupMessage(client, message, { timeoutMs = 10000 } = {}) {
  if (message.fromMe || !message.from?.endsWith('@g.us') || !message.id?._serialized || !message.author) {
    return { status: 'skipped', reason: 'invalid-group-message' };
  }
  const group = await client.getChatById(message.from);
  if (!group.isGroup || serialized(group.id) !== message.from) throw new Error('Group identity mismatch.');
  // The member list may name the sender by phone number while the message uses their privacy ID, or the reverse.
  const sender = await findParticipant(client, group.participants, message.author);
  if (!sender) return { status: 'skipped', reason: 'sender-not-in-current-metadata' };
  if (sender.isAdmin || sender.isSuperAdmin) return { status: 'skipped', reason: 'sender-is-group-admin' };

  let resolveConfirmation;
  let timer;
  const confirmation = new Promise(resolve => { resolveConfirmation = resolve; });
  const listener = revoked => {
    if (revoked?.id?._serialized === message.id._serialized) resolveConfirmation(true);
  };
  client.on('message_revoke_everyone', listener);
  try {
    const result = await client.pupPage.evaluate(revokeInPage, {
      messageId: message.id._serialized, groupId: message.from, senderId: message.author
    });
    if (result?.status === 'skipped') return result;
    if (result?.status !== 'requested') throw new Error('Unexpected revoke response.');
    timer = setTimeout(() => resolveConfirmation(false), timeoutMs);
    return await confirmation ? { status: 'confirmed', reason: 'revoke-event-observed' } :
      { status: 'unconfirmed', reason: 'no-revoke-event-within-timeout' };
  } finally {
    clearTimeout(timer);
    client.removeListener('message_revoke_everyone', listener);
  }
}

// "Delete for me": removes the message from this account's devices only. Everyone else still sees it.
async function deleteForMe(client, message, { timeoutMs = 5000 } = {}) {
  if (message.fromMe || !message.id?._serialized || typeof message.delete !== 'function') {
    return { status: 'skipped', reason: 'invalid-message', action: 'delete-for-me' };
  }
  let resolveConfirmation;
  let timer;
  const confirmation = new Promise(resolve => { resolveConfirmation = resolve; });
  const listener = removed => {
    if (removed?.id?._serialized === message.id._serialized) resolveConfirmation(true);
  };
  client.on('message_revoke_me', listener);
  try {
    await message.delete(false, true);
    timer = setTimeout(() => resolveConfirmation(false), timeoutMs);
    // WhatsApp Web does not always emit the local-removal event; that is reported, not treated as a failure.
    return await confirmation ? { status: 'deleted-for-me', reason: 'local-delete-event-observed', action: 'delete-for-me' } :
      { status: 'requested-for-me', reason: 'no-local-delete-event-within-timeout', action: 'delete-for-me' };
  } finally {
    clearTimeout(timer);
    client.removeListener('message_revoke_me', listener);
  }
}

// Remove spam on the owner's behalf: for everyone where the account is a group admin, otherwise (when allowed) for me.
async function removeSpamMessage(client, message, { forMeFallback = false, byOwner = false, timeoutMs } = {}) {
  if (!message.from?.endsWith('@g.us')) {
    return forMeFallback ? deleteForMe(client, message, { timeoutMs }) :
      { status: 'skipped', reason: 'direct-chat-needs-forMeFallback', action: 'delete-for-me' };
  }
  const result = await deleteGroupMessage(client, message, { timeoutMs });
  // Deleting for me only changes this account's view. Automatic deletion uses it only when the account is not an
  // admin, so a sender who cannot be matched to the member list (possibly an admin) is left alone. A message the
  // owner marked by hand may also be hidden from their own view in that case. Known group admins are never touched.
  const fallbackReasons = ['not-admin-or-message-not-revocable', ...(byOwner ? ['sender-not-in-current-metadata'] : [])];
  if (forMeFallback && result.status === 'skipped' && fallbackReasons.includes(result.reason)) {
    return deleteForMe(client, message, { timeoutMs });
  }
  return result;
}

module.exports = { deleteGroupMessage, revokeInPage, deleteForMe, removeSpamMessage };
