'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SafetyStore, createWarningGate, createDeletionGate, emptyState } = require('../src/safety');
const { loadConfig } = require('../src/config');

function directory(t) {
  const root = path.resolve(process.env.SPAM_BOT_TEST_TMP || os.tmpdir());
  fs.mkdirSync(root, { recursive: true });
  const location = fs.mkdtempSync(path.join(root, 'spam-bot-safety-'));
  t.after(() => {
    if (path.dirname(location) !== root || !path.basename(location).startsWith('spam-bot-safety-')) throw new Error('Unsafe test cleanup path.');
    fs.rmSync(location, { recursive: true, force: true });
  });
  return location;
}

function gateFixture(overrides = {}) {
  let now = 1800000000000;
  const state = emptyState();
  const config = { ...loadConfig().warning, ...overrides };
  return { state, config, clock: () => now, advance: ms => { now += ms; } };
}

test('two processes cannot own the same session lock', t => {
  const location = directory(t);
  const first = new SafetyStore(location);
  const second = new SafetyStore(location);
  first.acquire();
  assert.throws(() => second.acquire(), /instance lock/);
  first.release();
  second.acquire();
  second.release();
});

test('release does not delete a lock owned by someone else', t => {
  const location = directory(t);
  const store = new SafetyStore(location);
  store.acquire();
  fs.writeFileSync(store.lockFile, JSON.stringify({ pid: process.pid, token: 'another-owner' }));
  store.release();
  assert.equal(fs.existsSync(store.lockFile), true);
});

test('connection pause survives a restart and blocks acquisition', t => {
  const location = directory(t);
  new SafetyStore(location).pauseConnection('TOS_BLOCK');
  assert.throws(() => new SafetyStore(location).acquire(), /Connection paused after TOS_BLOCK/);
});

test('resume requires deliberate phone review and does not connect', t => {
  const store = new SafetyStore(directory(t));
  store.pauseConnection('AUTH_FAILURE');
  assert.throws(() => store.resume(), /phone app/);
  store.resume({ reviewed: true });
  store.assertConnectionAllowed();
  assert.equal(fs.existsSync(store.lockFile), false);
});

test('resume refuses to release a running instance', t => {
  const store = new SafetyStore(directory(t), { isAlive: () => true });
  store.acquire();
  assert.throws(() => store.resume({ reviewed: true }), /still running/);
  store.release();
});

test('stale locks require manual resume instead of an automatic retry', t => {
  const store = new SafetyStore(directory(t), { pid: 12345, isAlive: () => false });
  store.acquire();
  const restarted = new SafetyStore(store.directory, { isAlive: () => false });
  assert.throws(() => restarted.acquire(), /instance lock/);
  restarted.resume({ reviewed: true });
  restarted.acquire();
  restarted.release();
});

test('invalid persisted state fails closed', t => {
  const location = directory(t);
  fs.writeFileSync(path.join(location, 'safety.json'), '{"warningAttempts":"broken"}');
  assert.throws(() => new SafetyStore(location), /Safety state is invalid/);
});

test('hourly cap applies across all senders and groups', () => {
  const f = gateFixture();
  const gate = createWarningGate(f);
  for (let i = 0; i < 4; i++) {
    assert.equal(gate.reserve(`group-${i}`, `sender-${i}`), true);
    f.advance(20000);
  }
  assert.equal(gate.reserve('another-group', 'another-sender'), false);
  f.advance(3600000);
  assert.equal(gate.reserve('another-group', 'another-sender'), true);
});

test('daily cap survives several rolling hourly windows', () => {
  const f = gateFixture({ maxPerHour: 1, maxPerDay: 2 });
  const gate = createWarningGate(f);
  assert.equal(gate.reserve('g', 's'), true);
  f.advance(3600000);
  assert.equal(gate.reserve('g', 's'), true);
  f.advance(3600000);
  assert.equal(gate.reserve('g', 's'), false);
  f.advance(86400000);
  assert.equal(gate.reserve('g', 's'), true);
});

test('group and sender cooldowns apply independently', () => {
  const f = gateFixture({ cooldownSeconds: 600, groupCooldownSeconds: 300 });
  const gate = createWarningGate(f);
  assert.equal(gate.reserve('g', 'alice'), true);
  f.advance(20000);
  assert.equal(gate.reserve('g', 'bob'), false);
  assert.equal(gate.reserve('other-group', 'bob'), true);
  f.advance(280000);
  assert.equal(gate.reserve('g', 'alice'), false);
  assert.equal(gate.reserve('g', 'bob'), true);
});

test('warning reservations and pauses survive restarts, and resume keeps the budget', t => {
  const f = gateFixture({ maxPerHour: 1, maxPerDay: 1 });
  const location = directory(t);
  const store = new SafetyStore(location, { clock: f.clock });
  const first = createWarningGate({ ...f, state: store.state, save: () => store.save() });
  assert.equal(first.reserve('g', 's'), true);
  first.pause('SEND_FAILURE');
  const restarted = new SafetyStore(location, { clock: f.clock });
  const second = createWarningGate({ ...f, state: restarted.state, save: () => restarted.save() });
  assert.equal(second.paused, true);
  restarted.resume({ reviewed: true });
  assert.equal(second.paused, false);
  f.advance(20000);
  assert.equal(second.reserve('other-group', 'other-sender'), false);
  assert.equal(JSON.stringify(restarted.state).includes('other-sender'), false);
});

test('a disk persistence failure never authorizes a network send', () => {
  const f = gateFixture();
  const gate = createWarningGate({ ...f, save: () => { throw new Error('disk full'); } });
  assert.throws(() => gate.reserve('g', 's'), /disk full/);
});

test('clock rollback prevents sends until existing timestamps are no longer in the future', () => {
  const f = gateFixture();
  const gate = createWarningGate(f);
  assert.equal(gate.reserve('g', 's'), true);
  f.advance(-10000);
  assert.equal(gate.reserve('other-group', 'other-sender'), false);
});

test('deletion budget, duplicate IDs and minimum intervals survive restart and manual resume', t => {
  const location = directory(t);
  let now = 1800000000000;
  const clock = () => now;
  const config = { ...loadConfig().deletion, maxPerHour: 2, maxPerDay: 2 };
  const store = new SafetyStore(location, { clock });
  const first = createDeletionGate({ config, clock, state: store.state, save: () => store.save() });
  assert.equal(first.reserve('group', 'first'), true);
  assert.equal(first.reserve('group', 'second'), false);
  now += 2000;
  assert.equal(first.reserve('group', 'first'), false);
  first.pause('DELETE_FAILURE');
  const restarted = new SafetyStore(location, { clock });
  const second = createDeletionGate({ config, clock, state: restarted.state, save: () => restarted.save() });
  assert.equal(second.paused, true);
  assert.equal(second.reserve('group', 'second'), false);
  restarted.resume({ reviewed: true });
  assert.equal(second.reserve('group', 'second'), true);
  now += 3600000;
  assert.equal(second.reserve('group', 'third'), false);
  now += 86400000;
  assert.equal(second.reserve('group', 'third'), true);
  assert.equal(restarted.state.deletionAttempts.some(x => x.group === 'group' || x.message === 'third'), false);
});

test('connection pause, clock rollback and persistence failure prevent deletion', () => {
  const config = loadConfig().deletion;
  const state = emptyState();
  let now = 1800000000000;
  const gate = createDeletionGate({ config, state, clock: () => now });
  assert.equal(gate.reserve('g', 'one'), true);
  now -= 10000;
  assert.equal(gate.reserve('g', 'two'), false);
  now += 20000;
  state.connectionPause = { reason: 'AUTH_FAILURE', time: now };
  assert.equal(gate.reserve('g', 'two'), false);
  const failed = createDeletionGate({ config, save: () => { throw new Error('disk full'); } });
  assert.throws(() => failed.reserve('g', 'one'), /disk full/);
});

test('older valid safety state gains deletion fields without losing warning history', t => {
  const location = directory(t);
  const old = { connectionPause: null, warningPause: null, warningAttempts: [{ time: 123, group: 'g', sender: 's' }] };
  fs.writeFileSync(path.join(location, 'safety.json'), JSON.stringify(old));
  const store = new SafetyStore(location);
  assert.deepEqual(store.state.warningAttempts, old.warningAttempts);
  assert.equal(store.state.deletionPause, null);
  assert.deepEqual(store.state.deletionAttempts, []);
});

test('corrupt persisted deletion state refuses startup', t => {
  const location = directory(t);
  fs.writeFileSync(path.join(location, 'safety.json'), JSON.stringify({ ...emptyState(), deletionAttempts: 'broken' }));
  assert.throws(() => new SafetyStore(location), /Safety state is invalid/);
});


test('dead CLI summary locks are reclaimed without clearing pauses or budgets; live locks are refused', t => {
  const dir = directory(t);
  const store = new SafetyStore(dir, { isAlive: () => false });
  store.state.aiAttempts = [{ time: 1, chat: 'hash' }];
  store.state.replyPause = { time: 1, reason: 'SEND_FAILURE' };
  store.save();
  fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: 123, token: 'dead', purpose: 'summary' }));
  store.acquire({ purpose: 'summary' });
  assert.equal(store.state.replyPause.reason, 'SEND_FAILURE');
  assert.equal(store.state.aiAttempts.length, 1);
  const alive = new SafetyStore(dir, { isAlive: () => true });
  assert.throws(() => alive.acquire({ purpose: 'summary' }), /instance lock/);
  store.release();
});
