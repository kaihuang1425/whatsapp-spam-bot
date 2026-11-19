'use strict';

// People the owner trusts ("<buzzword> trust": exempt from spam checks in every chat) and people the bot removed
// from a group ("<buzzword> kick": their later join requests can be rejected). Each entry keeps every known form of
// the person's ID, so a match works whether WhatsApp reports them by phone number or by privacy ID.
// Stored in data/members.json; stop the bot before editing it by hand.

const fs = require('node:fs');
const path = require('node:path');

class MemberLists {
  constructor(filename, { clock = Date.now } = {}) {
    this.filename = filename;
    this.clock = clock;
    this.data = { trusted: [], removed: [] };
    if (filename && fs.existsSync(filename)) {
      const content = fs.readFileSync(filename, 'utf8').replace(/^﻿/, '');
      if (content.trim()) {
        let raw;
        try { raw = JSON.parse(content); } catch (error) { throw new Error(`${filename} is not valid JSON: ${error.message}`); }
        const valid = list => Array.isArray(list) && list.every(x => Array.isArray(x?.ids) && x.ids.every(id => typeof id === 'string'));
        if (!valid(raw?.trusted) || !valid(raw?.removed)) throw new Error(`${filename} is not a member-list file.`);
        this.data = raw;
      }
    }
  }

  save() {
    if (!this.filename) return;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filename);
  }

  find(list, ids) {
    const wanted = new Set(ids);
    return this.data[list].find(entry => entry.ids.some(id => wanted.has(id)));
  }

  add(list, ids, extra = {}) {
    const all = [...new Set(ids)].filter(Boolean);
    if (!all.length) return false;
    const existing = this.find(list, all);
    if (existing) {
      const merged = [...new Set([...existing.ids, ...all])];
      if (merged.length === existing.ids.length) return false;
      existing.ids = merged;
    } else {
      this.data[list].push({ ids: all, time: new Date(this.clock()).toISOString(), ...extra });
    }
    this.save();
    return true;
  }

  remove(list, ids) {
    const wanted = new Set(ids);
    const before = this.data[list].length;
    this.data[list] = this.data[list].filter(entry => !entry.ids.some(id => wanted.has(id)));
    if (this.data[list].length === before) return false;
    this.save();
    return true;
  }

  isTrusted(ids) { return Boolean(this.find('trusted', [...ids])); }
  wasRemoved(ids) { return Boolean(this.find('removed', [...ids])); }
  get size() { return { trusted: this.data.trusted.length, removed: this.data.removed.length }; }
}

module.exports = { MemberLists };
