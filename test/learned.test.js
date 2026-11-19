'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LearnedSpam, linkKey } = require('../src/learned');
const { tempDirectory } = require('./helpers');

test('links are matched exactly: host, path and query, ignoring www, fragment and a trailing slash', () => {
  assert.equal(linkKey('https://WWW.Example.net/a/b/?x=1#top'), 'example.net/a/b?x=1');
  assert.equal(linkKey('bit.ly/abc'), 'bit.ly/abc');
  assert.notEqual(linkKey('https://youtube.com/watch?v=1'), linkKey('https://youtube.com/watch?v=2'));
});

test('marked spam is saved, reloaded and matched; other text and links are not', t => {
  const file = path.join(tempDirectory(t), 'data', 'learned-spam.json');
  const store = new LearnedSpam(file);
  const text = 'exclusive offer for members only, visit https://odd.example.net/p?id=7';
  assert.deepEqual(store.learn(text, ['https://odd.example.net/p?id=7']), { text: true, links: ['odd.example.net/p?id=7'], skippedLinks: [] });
  assert.deepEqual(store.learn(text, ['https://odd.example.net/p?id=7']), { text: false, links: [], skippedLinks: [] }, 'learning twice adds nothing');
  const reloaded = new LearnedSpam(file);
  assert.deepEqual(reloaded.size, { texts: 1, links: 1 });
  assert.deepEqual(reloaded.match(text, []), ['text you marked as spam']);
  assert.deepEqual(reloaded.match('hello', ['https://www.odd.example.net/p/?id=7']), ['link you marked as spam: odd.example.net/p?id=7']);
  assert.deepEqual(reloaded.match('exclusive offer for members only', ['https://odd.example.net/p?id=8']), []);
});

test('short or generic texts without a link are never learned, so a scam opener cannot delete every greeting', () => {
  const store = new LearnedSpam(null);
  for (const text of ['ok thanks', 'hello, how are you doing today?', 'good morning everyone, have a blessed day 🙏']) {
    assert.deepEqual(store.learn(text, []), { text: false, links: [], skippedLinks: [] }, text);
    assert.deepEqual(store.match(text, []), []);
  }
  assert.equal(store.learn('this exact long scam message is more than sixty characters long, no link at all', []).text, true);
});

test('bare sites are never learned; paths keep their case and ports count', () => {
  const store = new LearnedSpam(null);
  const added = store.learn('see https://www.binance.com and https://bit.ly/FreeIphone17 and http://odd.example.net:8080/x',
    ['https://www.binance.com', 'https://bit.ly/FreeIphone17', 'http://odd.example.net:8080/x']);
  assert.deepEqual(added.links, ['bit.ly/FreeIphone17', 'odd.example.net:8080/x']);
  assert.deepEqual(added.skippedLinks, ['binance.com']);
  assert.deepEqual(store.match('x', ['https://www.binance.com/']), []);
  assert.deepEqual(store.match('x', ['https://bit.ly/freeiphone17']), []);
  assert.deepEqual(store.match('x', ['http://odd.example.net/x']), []);
  assert.equal(store.match('x', ['https://bit.ly/FreeIphone17']).length, 1);
});

test('a damaged learned-spam file stops startup; an empty or BOM-prefixed file is fine', t => {
  const dir = tempDirectory(t);
  const file = path.join(dir, 'learned-spam.json');
  fs.writeFileSync(file, '{"texts": "broken"}');
  assert.throws(() => new LearnedSpam(file), /not a learned-spam file/);
  fs.writeFileSync(file, '{"texts": [], ');
  assert.throws(() => new LearnedSpam(file), /not valid JSON/);
  fs.writeFileSync(file, '');
  assert.deepEqual(new LearnedSpam(file).size, { texts: 0, links: 0 });
  fs.writeFileSync(file, '﻿{"texts": [], "links": [{"link": "a.example/x", "time": "t"}]}');
  assert.deepEqual(new LearnedSpam(file).size, { texts: 0, links: 1 });
});
