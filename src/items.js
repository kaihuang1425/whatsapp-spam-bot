'use strict';

// Each chat's open items: reminders, things to do, and requests the AI spotted in the messages (suggestions until
// someone keeps one). One JSON file per chat in data/items/, written whole each time (temporary file, then rename).
// Only the running bot writes them; a CLI command that changes them takes the instance lock first.
//
// An item: { n, text, status, by, created, due, remindAt, firedAt, missedAt, closed, source }
//   status   "open" (to do), "suggested" (spotted by the AI, not yet kept), "done" or "dropped"
//   by       "owner", "member" or "ai"
//   due      when it has to be done, if anyone said (ms), else null
//   remindAt when the bot posts a reminder in the chat (ms), else null; firedAt once posted (or being posted),
//            missedAt if it could not be posted in time
//   source   the WhatsApp message that set the reminder, quoted when it is posted
//
// The list tidies itself (tidy below): suggestions expire, items whose reminder went out are closed after a few
// days, and closed items are forgotten. So a chat's list cannot fill up for good.

const fs = require('node:fs');
const path = require('node:path');
const { fileNameFor } = require('./archive');

const DAY = 86400000;
const ACTIVE = new Set(['open', 'suggested']);

const same = text => String(text).toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();

// Control characters, line and paragraph separators, and the invisible marks that reorder text (bidi controls).
// Zero-width joiners stay: emoji sequences and several scripts need them. Built from character codes so this
// source file holds no invisible characters itself.
const INVISIBLE = new RegExp(`[${[[0x00, 0x1f], [0x7f, 0x9f], [0x061c, 0x061c], [0x200b, 0x200b], [0x200e, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]]
  .map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('')}]+`, 'g');

// One line of plain text: no control or invisible characters, collapsed spaces, at most max characters.
function cleanText(text, max) {
  const flat = String(text ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return [...flat].length > max ? `${[...flat].slice(0, max - 1).join('')}…` : flat;
}

// Links: with a scheme or www., an IP address, a name under a common top-level domain, or any name.name/path.
// Members may not put them in reminders, and they are taken out of the AI's suggestions.
const TLDS = 'com|net|org|info|biz|io|co|me|ly|gd|to|cc|gg|tv|ai|app|dev|page|link|site|online|shop|store|top|xyz|club|live|life|' +
  'world|today|news|click|win|vip|icu|buzz|cfd|sbs|rest|bond|best|tech|pro|uk|us|eu|de|fr|nl|ru|cn|jp|kr|tw|hk|sg|th|in|au|ca|tk|ml|ga|cf|gq';
const LINK = new RegExp(String.raw`(?:https?:\/\/|www\.)\S*|\b(?:\d{1,3}\.){3}\d{1,3}(?:[:/]\S*)?|\b(?:[a-z0-9-]+\.)+(?:${TLDS})\b(?:\/\S*)?|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*`, 'i');
const LINKS = new RegExp(LINK.source, 'gi');
// Seven or more digits, with spaces, dots, dashes or brackets between them (phone and account numbers); dates such
// as 2026-11-20 are left alone.
const LONG_NUMBER = /\+?\(?\d[\d\s().-]{5,}\d\)?/g;

function hasLink(text) {
  return LINK.test(String(text));
}

function stripLinksAndNumbers(text) {
  return String(text).replace(LINKS, '[link]')
    .replace(LONG_NUMBER, match => (/^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})$/.test(match.trim()) ||
      (match.match(/\d/g) || []).length < 7 ? match : '[number]'));
}

// An open item whose reminder has not gone out yet (or that has none).
const pending = item => item.status === 'open' && !item.firedAt && !item.missedAt;

// Expire and close what is stale. settings: the reminders section of the config. Returns true if anything changed.
function tidy(data, now, settings) {
  const before = JSON.stringify(data.items);
  data.items = data.items.filter(item => {
    // A suggestion nobody kept goes after suggestionDays, or once its deadline has passed.
    if (item.status === 'suggested') return !(item.created < now - settings.suggestionDays * DAY || (item.due && item.due < now));
    // Closed items are forgotten after keepClosedDays.
    if (!ACTIVE.has(item.status)) return !(item.closed < now - settings.keepClosedDays * DAY);
    return true;
  });
  // An item whose reminder went out (or could not) closes itself closeAfterDays later, but not before closeAfterDays
  // past its own deadline: a request kept with an early reminder stays listed until it is due.
  for (const item of data.items) {
    const reminded = item.firedAt || item.missedAt;
    if (item.status === 'open' && reminded && Math.max(reminded, item.due || 0) < now - settings.closeAfterDays * DAY) {
      Object.assign(item, { status: 'done', closed: now, autoClosed: true });
    }
  }
  return JSON.stringify(data.items) !== before;
}

class Items {
  constructor(directory) {
    this.directory = directory;
  }

  file(chatId) {
    return path.join(this.directory, fileNameFor(chatId).replace(/\.jsonl$/, '.json'));
  }

  // Errors name only data/items/<file>: a failed chat command shows its error in the chat, and the server's own
  // folders are nobody's business there.
  read(chatId) {
    const where = `data/items/${path.basename(this.file(chatId))}`;
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file(chatId), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { next: 1, items: [], scan: null };
      throw new Error(`${where} cannot be read (${error.code || 'not valid JSON'}); the owner can move it aside on the server to start a new list.`);
    }
    if (!data || !Number.isSafeInteger(data.next) || !Array.isArray(data.items)) {
      throw new Error(`${where} is not an items list; the owner can move it aside on the server to start a new list.`);
    }
    data.scan ??= null;
    return data;
  }

  save(chatId, data) {
    const file = this.file(chatId);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(temporary, 'w', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    } catch (error) {
      throw new Error(`data/items/${path.basename(file)} could not be saved (${error.code || 'write failed'}); the owner can check the server's disk and that folder.`);
    }
  }

  // Read, change and save in one step (no waiting in between, so nothing else in this process interleaves).
  update(chatId, change) {
    const data = this.read(chatId);
    const result = change(data);
    this.save(chatId, data);
    return result;
  }

  active(chatId) {
    const items = this.read(chatId).items.filter(item => ACTIVE.has(item.status));
    const order = (a, b) => (a.remindAt ?? a.due ?? Infinity) - (b.remindAt ?? b.due ?? Infinity) || a.n - b.n;
    return { open: items.filter(item => item.status === 'open').sort(order), suggested: items.filter(item => item.status === 'suggested').sort((a, b) => a.n - b.n) };
  }

  // Adds an item after tidying the list. See addTo for the limits.
  add(chatId, fields) {
    return this.update(chatId, data => addTo(data, fields));
  }

  // Suggested -> open, or a new reminder time for an open item. remindAt undefined keeps the item's own.
  keep(chatId, n, { remindAt, source, now, settings } = {}) {
    return this.update(chatId, data => {
      tidy(data, now, settings);
      const item = data.items.find(x => x.n === n && ACTIVE.has(x.status));
      if (!item) return { error: `There is no open or suggested item ${n}.` };
      if (item.status === 'suggested' && data.items.filter(x => x.status === 'open').length >= settings.maxOpenPerChat) {
        return { error: `This chat already has ${settings.maxOpenPerChat} open items. Close some with "done N" or "drop N" first.` };
      }
      item.status = 'open';
      if (remindAt !== undefined) Object.assign(item, { remindAt, firedAt: null, missedAt: null, source: source ?? item.source ?? null });
      return { item };
    });
  }

  close(chatId, n, status, now) {
    return this.update(chatId, data => {
      const item = data.items.find(x => x.n === n && ACTIVE.has(x.status));
      if (!item) return { error: `There is no open or suggested item ${n}.` };
      if (status === 'done' && item.status !== 'open') return { error: `Item ${n} is only a suggestion: keep it first, or drop it.` };
      Object.assign(item, { status, closed: now });
      return { item };
    });
  }

  // Open items whose reminder time has come and that were neither posted nor missed.
  due(chatId, now) {
    return this.read(chatId).items.filter(item => pending(item) && Number.isFinite(item.remindAt) && item.remindAt <= now)
      .sort((a, b) => a.remindAt - b.remindAt || a.n - b.n);
  }

  // Marks a due reminder as being posted, but only if it is still open, still due at the same time and not yet
  // posted or missed: a "drop", "done" or new time that arrived meanwhile wins. Returns the item, or null.
  claim(chatId, n, remindAt, field, now) {
    return this.update(chatId, data => {
      const item = data.items.find(x => x.n === n);
      if (!item || !pending(item) || item.remindAt !== remindAt) return null;
      item[field] = now;
      return { ...item };
    });
  }

  // Sets one field of an item (for example sendFailedAt), whatever its state.
  mark(chatId, n, field, value) {
    this.update(chatId, data => {
      const item = data.items.find(x => x.n === n);
      if (item) item[field] = value;
    });
  }

  // A claimed reminder that was not sent after all: due again.
  unclaim(chatId, n) {
    this.update(chatId, data => {
      const item = data.items.find(x => x.n === n);
      if (item) item.firedAt = null;
    });
  }

  // Reminders posted (or being posted) since a moment: the per-chat and overall hourly limits count these, so a
  // restart does not reset them.
  postedSince(chatId, since) {
    return this.read(chatId).items.filter(item => item.firedAt > since).length;
  }

  // Tidies a chat's list on the bot's own schedule; writes only if something changed.
  purge(chatId, now, settings) {
    if (!fs.existsSync(this.file(chatId))) return false;
    const data = this.read(chatId);
    const changed = tidy(data, now, settings);
    if (changed) this.save(chatId, data);
    return changed;
  }
}

// Adds an item to a chat's data after tidying it.
// - Not twice: a suggestion is not added if any open or suggested item has the same text; anything else is not
//   added if one has the same text and the same reminder time. So "take the bins out" can be set for Monday and for
//   Thursday, and again next week.
// - Open items: at most settings.maxOpenPerChat; then adding is refused.
// - Suggestions: at most settings.maxSuggestedPerChat; a new one pushes out the oldest.
function addTo(data, { text, status = 'open', by, now, due = null, remindAt = null, source = null, settings }) {
  tidy(data, now, settings);
  const active = data.items.filter(item => ACTIVE.has(item.status));
  const repeats = item => same(item.text) === same(text) && (status === 'suggested' || (item.remindAt ?? null) === (remindAt ?? null));
  if (active.some(repeats)) return { error: `"${text}" is already on the list${remindAt ? ' for that time' : ''}.`, duplicate: true };
  if (status === 'open' && data.items.filter(item => item.status === 'open').length >= settings.maxOpenPerChat) {
    return { error: `This chat already has ${settings.maxOpenPerChat} open items. Close some with "done N" or "drop N" first.`, full: true };
  }
  if (status === 'suggested') {
    const suggested = data.items.filter(item => item.status === 'suggested').sort((a, b) => a.n - b.n);
    const extra = suggested.length - settings.maxSuggestedPerChat + 1;
    if (extra > 0) {
      const oldest = new Set(suggested.slice(0, extra).map(item => item.n));
      data.items = data.items.filter(item => !oldest.has(item.n));
    }
  }
  const item = { n: data.next++, text, status, by, created: now, due, remindAt, firedAt: null, missedAt: null, closed: null, source };
  data.items.push(item);
  return { item };
}

// Text the AI drafted from members' messages may keep the links already in what it changes, but no new ones: a
// message could plant a link for the AI to write into the team's file from the owner's account.
function onlyKnownLinks(text, known = '') {
  const existing = new Set(String(known).match(LINKS) || []);
  return String(text).replace(LINKS, link => (existing.has(link) ? link : '[link]'));
}

module.exports = { Items, addTo, tidy, cleanText, hasLink, stripLinksAndNumbers, onlyKnownLinks, ACTIVE };
