'use strict';

// A chat's ideas board: ideas anyone allowed in the chat saves with "<buzzword> idea <text>" (no AI), and the
// findings the AI writes from them when the owner asks ("<buzzword> findings"). One private file per chat in
// data/ideas/, written to a temporary file and renamed into place. The latest findings also go to "ask".

const fs = require('node:fs');
const path = require('node:path');
const { fileNameFor } = require('./archive');
const { cleanText } = require('./items');

const MAX_IDEAS = 200;
// Members can fill at most this much of the board, and add at most this many an hour, so the owner always has room.
const MAX_MEMBER_IDEAS = 150;
const MEMBER_IDEAS_PER_HOUR = 20;
const MAX_IDEA_CHARS = 500;
const KEEP_FINDINGS = 10;
const MAX_FINDINGS_CHARS = 8000;

class Ideas {
  constructor(directory) {
    this.directory = directory;
  }

  file(chatId) {
    return path.join(this.directory, fileNameFor(chatId).replace(/\.jsonl$/, '.json'));
  }

  read(chatId) {
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file(chatId), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { nextN: 1, ideas: [], findings: [] };
      throw new Error(`data/ideas/${path.basename(this.file(chatId))} could not be read (${error.code || 'not valid JSON'}).`);
    }
    return { nextN: Number.isSafeInteger(data.nextN) ? data.nextN : 1, ideas: Array.isArray(data.ideas) ? data.ideas : [],
      findings: Array.isArray(data.findings) ? data.findings : [] };
  }

  save(chatId, data) {
    const file = this.file(chatId);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* never created, or already renamed */ }
      throw new Error(`data/ideas/${path.basename(file)} could not be saved (${error.code || 'write failed'}).`);
    }
  }

  // { idea } or { error }.
  add(chatId, { text, by, now }) {
    const clean = cleanText(text, MAX_IDEA_CHARS + 1);
    if (!clean) return { error: 'empty' };
    if ([...clean].length > MAX_IDEA_CHARS) return { error: `An idea can be at most ${MAX_IDEA_CHARS} characters.` };
    const data = this.read(chatId);
    // Letters and digits decide; an idea of only emoji or signs is compared as written.
    const same = value => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() || value;
    const twin = data.ideas.find(idea => same(idea.text) === same(clean));
    if (twin) return { error: `That is already idea ${twin.n}.` };
    if (data.ideas.length >= MAX_IDEAS) return { error: `This chat already has ${MAX_IDEAS} ideas. The owner can make room with "ideas drop N" or "ideas clear".` };
    if (by !== 'owner') {
      const members = data.ideas.filter(idea => idea.by !== 'owner');
      if (members.length >= MAX_MEMBER_IDEAS) return { error: `Members' ideas are full (${MAX_MEMBER_IDEAS}). The owner can make room with "ideas drop N" or "ideas clear".` };
      if (members.filter(idea => idea.at > now - 3600000).length >= MEMBER_IDEAS_PER_HOUR) {
        return { error: `At most ${MEMBER_IDEAS_PER_HOUR} ideas an hour can come from members; try again later.` };
      }
    }
    const idea = { n: data.nextN, text: clean, by, at: now };
    data.ideas.push(idea);
    data.nextN += 1;
    this.save(chatId, data);
    return { idea };
  }

  drop(chatId, n) {
    const data = this.read(chatId);
    const before = data.ideas.length;
    data.ideas = data.ideas.filter(idea => idea.n !== n);
    if (data.ideas.length === before) return false;
    this.save(chatId, data);
    return true;
  }

  // All ideas removed; the findings and the numbering stay. How many were removed.
  clear(chatId) {
    const data = this.read(chatId);
    const count = data.ideas.length;
    if (!count) return 0;
    data.ideas = [];
    this.save(chatId, data);
    return count;
  }

  // Keeps the last KEEP_FINDINGS, oldest first.
  addFindings(chatId, { text, at, ideas, messages }) {
    const data = this.read(chatId);
    data.findings = [...data.findings, { at, text: String(text).slice(0, MAX_FINDINGS_CHARS), ideas, messages }].slice(-KEEP_FINDINGS);
    this.save(chatId, data);
  }

  latestFindings(chatId) {
    const { findings } = this.read(chatId);
    return findings.length ? findings[findings.length - 1] : null;
  }

  markIssue(chatId, at, issue) {
    const data = this.read(chatId);
    const entry = data.findings.find(x => x.at === at);
    if (!entry) return;
    entry.issue = issue;
    this.save(chatId, data);
  }
}

module.exports = { Ideas, MAX_IDEAS, MAX_MEMBER_IDEAS, MEMBER_IDEAS_PER_HOUR, MAX_IDEA_CHARS, KEEP_FINDINGS };
