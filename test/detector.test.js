'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, validateConfig } = require('../src/config');
const { SpamDetector, extractHosts } = require('../src/detector');

function setup(change = () => {}) {
  const config = loadConfig();
  change(config);
  let now = 1800000000000;
  const detector = new SpamDetector(config, { clock: () => now });
  return {
    detector,
    check: (text, senderId = 'alice', chatId = 'group') => detector.check({ text, senderId, chatId }),
    advance: ms => { now += ms; }
  };
}

test('ordinary conversation and one ordinary link stay below threshold', () => {
  const { check } = setup();
  assert.equal(check('See you at the library at 3').isSpam, false);
  assert.equal(check('Notes: https://example.org/class').isSpam, false);
});

test('combines weak phrases and records evidence', () => {
  const result = setup().check('Work from home and earn daily');
  assert.equal(result.score, 5);
  assert.equal(result.isSpam, true);
  assert.deepEqual(result.reasons.map(x => x.code), ['keyword', 'keyword']);
});

test('normalizes case, fullwidth letters, zero-width characters and spacing', () => {
  for (const text of ['FREE MONEY', 'ＦＲＥＥ ＭＯＮＥＹ', 'fr\u200bee money', 'free\n\t money']) {
    assert.equal(setup().check(text).isSpam, true, text);
  }
});

test('does not match a word inside a longer word', () => {
  const { check } = setup(c => { c.keywords = [{ phrase: 'win', score: 5 }]; });
  assert.equal(check('Open the window').score, 0);
  assert.equal(check('win!').isSpam, true);
});

test('treats regex punctuation in phrases literally', () => {
  const { check } = setup(c => { c.keywords = [{ phrase: 'c++ (free)', score: 5 }]; });
  assert.equal(check('Learn c++ (free) today').isSpam, true);
  assert.equal(check('Learn c free today').score, 0);
});

test('a repeated keyword contributes only once', () => {
  assert.equal(setup().check('you have won, you have won, YOU HAVE WON').score, 4);
});

test('CJK phrases match within sentences', () => {
  const { check } = setup(c => { c.keywords = [{ phrase: '\u514d\u8cbb\u9818\u53d6', score: 5 }]; });
  assert.equal(check('\u73fe\u5728\u514d\u8cbb\u9818\u53d6\u734e\u54c1').isSpam, true);
});

test('blocked domains include true subdomains but not lookalikes', () => {
  const { check } = setup(c => { c.links.blockedDomains = ['bad.example']; });
  assert.equal(check('https://offers.bad.example/prize').isSpam, true);
  assert.equal(check('https://bad.example.evil.org').isSpam, false);
  assert.equal(check('https://notbad.example').isSpam, false);
});

test('blocked domains take precedence over trusted domains', () => {
  const { check } = setup(c => {
    c.links.blockedDomains = ['bad.example'];
    c.links.trustedDomains = ['bad.example'];
  });
  assert.equal(check('bad.example').isSpam, true);
});

test('trusted domains suppress link points without bypassing keyword checks', () => {
  const { check } = setup(c => { c.links.trustedDomains = ['example.org']; });
  assert.equal(check('https://docs.example.org/page').score, 0);
  assert.equal(check('free money https://example.org').isSpam, true);
  assert.equal(check('https://example.org.evil.net').score, 1);
});

test('handles bare, shortened and unicode domains; skips email addresses', () => {
  assert.deepEqual(extractHosts('Email me at hello@example.org'), []);
  assert.deepEqual(extractHosts('Try bit.ly/test, or www.example.com.'), ['bit.ly', 'www.example.com']);
  const { check } = setup(c => { c.links.blockedDomains = ['b\u00fccher.de']; });
  assert.equal(check('https://b\u00fccher.de/offer').isSpam, true);
  assert.ok(setup().check('bit.ly/test').reasons.some(r => r.code === 'short-link'));
});

test('many ordinary links alone are insufficient with conservative defaults', () => {
  const result = setup().check('https://a.example https://b.example https://c.example');
  assert.equal(result.score, 4);
  assert.equal(result.isSpam, false);
  assert.ok(result.reasons.some(r => r.code === 'many-links'));
});

test('the third repeated text from one sender is flagged', () => {
  const { check } = setup();
  assert.equal(check('Buy this wonderful item').isSpam, false);
  assert.equal(check('BUY THIS WONDERFUL ITEM').isSpam, false);
  const third = check('Buy this wonderful item');
  assert.equal(third.isSpam, true);
  assert.ok(third.reasons.some(r => r.code === 'duplicate'));
});

test('short acknowledgements do not trigger duplicate detection', () => {
  const { check } = setup();
  for (let i = 0; i < 3; i++) assert.equal(check('ok').isSpam, false);
});

test('repetition is separate for each sender and group', () => {
  const { check } = setup();
  check('Buy this wonderful item', 'alice', 'group-a');
  check('Buy this wonderful item', 'alice', 'group-a');
  assert.equal(check('Buy this wonderful item', 'bob', 'group-a').isSpam, false);
  assert.equal(check('Buy this wonderful item', 'alice', 'group-b').isSpam, false);
});

test('rate and duplicate counts expire at the window boundary', () => {
  const { check, advance } = setup();
  check('Buy this wonderful item');
  check('Buy this wonderful item');
  advance(60000);
  assert.equal(check('Buy this wonderful item').isSpam, false);
});

test('the eighth message within a minute triggers flood detection', () => {
  const { check } = setup();
  for (let i = 0; i < 7; i++) assert.equal(check(`Message number ${i}`).isSpam, false);
  const eighth = check('One more distinct message');
  assert.equal(eighth.isSpam, true);
  assert.ok(eighth.reasons.some(r => r.code === 'flood'));
});

test('empty media captions count for flooding without matching keywords', () => {
  const { check } = setup();
  for (let i = 0; i < 7; i++) assert.equal(check('').score, 0);
  assert.equal(check('').isSpam, true);
});

test('trusted senders bypass detection', () => {
  const { check, detector } = setup(c => { c.trustedSenderIds = ['alice']; });
  assert.equal(check('claim your prize free money').isSpam, false);
  assert.equal(detector.history.size, 0);
});

test('state is bounded and stores hashes instead of message text', () => {
  const config = loadConfig();
  const detector = new SpamDetector(config, { maxSenders: 3 });
  for (let i = 0; i < 10; i++) detector.check({ chatId: 'group', senderId: `user-${i}`, text: 'Private message content' });
  assert.equal(detector.history.size, 3);
  assert.equal(JSON.stringify([...detector.history]).includes('Private message content'), false);
});

test('invalid thresholds, cooldowns, group IDs and malformed rules fail early', () => {
  for (const change of [
    c => { c.threshold = -1; },
    c => { c.deletion.enabled = 'true'; },
    c => { c.deletion.threshold = 1; },
    c => { c.deletion.minIntervalSeconds = 0; },
    c => { c.deletion.maxPerHour = 0; },
    c => { c.deletion.maxPerDay = 1; },
    c => { c.warning.enabled = 'false'; },
    c => { c.warning.cooldownSeconds = 0; },
    c => { c.warning.maxPerHour = 0; },
    c => { c.warning.maxPerDay = 1; },
    c => { c.warning.groupCooldownSeconds = 0; },
    c => { c.groupIds = ['someone@c.us']; },
    c => { c.keywords.push({ phrase: '', score: 5 }); },
    c => { c.links.blockedDomains = ['https://example.org']; },
    c => { c.repetition.messageLimit = 0; }
  ]) {
    const config = loadConfig();
    change(config);
    assert.throws(() => validateConfig(config), /Config:/);
  }
});
