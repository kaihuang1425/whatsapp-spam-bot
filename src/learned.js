'use strict';

// Spam the owner has confirmed by replying "<buzzword> spam" to it. Future copies of the exact text, or messages
// carrying one of its exact links, are deleted automatically. Nothing broader is learned, so one wrong mark cannot
// spread: it only ever matches that text or those links. Stored in data/learned-spam.json.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// A text fingerprint is only learned for long messages, or shorter ones that carry a link, so marking a scam that
// opens with "Good morning everyone, have a blessed day" cannot delete every later greeting.
const MIN_TEXT = 60;
const MIN_TEXT_WITH_LINK = 20;

function fingerprint(normalized) {
  return createHash('sha256').update(normalized).digest('hex');
}

function parse(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`); } catch { return null; }
}

// Exact link identity: host (with port) in lower case, path and query as written, no fragment or trailing slash.
function linkKey(url) {
  const parsed = parse(url);
  return parsed ? `${parsed.host.toLowerCase().replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}` : null;
}

// Only a link to a specific page is learned. A bare site ("https://www.instagram.com") named in a scam is
// often a real site that ordinary messages link to as well.
function isSpecific(url) {
  const parsed = parse(url);
  return Boolean(parsed && (parsed.pathname.replace(/\/+$/, '') || parsed.search));
}

class LearnedSpam {
  constructor(filename, { clock = Date.now } = {}) {
    this.filename = filename;
    this.clock = clock;
    this.data = { texts: [], links: [] };
    if (filename && fs.existsSync(filename)) {
      const content = fs.readFileSync(filename, 'utf8').replace(/^﻿/, '');
      if (content.trim()) {
        let raw;
        try { raw = JSON.parse(content); } catch (error) { throw new Error(`${filename} is not valid JSON: ${error.message}`); }
        if (!Array.isArray(raw?.texts) || !Array.isArray(raw?.links)) throw new Error(`${filename} is not a learned-spam file.`);
        this.data = raw;
      }
    }
    this.index();
  }

  index() {
    this.texts = new Set(this.data.texts.map(x => x.hash));
    this.links = new Set(this.data.links.map(x => x.link));
  }

  save() {
    if (!this.filename) return;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filename);
  }

  // normalized: detector-normalized text; urls: links found in it, as written.
  learn(normalized, urls = []) {
    const added = { text: false, links: [], skippedLinks: [] };
    const time = new Date(this.clock()).toISOString();
    if (normalized.length >= MIN_TEXT || (urls.length && normalized.length >= MIN_TEXT_WITH_LINK)) {
      const hash = fingerprint(normalized);
      if (!this.texts.has(hash)) {
        this.data.texts.push({ hash, time, preview: normalized.slice(0, 60) });
        added.text = true;
      }
    }
    for (const url of urls) {
      const key = linkKey(url);
      if (!key) continue;
      if (!isSpecific(url)) { if (!added.skippedLinks.includes(key)) added.skippedLinks.push(key); continue; }
      if (!this.links.has(key) && !added.links.includes(key)) {
        this.data.links.push({ link: key, time });
        added.links.push(key);
      }
    }
    if (added.text || added.links.length) { this.index(); this.save(); }
    return added;
  }

  match(normalized, urls = []) {
    const reasons = [];
    if (this.texts.has(fingerprint(normalized))) reasons.push('text you marked as spam');
    const hit = urls.map(linkKey).find(key => key && this.links.has(key));
    if (hit) reasons.push(`link you marked as spam: ${hit}`);
    return reasons;
  }

  get size() { return { texts: this.data.texts.length, links: this.data.links.length }; }
}

module.exports = { LearnedSpam, linkKey, isSpecific };
