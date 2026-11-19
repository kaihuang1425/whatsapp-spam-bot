'use strict';

// WhatsApp can name one person two ways: a phone-number ID (447700900123@c.us) and a privacy ID (12345678@lid).
// Group member lists and message authors do not always use the same form, so lookups try both.

// WhatsApp Web renamed an ID's text form from _serialized to $1 in July 2026. The library fills in
// _serialized on messages, chats and contacts, but not on raw data such as group member lists.
function serialized(id) {
  return typeof id === 'object' && id !== null ? (id._serialized || id.$1) : id;
}

// Every known form of one person's ID; just the given one when the library cannot resolve it.
async function equivalentIds(client, id) {
  const ids = new Set();
  const given = serialized(id);
  if (!given) return ids;
  ids.add(given);
  if (typeof client?.getContactLidAndPhone === 'function') {
    try {
      const [match] = await client.getContactLidAndPhone([given]);
      for (const value of [match?.lid, match?.pn]) if (value) ids.add(serialized(value));
    } catch { /* unresolved: the given form is still tried */ }
  }
  return ids;
}

// The group member matching this person under any of their IDs.
async function findParticipant(client, participants = [], id) {
  const exact = participants.find(p => serialized(p.id) === serialized(id));
  if (exact) return exact;
  const ids = await equivalentIds(client, id);
  return participants.find(p => ids.has(serialized(p.id)));
}

// Phone number digits, when one of the IDs is phone-based: "447700900123@c.us" -> "447700900123".
function phoneDigits(ids) {
  for (const id of ids) {
    const match = /^(\d{6,})@c\.us$/.exec(id);
    if (match) return match[1];
  }
  return null;
}

module.exports = { serialized, equivalentIds, findParticipant, phoneDigits };
