'use strict';

// Local message archive for chats with receive (and archive) on: one JSON-lines file per chat in data/archive.
// Ported from whatsapp-reader's bridge/store: media becomes a placeholder plus caption, nothing is downloaded,
// and "delete for everyone" removes the message from what transcripts and summaries see.

const fs = require('node:fs');
const path = require('node:path');

function placeholder(kind, caption) {
  return caption ? `[${kind}] ${caption}` : `[${kind}]`;
}

// Reduce a whatsapp-web.js message to the one line a transcript shows; '' for anything that is not content.
function textOf(message) {
  const body = String(message.body || '');
  switch (message.type) {
    case 'chat': return body;
    case 'image': return placeholder('image', body);
    case 'video': return placeholder('video', body);
    case 'document': return placeholder(`file ${message._data?.filename || ''}`.trim(), body);
    case 'audio': case 'ptt': return '[voice note]';
    case 'sticker': return '[sticker]';
    case 'location': return placeholder('location', String(message.location?.description || '').trim());
    case 'vcard': case 'multi_vcard': return '[contact card]';
    case 'poll_creation': {
      const options = (message.pollOptions || []).map(option => option.name).filter(Boolean);
      return `[poll] ${message.pollName || ''}${options.length ? `: ${options.join(' / ')}` : ''}`;
    }
    default: return '';
  }
}

function recordOf(message, chatId) {
  const text = textOf(message);
  if (!text) return null;
  const quoted = message._data?.quotedMsg;
  return {
    id: message.id?.id || message.id?._serialized,
    chat: chatId,
    ts: message.timestamp,
    fromMe: Boolean(message.fromMe),
    sender: message.fromMe ? null : (message.author || message.from),
    name: message.fromMe ? null : (message._data?.notifyName || null),
    kind: message.type,
    text,
    quoted: quoted ? String(quoted.body || quoted.caption || '').slice(0, 300) || null : null
  };
}

// Identifies one archived message for removal; messages without an id fall back to time and text.
function recordKey(record) {
  return record.id ? `id:${record.id}` : `ts:${record.ts}:${record.text}`;
}

function fileNameFor(chatId) {
  return `${String(chatId).replace(/[^\w.@-]/g, '_')}.jsonl`;
}

class Archive {
  constructor(directory, { maxFileMiB = 20 } = {}) {
    this.directory = directory;
    this.maxBytes = maxFileMiB * 1024 * 1024;
  }

  file(chatId) { return path.join(this.directory, fileNameFor(chatId)); }

  write(chatId, entry) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filename = this.file(chatId);
    // Roll at the size limit and keep one previous file, so the archive cannot fill the disk.
    if (fs.existsSync(filename) && fs.statSync(filename).size > this.maxBytes) {
      const previous = filename.replace(/\.jsonl$/, '.previous.jsonl');
      if (fs.existsSync(previous)) fs.unlinkSync(previous);
      fs.renameSync(filename, previous);
    }
    fs.appendFileSync(filename, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  append(message, chatId) {
    const record = recordOf(message, chatId);
    if (record) this.write(chatId, record);
    return record;
  }

  revoke(chatId, id) {
    if (id && fs.existsSync(this.file(chatId))) this.write(chatId, { revoked: id, ts: Math.floor(Date.now() / 1000) });
  }

  read(chatId, { since = 0 } = {}) {
    const records = [];
    const revoked = new Set();
    const filename = this.file(chatId);
    for (const file of [filename.replace(/\.jsonl$/, '.previous.jsonl'), filename]) {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; } // a torn last line after a crash is skipped
        if (entry.revoked) revoked.add(entry.revoked);
        else records.push(entry);
      }
    }
    const seen = new Set();
    return records.filter(r => !revoked.has(r.id) && r.ts >= since && !seen.has(r.id) && seen.add(r.id))
      .sort((a, b) => a.ts - b.ts);
  }

  // Take records out of the archive (after they were condensed into the chat's notes). keys: Set of recordKey values.
  // beforeRemoving(records) runs first with the records about to go, so a cold copy is on disk before anything is
  // rewritten. revokedBefore (seconds): also drop messages deleted for everyone that are older than this, with their
  // deletion markers; their text is not copied anywhere. Callers hold the instance lock, and this runs synchronously,
  // so no append from this process races it.
  prune(chatId, keys, { beforeRemoving = null, revokedBefore = null } = {}) {
    const filename = this.file(chatId);
    const files = [filename.replace(/\.jsonl$/, '.previous.jsonl'), filename].filter(file => fs.existsSync(file));
    const parsed = files.map(file => fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => {
      try { return { line, entry: JSON.parse(line) }; } catch { return { line, entry: null }; }
    }));
    const revoked = new Set(parsed.flat().filter(x => x.entry?.revoked).map(x => x.entry.revoked));
    const removedIds = new Set();
    const taken = new Map(); // one copy per message, even if a roll left it in both files
    for (const { entry } of parsed.flat()) {
      if (!entry || entry.revoked) continue;
      const wasRevoked = entry.id && revoked.has(entry.id);
      if (keys.has(recordKey(entry)) && !wasRevoked) { if (!taken.has(recordKey(entry))) taken.set(recordKey(entry), entry); }
      else if (!(wasRevoked && revokedBefore !== null && entry.ts < revokedBefore)) continue;
      if (entry.id) removedIds.add(entry.id);
    }
    const goes = entry => entry && (entry.revoked ? removedIds.has(entry.revoked)
      : (entry.id && removedIds.has(entry.id)) || (!entry.id && keys.has(recordKey(entry))));
    if (beforeRemoving && taken.size) beforeRemoving([...taken.values()]);
    files.forEach((file, i) => {
      const kept = parsed[i].filter(({ entry }) => !goes(entry)).map(({ line }) => line);
      if (kept.length === parsed[i].length) return;
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 });
      fs.renameSync(temporary, file);
    });
    return taken.size;
  }

  stats(chatId) {
    const records = this.read(chatId);
    return { count: records.length, last: records.length ? records[records.length - 1].ts : null };
  }
}

// Messages taken out of the archive by condensing, kept as written (not pseudonymised) for keepDays days in
// data/condensed/<chat id>.jsonl, owner-only, then deleted. Never sent to the AI and never read by any command: it is
// only there so a bad condensing run can be undone by hand.
class ColdStore {
  constructor(directory) { this.directory = directory; }

  file(chatId) { return path.join(this.directory, fileNameFor(chatId)); }

  add(chatId, records, nowMs = Date.now()) {
    if (!records.length) return;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const condensedAt = Math.floor(nowMs / 1000);
    // On disk for certain before the archive is rewritten.
    const fd = fs.openSync(this.file(chatId), 'a', 0o600);
    try {
      fs.writeSync(fd, records.map(record => `${JSON.stringify({ condensedAt, ...record })}\n`).join(''));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }

  // Every chat's copies, including chats whose condensing was turned off or that were removed from the config.
  purgeAll(keepDays, nowMs = Date.now()) {
    let names = [];
    try { names = fs.readdirSync(this.directory); } catch { return 0; }
    let dropped = 0;
    for (const name of names.filter(n => /\.jsonl$/.test(n))) {
      const file = path.join(this.directory, name);
      try { if (fs.lstatSync(file).isFile()) dropped += this.purgeFile(file, keepDays, nowMs); } catch { /* next time */ }
    }
    return dropped;
  }

  // Drop copies older than keepDays (0 drops them all). Returns how many were dropped.
  purge(chatId, keepDays, nowMs = Date.now()) {
    return this.purgeFile(this.file(chatId), keepDays, nowMs);
  }

  purgeFile(file, keepDays, nowMs) {
    if (!fs.existsSync(file)) return 0;
    const cutoff = Math.floor(nowMs / 1000) - keepDays * 86400;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim());
    const kept = lines.filter(line => {
      try { return JSON.parse(line).condensedAt > cutoff; } catch { return false; }
    });
    if (kept.length === lines.length) return 0;
    if (!kept.length) { fs.unlinkSync(file); return lines.length; }
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${kept.join('\n')}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return lines.length - kept.length;
  }

  count(chatId) {
    try { return fs.readFileSync(this.file(chatId), 'utf8').split('\n').filter(line => line.trim()).length; } catch { return 0; }
  }
}

module.exports = { Archive, ColdStore, textOf, recordOf, recordKey, fileNameFor };
