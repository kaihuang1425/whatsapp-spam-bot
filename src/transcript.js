'use strict';

// Ported from whatsapp-reader's pseudonymise.py. Replace people with stable, irreversible labels before anything
// leaves the machine. Labels are HMAC-SHA256(secret, chat id + user id): one person gets a different label in each
// chat, so summaries posted in two groups cannot be matched up. Names typed inside message text are NOT caught.

const fs = require('node:fs');
const path = require('node:path');
const { createHmac, randomBytes } = require('node:crypto');

const MENTION = /@(\d{6,})/g;
const PHONE = /\+?\d[\d\s\-()]{8,}\d/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Query strings and fragments often carry signed tokens; host and path are all a summary needs.
const URL_TAIL = /(https?:\/\/[^\s?#]+)[?#]\S*/g;

function loadOrCreateSecret(filename) {
  if (fs.existsSync(filename)) return fs.readFileSync(filename);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32);
  fs.writeFileSync(filename, secret, { mode: 0o600 });
  return secret;
}

function userOf(id) {
  return String(id || '').split('@')[0];
}

// scope: the chat the label is for. A label computed for one chat says nothing about the same person elsewhere.
function label(secret, id, scope = '') {
  const hmac = createHmac('sha256', secret);
  if (scope) hmac.update(`chat:${scope}\n`);
  return `Member-${hmac.update(userOf(id)).digest('hex').slice(0, 4)}`;
}

function scrub(secret, text, scope = '') {
  return String(text)
    .replace(URL_TAIL, '$1')
    .replace(MENTION, (_, user) => `@${label(secret, user, scope)}`)
    .replace(EMAIL, '[email]')
    // Require 11+ digits so dates and times ("2026-10-08 19:00") survive.
    .replace(PHONE, match => ((match.match(/\d/g) || []).length >= 11 ? '[phone]' : match));
}

// The machine's own time zone unless one is given (spotting requests uses reminders.timeZone).
function when(ts, timeZone) {
  const date = new Date(ts * 1000);
  const zone = timeZone ? { timeZone } : {};
  const day = date.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', ...zone }).replace(',', '');
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...zone });
  return `${day} ${time}`;
}

// One "[Wed 28 Oct 14:05] Member-ab12: text" head per message, continuation lines indented.
// With pseudonymise off, senders show by profile name (or the names map) and text is left as written.
// scope: the chat ID for labels; by default each record's own chat.
function renderTranscript(records, { secret = null, pseudonymise = true, names = {}, ids = false, scope = null, timeZone = null } = {}) {
  const scopeOf = record => scope ?? record.chat ?? '';
  const who = record => {
    if (record.fromMe) return 'Me';
    if (pseudonymise) return label(secret, record.sender, scopeOf(record));
    return names[userOf(record.sender)] || record.name || userOf(record.sender);
  };
  const clean = (text, record) => (pseudonymise ? scrub(secret, text, scopeOf(record)) : String(text));
  const lines = [];
  for (const record of records) {
    let body = clean(record.text, record);
    if (record.quoted) {
      const snippet = clean(record.quoted.replace(/\n/g, ' '), record);
      body += ` (replying to "${snippet.slice(0, 60)}${snippet.length > 60 ? '…' : ''}")`;
    }
    const [first, ...rest] = body.split('\n');
    lines.push(`[${when(record.ts, timeZone)}${ids && record.id ? ` #${record.id}` : ''}] ${who(record)}: ${first}`);
    for (const line of rest) lines.push(`    ${line}`);
  }
  return lines.join('\n');
}

// Prefer whole newest messages. If the newest alone is oversized, retain its newest characters.
function renderSummaryTranscript(records, { maxChars = 60000, ...options } = {}) {
  const parts = [];
  let length = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const part = renderTranscript([records[i]], options);
    if (length + part.length + (parts.length ? 1 : 0) > maxChars) {
      if (!parts.length) parts.push(part.slice(-maxChars));
      break;
    }
    parts.push(part);
    length += part.length + (parts.length > 1 ? 1 : 0);
  }
  return { transcript: parts.reverse().join('\n'), count: parts.length };
}

// For condensing: the OLDEST whole messages that fit. count says how many of the first records were used. If the
// oldest alone is over the cap it is sent whole anyway (a WhatsApp message is at most about 65,000 characters):
// condensing removes what it sends, so it must never send part of a message.
function renderOldestChunk(records, { maxChars = 60000, ...options } = {}) {
  const parts = [];
  let length = 0;
  for (const record of records) {
    const part = renderTranscript([record], options);
    if (length + part.length + (parts.length ? 1 : 0) > maxChars) {
      if (!parts.length) parts.push(part);
      break;
    }
    length += part.length + (parts.length ? 1 : 0);
    parts.push(part);
  }
  return { transcript: parts.join('\n'), count: parts.length };
}

module.exports = { loadOrCreateSecret, label, scrub, renderTranscript, renderSummaryTranscript, renderOldestChunk };
