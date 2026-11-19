'use strict';

// Each chat's long-term notes: what the AI kept when it condensed that chat's older messages (chats[].keepDays).
// One plain-text file per chat in data/notes, owner-only, next to the archive; no chat ever reads another's notes.
// Every replaced version is kept in data/notes/history (all from the last condensedKeepDays, and at least the newest 10
// per chat), so a bad update can be undone.

const fs = require('node:fs');
const path = require('node:path');
const { fileNameFor } = require('./archive');

const HISTORY = 10;

class Notes {
  constructor(directory) { this.directory = directory; }

  file(chatId) { return path.join(this.directory, fileNameFor(chatId).replace(/\.jsonl$/, '.md')); }

  read(chatId) {
    try { return fs.readFileSync(this.file(chatId), 'utf8').trim(); } catch { return ''; }
  }

  stat(chatId) {
    const text = this.read(chatId);
    let updated = null;
    try { updated = fs.statSync(this.file(chatId)).mtimeMs; } catch { /* no notes yet */ }
    return { chars: text.length, lines: text ? text.split('\n').length : 0, updated };
  }

  history(chatId) {
    const base = path.basename(this.file(chatId), '.md');
    const dir = path.join(this.directory, 'history');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter(name => name.startsWith(`${base}.`) && /^\d{8}-\d{6}-\d{3}\.md$/.test(name.slice(base.length + 1)))
      .sort().map(name => path.join(dir, name));
  }

  // When a history file was written, from its name (UTC).
  static versionTime(file) {
    const m = /\.(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})\.md$/.exec(file);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : 0;
  }

  // The longest these notes have been since sinceMs (current text included): the shrink guard compares with it, so
  // a run of answers that each cut a little less than half cannot whittle the notes away.
  longestSince(chatId, sinceMs) {
    let longest = this.read(chatId).length;
    for (const file of this.history(chatId)) {
      if (Notes.versionTime(file) < sinceMs) continue;
      try { longest = Math.max(longest, fs.readFileSync(file, 'utf8').trim().length); } catch { /* gone */ }
    }
    return longest;
  }

  // keepDays: earlier versions younger than this are all kept; beyond that, the newest HISTORY are.
  write(chatId, text, nowMs = Date.now(), { keepDays = 30 } = {}) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(chatId);
    if (fs.existsSync(file)) {
      const dir = path.join(this.directory, 'history');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // 20260105-093000-123: sortable, one per millisecond.
      const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').slice(0, 19);
      fs.copyFileSync(file, path.join(dir, `${path.basename(file, '.md')}.${stamp}.md`));
      const versions = this.history(chatId);
      const young = nowMs - keepDays * 86400000;
      for (const old of versions.slice(0, Math.max(0, versions.length - HISTORY))) {
        if (Notes.versionTime(old) < young) fs.rmSync(old, { force: true });
      }
    }
    const temporary = `${file}.${process.pid}.tmp`;
    // On disk for certain before the condensed messages leave the archive.
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeSync(fd, `${String(text).trim()}\n`, null, 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  }
}

module.exports = { Notes, HISTORY };
