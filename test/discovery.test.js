'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDiscovery } = require('../src/discovery');
const { createRouter } = require('../src/router');
const { tempDirectory } = require('./helpers');

function fixture(t, extra = {}) {
  const filename = path.join(tempDirectory(t), 'discovered-chats.json');
  const logs = [];
  let lookups = 0;
  const config = { discoveryPhrase: '!bot discover' };
  const options = { filename, getConfig: () => config, log: line => logs.push(line),
    getChat: async id => { lookups++; return { id: { _serialized: id }, name: 'Class', isGroup: true }; }, ...extra };
  const message = { fromMe: true, type: 'chat', body: config.discoveryPhrase };
  return { filename, logs, options, message, get lookups() { return lookups; } };
}

test('discovery rejects mismatched identities without saving or announcing a discovered chat', async t => {
  const f = fixture(t, { getChat: async () => ({ id: { _serialized: 'other@g.us' } }) });
  const discover = createDiscovery(f.options);
  // Errors are metadata warnings; an exact owner command still posts nothing.
  assert.equal(await discover(f.message, '123@g.us'), true);
  assert.equal(fs.existsSync(f.filename), false);
  assert.ok(f.logs.some(x => /identity mismatch/i.test(x)));
  assert.ok(!f.logs.some(x => x.startsWith('[DISCOVERED]')));
});

test('discovery validates chat IDs before any metadata lookup', async t => {
  const f = fixture(t);
  const discover = createDiscovery(f.options);
  for (const id of ['../123@g.us', '123@g.us/extra', '123@broadcast', '123@evil', '123@g.us\n']) {
    await discover(f.message, id);
  }
  assert.equal(f.lookups, 0);
  assert.equal(fs.existsSync(f.filename), false);
  await discover(f.message, '123@newsletter');
  assert.equal(f.lookups, 1, 'channels may be recorded as metadata only');
});

test('corrupt discovery metadata is set aside with a warning and discovery continues', async t => {
  for (const bad of ['{broken', '{}', '[{"id":1}]']) {
    const f = fixture(t);
    fs.writeFileSync(f.filename, bad);
    const discover = createDiscovery(f.options);
    const quarantined = fs.readdirSync(path.dirname(f.filename)).find(x => x.includes('.bad-'));
    assert.ok(quarantined);
    assert.equal(fs.readFileSync(path.join(path.dirname(f.filename), quarantined), 'utf8'), bad);
    assert.ok(f.logs.some(x => /warning/i.test(x)));
    await discover(f.message, '123@g.us');
    assert.equal(JSON.parse(fs.readFileSync(f.filename, 'utf8'))[0].id, '123@g.us');
  }
});

test('a hung discovery lookup times out and the router processes the next message', async t => {
  const f = fixture(t, { getChat: () => new Promise(() => {}), timeoutMs: 20 });
  const discover = createDiscovery(f.options);
  let moderated = 0;
  const route = createRouter({ getConfig: () => ({ discoveryPhrase: '!bot discover', replyPrefix: 'BOT', archive: { enabled: false } }),
    getPolicies: () => new Map([['123@g.us', { receive: true }]]), discover,
    moderate: async () => { moderated++; }, startedAt: 0, archive: {}, commands: () => assert.fail('no commands'),
    log: () => {} });
  const msg = { ...f.message, to: '123@g.us', timestamp: Date.now() / 1000, id: { _serialized: 'owner' } };
  const timer = setTimeout(() => assert.fail('router queue stalled'), 1000);
  try {
    await Promise.all([route(msg), route({ ...msg, fromMe: false, from: '123@g.us', type: 'image', body: 'normal', id: { _serialized: 'next' } })]);
    assert.equal(moderated, 1);
    assert.ok(f.logs.some(x => /timed out/i.test(x)));
  } finally { clearTimeout(timer); }
});
