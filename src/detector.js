'use strict';

const { createHash } = require('node:crypto');
const { domainToASCII } = require('node:url');
const { validateConfig } = require('./config');

function normalize(text) {
  return String(text || '').normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .toLowerCase().replace(/\s+/gu, ' ').trim();
}

function phrasePattern(phrase, { strict = false } = {}) {
  const text = normalize(phrase);
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Whole-word checks prevent "win" matching "window". CJK phrases use substrings.
  // Strict rules also refuse a hyphen or quote mark next to the phrase: "non-profit" is not "profit",
  // and a phrase someone quotes ('ignore "claim your prize" messages') is usually a warning.
  const word = strict ? '[\\p{L}\\p{N}_\'"\\u201C\\u201D-]' : '[\\p{L}\\p{N}_]';
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
  const left = !cjk && /^[\p{L}\p{N}]/u.test(text) ? `(?<!${word})` : '';
  const right = !cjk && /[\p{L}\p{N}]$/u.test(text) ? `(?!${word})` : '';
  return new RegExp(left + escaped + right, 'u');
}

function hostMatches(host, domain) {
  const canonical = domainToASCII(domain.toLowerCase());
  return host === canonical || host.endsWith(`.${canonical}`);
}

// Each link, and whether it was written explicitly (http://, https://, www.) or is a bare domain like "bit.ly/x".
function extractLinks(text) {
  const links = [];
  // Accept explicit URLs, www URLs and bare domains; never visit or expand links.
  const candidates = text.match(/(?:https?:\/\/|www\.)[^\s<>]+|(?<![\p{L}\p{N}_@.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,}(?::\d+)?(?:\/[^\s<>]*)?/gu) || [];
  for (let candidate of candidates) {
    candidate = candidate.replace(/[.,!?;:)\]}]+$/u, '');
    try {
      const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
      if (url.hostname) {
        links.push({ host: url.hostname.toLowerCase().replace(/\.$/, ''), explicit: /^(?:https?:\/\/|www\.)/i.test(candidate), url: candidate });
      }
    } catch { /* Malformed links do not crash detection. */ }
  }
  return links;
}

function extractHosts(text) {
  return extractLinks(text).map(link => link.host);
}

// Bare domains that are always links, even without http:// (unlike "won.Well done" or "timetable.pdf").
const KNOWN_LINK_DOMAINS = ['chat.whatsapp.com', 'wa.me', 't.me', 'telegram.me'];

class SpamDetector {
  constructor(config, { clock = Date.now, maxSenders = 5000, learned = null, members = null } = {}) {
    this.config = validateConfig(structuredClone(config));
    this.clock = clock;
    this.maxSenders = maxSenders;
    this.learned = learned;
    this.members = members; // people trusted with "<buzzword> trust" are exempt, like trustedSenderIds
    this.history = new Map();
    this.rules = this.config.keywords.map(rule => ({ ...rule, pattern: phrasePattern(rule.phrase) }));
    // Pattern rules combine several signals. They flag by default; only a rule the owner set to
    // "action": "delete" can remove messages on its own.
    this.strictRules = this.config.strictRules.map(rule => ({
      name: rule.name,
      action: rule.action,
      anyOf: (rule.anyOf || []).map(phrase => phrasePattern(phrase, { strict: true })),
      alsoAnyOf: (rule.alsoAnyOf || []).map(phrase => phrasePattern(phrase, { strict: true })),
      needsLink: Boolean(rule.needsLink),
      linkDomains: rule.linkDomains || [],
      needsRepeat: Boolean(rule.needsRepeat)
    }));
    this.trusted = new Set(this.config.trustedSenderIds);
  }

  check({ chatId, senderId, text = '' }) {
    const reasons = [];
    let score = 0;
    const add = (code, points, detail) => {
      if (points > 0) {
        score += points;
        reasons.push({ code, score: points, detail });
      }
    };
    if (this.trusted.has(senderId) || this.members?.isTrusted([senderId])) return { isSpam: false, score: 0, reasons, strict: [], certain: [], links: [], normalized: '', trusted: true };

    const normalized = normalize(text);
    // Repeating one keyword does not multiply its score.
    const matchedPhrases = new Set();
    for (const rule of this.rules) {
      const phrase = normalize(rule.phrase);
      if (!matchedPhrases.has(phrase) && rule.pattern.test(normalized)) {
        matchedPhrases.add(phrase);
        add('keyword', rule.score, `phrase: ${rule.phrase}`);
      }
    }

    const links = this.config.links;
    const found = extractLinks(normalized);
    const hosts = found.map(link => link.host);
    const blocked = [...new Set(hosts.filter(host => links.blockedDomains.some(domain => hostMatches(host, domain))))];
    const untrusted = hosts.filter(host => !links.trustedDomains.some(domain => hostMatches(host, domain)));
    if (untrusted.length) add('link', links.linkScore, 'contains a link outside trusted domains');
    if (hosts.some(host => links.shortenerDomains.some(domain => hostMatches(host, domain)))) {
      add('short-link', links.shortenerScore, 'contains a shortened link');
    }
    if (blocked.length) add('blocked-domain', links.blockedDomainScore, `blocked domain: ${blocked.join(', ')}`);
    if (untrusted.length >= links.manyLinksLimit) {
      add('many-links', links.manyLinksScore, `${untrusted.length} links outside trusted domains`);
    }

    const now = this.clock();
    const repeat = this.config.repetition;
    const cutoff = now - repeat.windowSeconds * 1000;
    const key = JSON.stringify([chatId, senderId]);
    const history = (this.history.get(key) || []).filter(item => item.time > cutoff);
    const fingerprint = normalized.length >= 8 ? createHash('sha256').update(normalized).digest('hex') : null;
    history.push({ time: now, fingerprint });
    if (fingerprint && history.filter(item => item.fingerprint === fingerprint).length >= repeat.duplicateLimit) {
      add('duplicate', repeat.score, `same text ${repeat.duplicateLimit}+ times within ${repeat.windowSeconds}s`);
    }
    if (history.length >= repeat.messageLimit) {
      add('flood', repeat.score, `${repeat.messageLimit}+ messages within ${repeat.windowSeconds}s`);
    }
    // Store hashes, with bounded sender and message counts.
    this.history.delete(key);
    if (this.history.size >= this.maxSenders) this.history.delete(this.history.keys().next().value);
    this.history.set(key, history.slice(-Math.max(repeat.messageLimit, repeat.duplicateLimit)));

    const repeated = reasons.some(reason => reason.code === 'duplicate');
    // Pattern rules count only links written as links, so "won.Well done" or "timetable.pdf" never qualifies.
    const isReal = link => (link.explicit ||
        [...KNOWN_LINK_DOMAINS, ...links.shortenerDomains].some(domain => hostMatches(link.host, domain))) &&
      !links.trustedDomains.some(domain => hostMatches(link.host, domain));
    const realLinks = found.filter(isReal);
    // The same links as written (case kept), so marked links match exactly: bit.ly/AbC is not bit.ly/abc.
    const writtenLinks = extractLinks(String(text || '').normalize('NFKC').replace(/[​-‍⁠﻿]/g, ''))
      .filter(isReal).map(link => link.url);
    const matched = this.strictRules.filter(rule =>
      (!rule.anyOf.length || rule.anyOf.some(pattern => pattern.test(normalized))) &&
      (!rule.alsoAnyOf.length || rule.alsoAnyOf.some(pattern => pattern.test(normalized))) &&
      (!rule.needsLink || realLinks.length > 0) &&
      (!rule.linkDomains.length || realLinks.some(link => rule.linkDomains.some(domain => hostMatches(link.host, domain)))) &&
      (!rule.needsRepeat || repeated)
    );
    const strict = matched.map(rule => rule.name);
    // What strict deletion acts on: patterns the owner chose. A domain they blocked, spam they marked with
    // "<buzzword> spam", and pattern rules they switched to "delete".
    const certain = matched.filter(rule => rule.action === 'delete').map(rule => rule.name);
    if (blocked.length) certain.push(`blocked domain: ${blocked.join(', ')}`);
    if (this.learned) certain.push(...this.learned.match(normalized, writtenLinks));

    return { isSpam: score >= this.config.threshold || strict.length > 0 || certain.length > 0, score, reasons, strict, certain,
      links: writtenLinks, normalized, trusted: false };
  }
}

module.exports = { SpamDetector, normalize, extractHosts, extractLinks, hostMatches };
