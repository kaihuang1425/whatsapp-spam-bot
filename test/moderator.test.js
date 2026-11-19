'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { createModerator } = require('../src/moderator');

function setup({ warnings = false, failReply = false } = {}) {
  const config = loadConfig();
  config.groupIds = ['123@g.us'];
  config.warning.enabled = warnings;
  config.deletion.enabled = false;
  const flags = [], replies = [], errors = [];
  let now = 1800000000000;
  let counter = 0;
  const moderate = createModerator({
    config, clock: () => now, sendGuard: { canWarn: () => true }, // These tests exercise warnings after the owner's first reply.
    onFlag: record => flags.push(record),
    onError: message => errors.push(message)
  });
  function message(overrides = {}) {
    return {
      from: '123@g.us', author: 'alice@lid', body: 'claim your prize',
      type: 'chat', timestamp: Math.floor(now / 1000), id: { _serialized: `message-${counter++}` },
      reply: async (...args) => {
        replies.push(args);
        if (failReply) throw new Error('network unavailable');
      },
      ...overrides
    };
  }
  return { moderate, message, flags, replies, errors, advance: ms => { now += ms; } };
}

test('preview mode records evidence without sending a reply or storing text', async () => {
  const f = setup();
  await f.moderate(f.message());
  assert.equal(f.flags.length, 1);
  assert.equal(f.flags[0].score, 5);
  assert.equal(Object.hasOwn(f.flags[0], 'text'), false);
  assert.equal(f.replies.length, 0);
});

test('ignores direct messages, unselected groups, self, status, broadcasts and system events', async () => {
  const f = setup({ warnings: true });
  for (const overrides of [
    { from: '123@c.us' }, { from: '999@g.us' }, { fromMe: true },
    { isStatus: true }, { broadcast: true }, { author: undefined }, { type: 'gp2' }
  ]) await f.moderate(f.message(overrides));
  assert.equal(f.flags.length, 0);
  assert.equal(f.replies.length, 0);
});

test('duplicate delivery of the same message produces one flag and one reply', async () => {
  const f = setup({ warnings: true });
  const message = f.message();
  await Promise.all([f.moderate(message), f.moderate(message), f.moderate(message)]);
  assert.equal(f.flags.length, 1);
  assert.equal(f.replies.length, 1);
});

test('old, future-dated, missing-time and missing-ID messages are ignored', async () => {
  const f = setup({ warnings: true });
  for (const overrides of [
    { timestamp: 1800000000 - 121 }, { timestamp: 1800000000 + 121 },
    { timestamp: undefined }, { id: undefined }
  ]) await f.moderate(f.message(overrides));
  assert.equal(f.flags.length, 0);
});

test('sender cooldown prevents warning spam; flag logging continues', async () => {
  const f = setup({ warnings: true });
  await f.moderate(f.message());
  f.advance(20000);
  await f.moderate(f.message());
  assert.equal(f.replies.length, 1);
  f.advance(280000);
  await f.moderate(f.message());
  assert.equal(f.replies.length, 2);
  assert.equal(f.flags.length, 3);
});

test('a burst from multiple senders produces only one warning', async () => {
  const f = setup({ warnings: true });
  await Promise.all(Array.from({ length: 10 }, (_, i) => f.moderate(f.message({ author: `sender-${i}@lid` }))));
  assert.equal(f.flags.length, 10);
  assert.equal(f.replies.length, 1);
});

test('a failed send pauses all future replies while detection continues', async () => {
  const f = setup({ warnings: true, failReply: true });
  await f.moderate(f.message());
  f.advance(86400000);
  await f.moderate(f.message({ author: 'different@lid' }));
  assert.equal(f.flags.length, 2);
  assert.equal(f.replies.length, 1);
  assert.equal(f.errors.length, 1);
});

test('warnings do not echo the suspect message or link', async () => {
  const f = setup({ warnings: true });
  await f.moderate(f.message({ body: 'claim your prize https://spam.example/evil' }));
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0][0].includes('https://'), false);
  assert.equal(f.replies[0][2].linkPreview, false);
});

test('media captions can be checked without downloading attachments', async () => {
  const f = setup();
  await f.moderate(f.message({ type: 'image', hasMedia: true }));
  assert.equal(f.flags.length, 1);
});

test('warning sends are held at startup even when warnings and sending are configured on', async () => {
  const config = loadConfig();
  config.groupIds = ['123@g.us'];
  config.warning.enabled = true;
  config.deletion.enabled = false;
  let replies = 0, reservations = 0;
  const moderate = createModerator({ config, warningGate: { reserve() { reservations++; return true; } } });
  await moderate({ from: '123@g.us', author: 'alice@lid', body: 'claim your prize', type: 'chat',
    timestamp: Math.floor(Date.now() / 1000), id: { _serialized: 'startup-warning' }, reply: async () => { replies++; } });
  assert.equal(replies, 0);
  assert.equal(reservations, 0);
});

test('warning rechecks receive and send after an awaited flag callback', async () => {
  const config = loadConfig();
  config.warning.enabled = true;
  let policy = { receive: true, send: true, spam: 'flag' }, replies = 0;
  const moderate = createModerator({ config, sendGuard: { canWarn: () => true }, getPolicy: () => policy,
    onFlag: async () => { policy = { ...policy, send: false }; } });
  await moderate({ from: '123@g.us', author: 'alice@lid', body: 'claim your prize', type: 'chat',
    timestamp: Math.floor(Date.now() / 1000), id: { _serialized: 'reload-warning' }, reply: async () => { replies++; } });
  assert.equal(replies, 0);
});
