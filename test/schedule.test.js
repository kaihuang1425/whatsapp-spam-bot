'use strict';

// The 6 November fixes: AI jobs only at set times or when the owner asks, Chrome's leftover profile lock, message
// times in London time, and clearer messages (empty repository, a chat's folder not read, INDEX.md first).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { loadConfig, validateConfig } = require('../src/config');
const { buildPolicies } = require('../src/chats');
const { SafetyStore, createReplyGate } = require('../src/safety');
const { createSummaryService } = require('../src/summarise');
const { createCommands } = require('../src/commands');
const { Archive } = require('../src/archive');
const { Items } = require('../src/items');
const { scheduledSlot } = require('../src/when');
const { createSpottingSchedule, condenseWindowOpen } = require('../src/schedule');
const { clearStaleProfileLock, isBrowserLaunchFailure } = require('../src/profile-lock');
const { createHubSync, createHubLock } = require('../src/sync');
const { tempDirectory } = require('./helpers');

const A = '111@g.us', B = '222@g.us';
const LONDON = 'Europe/London';
const MIN = 60000, HOUR = 3600000;
const at = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi);

test('a scheduled slot is the hour (or window) after a set local time, across midnight and summer time', () => {
  // Winter: London is UTC.
  assert.equal(scheduledSlot(at(2026, 11, 6, 19, 59), LONDON, ['20:00'], 60), null);
  assert.equal(scheduledSlot(at(2026, 11, 6, 20, 0), LONDON, ['20:00'], 60), '2026-11-06 20:00');
  assert.equal(scheduledSlot(at(2026, 11, 6, 20, 59), LONDON, ['20:00'], 60), '2026-11-06 20:00');
  assert.equal(scheduledSlot(at(2026, 11, 6, 21, 0), LONDON, ['20:00'], 60), null);
  // Summer: 20:00 in London is 19:00 UTC.
  assert.equal(scheduledSlot(at(2027, 6, 1, 19, 30), LONDON, ['20:00'], 60), '2027-06-01 20:00');
  assert.equal(scheduledSlot(at(2027, 6, 1, 20, 30), LONDON, ['20:00'], 60), null);
  // A window that runs past midnight belongs to the day it started.
  assert.equal(scheduledSlot(at(2026, 11, 7, 0, 15), LONDON, ['23:30'], 60), '2026-11-06 23:30');
  assert.equal(scheduledSlot(at(2026, 11, 6, 9, 10), LONDON, ['07:00', '09:00'], 60), '2026-11-06 09:00');
  assert.equal(scheduledSlot(at(2026, 11, 6, 9, 10), LONDON, [], 60), null);
  const config = loadConfig();
  assert.equal(config.summary.condenseAt, '04:00');
  assert.equal(condenseWindowOpen(config, at(2026, 11, 6, 3, 59)), false);
  assert.equal(condenseWindowOpen(config, at(2026, 11, 6, 4, 0)), true);
  assert.equal(condenseWindowOpen(config, at(2026, 11, 6, 6, 59)), true);
  assert.equal(condenseWindowOpen(config, at(2026, 11, 6, 7, 0)), false);
  assert.throws(() => validateConfig({ ...structuredClone(config), summary: { ...config.summary, condenseAt: '4am' } }), /condenseAt/);
  assert.throws(() => validateConfig({ ...structuredClone(config), reminders: { ...config.reminders, detectTimes: ['20:00', '20:00'] } }), /detectTimes/);
  assert.throws(() => validateConfig({ ...structuredClone(config), reminders: { ...config.reminders, detectTimes: ['24:00'] } }), /detectTimes/);
  validateConfig({ ...structuredClone(config), reminders: { ...config.reminders, detectTimes: [] } });
});

function scheduleFixture({ chats, provider = 'api', detect } = {}) {
  let now = at(2026, 11, 6, 19, 0);
  const config = { reminders: { ...loadConfig().reminders, detectTimes: ['20:00'] }, summary: { provider } };
  const runs = [], purged = [], logs = [], errors = [];
  const policies = new Map(chats.map(chat => [chat.id, chat]));
  const tick = createSpottingSchedule({ getPolicies: () => policies, getConfig: () => config, clock: () => now,
    detect: detect || (async ({ chatId }) => { runs.push(chatId); return { done: true, added: [], text: 'Looked at 1 new messages: nothing new to add.' }; }),
    purge: chatId => purged.push(chatId), log: line => logs.push(line), onError: line => errors.push(line) });
  return { tick, runs, purged, logs, errors, config, advance: ms => { now += ms; } };
}

test('spotting runs on its own only in the hour after a set time, once per chat, and only in chats with detect on', async () => {
  const s = scheduleFixture({ chats: [{ id: A, ai: true, detect: true }, { id: B, ai: true, detect: false }, { id: 'c@g.us', ai: false, detect: true }] });
  assert.equal(await s.tick(), 0);
  assert.deepEqual(s.runs, []);
  assert.deepEqual(s.purged.sort(), [A, B, 'c@g.us'].sort());
  s.advance(HOUR);
  assert.equal(await s.tick(), 1);
  s.advance(MIN);
  assert.equal(await s.tick(), 0);
  s.advance(HOUR);
  assert.equal(await s.tick(), 0);
  assert.deepEqual(s.runs, [A]);
  // The next day's slot runs again.
  s.advance(23 * HOUR);
  await s.tick();
  assert.deepEqual(s.runs, [A, A]);
  // Lists are tidied every 10 minutes, whatever the time.
  assert.equal(s.purged.filter(id => id === A).length >= 3, true);
});

test('a scheduled run that met a busy AI is tried again within the hour; any other skip is final', async () => {
  let answer = 'another AI request is running.';
  const tried = [];
  const s = scheduleFixture({ chats: [{ id: A, ai: true, detect: true }],
    detect: async ({ chatId }) => { tried.push(chatId); return { done: false, added: [], text: answer }; } });
  s.advance(HOUR);
  await s.tick();
  s.advance(MIN);
  answer = 'no new messages.';
  await s.tick();
  s.advance(MIN);
  await s.tick();
  assert.equal(tried.length, 2);
});

test('with the subscription, one scheduled AI run a minute', async () => {
  const s = scheduleFixture({ provider: 'claude-code', chats: [{ id: A, ai: true, detect: true }, { id: B, ai: true, detect: true }] });
  s.advance(HOUR);
  assert.equal(await s.tick(), 1);
  s.advance(MIN);
  assert.equal(await s.tick(), 1);
  assert.deepEqual(s.runs.sort(), [A, B]);
});

function botFixture(t, { chat = {}, provider } = {}) {
  const config = loadConfig();
  config.chats = [{ id: A, label: 'Class', receive: true, send: true, buzzword: '!bot', ai: true, hub: 'class', ...chat }];
  validateConfig(config);
  const policies = buildPolicies(config);
  const directory = tempDirectory(t, 'spam-bot-fixes-');
  const archive = new Archive(path.join(directory, 'archive'));
  const items = new Items(path.join(directory, 'items'));
  const safety = new SafetyStore(path.join(directory, 'runtime'));
  const hubsRoot = path.join(directory, 'hubs');
  fs.mkdirSync(path.join(hubsRoot, 'class'), { recursive: true });
  let now = at(2027, 7, 1, 23, 40);
  const clock = () => now;
  const requests = [];
  let answer = '[]';
  const service = createSummaryService({ getConfig: () => config, getPolicies: () => policies, archive, safety, items, hubsRoot,
    getSecret: () => Buffer.alloc(32), clock, replyGate: createReplyGate({ config: config.replies, state: safety.state, clock }),
    provider: provider || (async request => { requests.push(request); return typeof answer === 'function' ? answer(request) : answer; }) });
  const commands = createCommands({ getConfig: () => config, items, clock, summaryService: service, hubsRoot });
  const own = text => ({ fromMe: true, to: A, type: 'chat', body: `!bot ${text}`, id: { _serialized: 'm' } });
  const run = (text, { fromMe = true } = {}) => commands(policies.get(A), text, { fromMe, message: fromMe ? own(text) : { fromMe: false, from: A, type: 'chat', body: `!bot ${text}` } });
  return { config, policies, archive, items, service, requests, run, set answer(value) { answer = value; }, advance: ms => { now += ms; },
    add: record => archive.write(A, { chat: A, fromMe: false, sender: 'alice@lid', kind: 'chat', ...record }), get now() { return now; } };
}

test('"spot": the owner asks for a check now, in any chat with AI on, and sees what was found', async t => {
  const f = botFixture(t, { chat: { detect: false } });
  f.add({ id: 's1', ts: Math.floor(f.now / 1000) - 60, text: 'Please bring the forms tomorrow' });
  assert.equal(await f.run('spot', { fromMe: false }), 'Only the owner of this bot can start a check for requests.');
  assert.equal(f.requests.length, 0);
  f.answer = '[{"text": "Bring the forms", "due": "2027-07-03T09:00"}]';
  const reply = await f.run('spot');
  assert.match(reply, /^Looked at 1 new messages: 1 suggestion added\.\n1\. Bring the forms \(due Sat 3 Jul 09:00\)\nKeep one with !bot keep N \[when\], or remove it with !bot drop N\.$/);
  // A second ask soon after waits for the cooldown, not for the hour between scheduled runs.
  f.advance(5 * 1000);
  assert.match(await f.run('spot'), /^Not looked at: please wait 60s between checks\.$/);
  f.advance(61 * 1000);
  assert.match(await f.run('spot'), /^Not looked at: no new messages\.$/);
  assert.match(await f.run('spot now'), /Usage: !bot spot/);
  assert.match(await f.run('help'), /!bot spot - look for requests/);
  assert.doesNotMatch(await f.run('help', { fromMe: false }), /!bot spot/);
});

test('summaries, questions and condensing show message times in London time and say so', async t => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Taipei';
  t.after(() => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; });
  const f = botFixture(t);
  f.add({ id: 'l1', ts: Date.UTC(2027, 6, 1, 23, 30) / 1000, text: 'Meet at the lab tomorrow' });
  f.answer = '- Lab tomorrow';
  await f.service({ chatId: A, source: 'cli', hours: 24 });
  assert.match(f.requests[0].transcript, /^\[Fri 02 Jul 00:30\]/);
  assert.match(f.requests[0].system, /Message times in the transcript are Europe\/London time\./);
});

test('a question says why the chat\'s folder was not read, also when there are no messages', async t => {
  const f = botFixture(t);
  const answer = await f.service({ chatId: A, source: 'cli', question: 'what files are there?' });
  assert.match(answer, /^Question not run: No archived messages in the last 24h\. \(This chat's files were not read: only questions on the subscription, summary\.provider "claude-code", read them\.\)$/);
  const g = botFixture(t, { chat: { hub: 'missing' } });
  g.config.summary.provider = 'claude-code';
  const missing = await g.service({ chatId: A, source: 'cli', question: 'files?' });
  assert.match(missing, /hubs\/missing\/ is missing or is not a plain folder/);
});

test('with the subscription, the AI is told to read INDEX.md first', async t => {
  const f = botFixture(t);
  f.config.summary.provider = 'claude-code';
  f.answer = 'one file';
  const answer = await f.service({ chatId: A, source: 'cli', question: 'what files are there?' });
  assert.match(answer, /^Answer \(last 24h, 0 messages, files\):/);
  assert.match(f.requests[0].system, /If there is an INDEX\.md, read it first/);
});

test('Chrome\'s leftover profile lock is cleared only when the Chrome that left it has certainly ended', () => {
  const fake = target => {
    const removed = [];
    return { removed, fsApi: {
      readlinkSync: () => { if (target === null) { const e = new Error('none'); e.code = 'ENOENT'; throw e; } return target; },
      unlinkSync: file => { removed.push(path.basename(file)); }
    } };
  };
  let f = fake(null);
  assert.deepEqual(clearStaleProfileLock('/p', { holdsInstanceLock: true, fsApi: f.fsApi }), {});
  // Same machine, process gone.
  f = fake('console13-4671');
  assert.deepEqual(clearStaleProfileLock('/p', { hostname: 'console13', isAlive: () => false, fsApi: f.fsApi }), { cleared: 'console13-4671' });
  assert.deepEqual(f.removed, ['SingletonLock', 'SingletonCookie', 'SingletonSocket']);
  // Same machine, still running: left alone, even with the instance lock.
  f = fake('console13-4671');
  const live = clearStaleProfileLock('/p', { holdsInstanceLock: true, hostname: 'console13', isAlive: () => true, fsApi: f.fsApi });
  assert.match(live.reason, /Chrome process 4671 on this machine is still running/);
  assert.deepEqual(f.removed, []);
  // Another machine: only with the bot's instance lock held.
  f = fake('erich1425-266296-deployment-f9ff9958f-ntvpk-396');
  assert.match(clearStaleProfileLock('/p', { hostname: 'console13', fsApi: f.fsApi }).reason, /another machine/);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(clearStaleProfileLock('/p', { holdsInstanceLock: true, hostname: 'console13', fsApi: f.fsApi }),
    { cleared: 'erich1425-266296-deployment-f9ff9958f-ntvpk-396' });
  // Chrome itself failing to start is not a WhatsApp problem: no pause.
  assert.equal(isBrowserLaunchFailure(new Error('Failed to launch the browser process! Code: 21 ... profile appears to be in use')), true);
  assert.equal(isBrowserLaunchFailure(new Error('auth timeout')), false);
});

test('a real leftover lock link in a profile folder is removed', { skip: process.platform === 'win32' && 'symbolic links' }, t => {
  const profile = tempDirectory(t, 'spam-bot-profile-');
  fs.symlinkSync('another-machine-396', path.join(profile, 'SingletonLock'));
  fs.symlinkSync('1234', path.join(profile, 'SingletonCookie'));
  fs.writeFileSync(path.join(profile, 'Preferences'), '{}');
  // The profile was just written: a Chrome may still be using it.
  assert.match(clearStaleProfileLock(profile, { holdsInstanceLock: true }).reason, /less than 3 minutes ago/);
  // Five minutes later it is left over.
  assert.deepEqual(clearStaleProfileLock(profile, { holdsInstanceLock: true, now: Date.now() + 5 * 60 * 1000 }), { cleared: 'another-machine-396' });
  assert.deepEqual(fs.readdirSync(profile), ['Preferences']);
});

const hasGit = spawnSync('git', ['--version']).status === 0;
test('cloning an empty repository says so, and leaves the folder and git data as they were', { skip: !hasGit && 'git not installed' }, async t => {
  const root = tempDirectory(t, 'spam-bot-empty-');
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1' };
  assert.equal(spawnSync('git', ['init', '-q', '--bare', 'origin.git'], { cwd: root, env }).status, 0);
  fs.mkdirSync(path.join(root, 'hubs', 'family1'), { recursive: true });
  const gitRoot = path.join(root, 'data', 'hub-git');
  const sync = createHubSync({ hubsRoot: path.join(root, 'hubs'), gitRoot, hubLock: createHubLock(gitRoot), log: () => {},
    getLimits: () => ({ maxFileMiB: 25, maxTotalMiB: 200, maxFiles: 5000 }), env });
  const result = await sync.clone({ id: A, label: 'Mum', hub: 'family1' }, { url: pathToFileURL(path.join(root, 'origin.git')).href });
  assert.equal(result, 'Not cloned: the repository is empty. Add a file to it on GitHub first, then run this again.');
  assert.deepEqual(fs.readdirSync(path.join(root, 'hubs', 'family1')), []);
  assert.equal(fs.existsSync(path.join(gitRoot, 'family1.git')), false);
});

test('the instance lock knows its machine: resume from a console cannot break a live worker\'s lock on another machine', t => {
  const dir = tempDirectory(t, 'spam-bot-lock-');
  let now = 1800000000000;
  const worker = new SafetyStore(dir, { hostname: 'deployment-pod', pid: 396, clock: () => now, heartbeatMs: 0, isAlive: () => true });
  worker.acquire();
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'instance.lock'), 'utf8'));
  assert.equal(lock.host, 'deployment-pod');
  assert.equal(lock.beat, now);
  // On the console machine process 396 does not exist, but the worker showed a sign of life a minute ago.
  const console1 = new SafetyStore(dir, { hostname: 'blue-liveconsole13', pid: 5062, clock: () => now + 60 * 1000, heartbeatMs: 0, isAlive: () => false });
  assert.throws(() => console1.resume({ reviewed: true }), /The bot is still running \(process 396 on deployment-pod, last sign of life 60s ago\)/);
  assert.throws(() => console1.acquire(), /instance lock already exists \(process 396 on deployment-pod/);
  // The worker keeps beating, so later checks see it alive too.
  now += 2.5 * 60 * 1000;
  worker.beat();
  // 3.5 minutes after the first beat: without that refresh the lock would already look left over.
  const console2 = new SafetyStore(dir, { hostname: 'blue-liveconsole13', clock: () => now + 60 * 1000, heartbeatMs: 0, isAlive: () => false });
  assert.throws(() => console2.resume({ reviewed: true }), /still running/);
  // After 3 minutes without a sign of life the lock is left over, and resume clears it.
  const later = new SafetyStore(dir, { hostname: 'blue-liveconsole13', clock: () => now + 4 * 60 * 1000, heartbeatMs: 0, isAlive: () => true });
  later.resume({ reviewed: true });
  assert.equal(fs.existsSync(path.join(dir, 'instance.lock')), false);
});

test('a console summary\'s lock is only taken over from another machine once it has gone quiet', t => {
  const dir = tempDirectory(t, 'spam-bot-lock-');
  let now = 1800000000000;
  const cli = new SafetyStore(dir, { hostname: 'blue-liveconsole13', pid: 777, clock: () => now, heartbeatMs: 0 });
  cli.acquire({ purpose: 'summary' });
  const worker = new SafetyStore(dir, { hostname: 'deployment-pod', clock: () => now + 90 * 1000, heartbeatMs: 0, isAlive: () => false });
  assert.throws(() => worker.acquire(), /instance lock already exists \(process 777 on blue-liveconsole13/);
  const quiet = new SafetyStore(dir, { hostname: 'deployment-pod', clock: () => now + 10 * 60 * 1000, heartbeatMs: 0, isAlive: () => true });
  quiet.acquire();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'instance.lock'), 'utf8')).host, 'deployment-pod');
  quiet.release();
  // A lock from before this version (no machine) is judged by its process, as before.
  fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: 12345, token: 'old', purpose: 'summary' }));
  new SafetyStore(dir, { isAlive: () => false, heartbeatMs: 0 }).acquire();
});

test('a Chrome lock is judged carefully: a reused process number, and a profile used minutes ago', () => {
  const removed = [];
  const fsApi = (mtimeMs, target = 'console13-4671') => ({
    readlinkSync: () => target,
    unlinkSync: file => removed.push(path.basename(file)),
    readdirSync: dir => (dir.endsWith('Default') ? ['Cookies', 'IndexedDB'] : ['Default', 'Local State', 'SingletonLock']),
    lstatSync: () => ({ mtimeMs }),
    readFileSync: () => 'sleep\u0000300\u0000'
  });
  const now = 1800000000000;
  // Same machine, the process number now belongs to something else: the lock is left over.
  assert.deepEqual(clearStaleProfileLock('/p', { hostname: 'console13', isAlive: () => true, fsApi: fsApi(now) }), { cleared: 'console13-4671' });
  // Another machine, profile written a minute ago: kept, even with the instance lock.
  const recent = clearStaleProfileLock('/p', { holdsInstanceLock: true, hostname: 'pod', now, fsApi: fsApi(now - 60 * 1000) });
  assert.match(recent.reason, /less than 3 minutes ago\. Wait a few minutes/);
  // ...and quiet for 5 minutes: cleared.
  assert.deepEqual(clearStaleProfileLock('/p', { holdsInstanceLock: true, hostname: 'pod', now, fsApi: fsApi(now - 5 * 60 * 1000) }), { cleared: 'console13-4671' });
  assert.equal(isBrowserLaunchFailure(new Error('Timed out after 30000 ms while waiting for the WS endpoint URL to appear in stdout!')), true);
});

test('"spot" runs no AI when its answer could not be posted', async t => {
  const f = botFixture(t);
  f.add({ id: 'q1', ts: Math.floor(f.now / 1000) - 60, text: 'Please bring the forms tomorrow' });
  f.policies.get(A).send = false;
  assert.match(await f.run('spot'), /^Not looked at: the answer could not be posted now/);
  f.policies.get(A).send = true;
  assert.equal(f.requests.length, 0);
});

test('a scheduled run blocked by a recent "spot" is tried again when the gap ends inside the hour', async () => {
  let answer = 'this chat was checked less than 60 minutes ago.';
  const tried = [];
  const s = scheduleFixture({ chats: [{ id: A, ai: true, detect: true }],
    detect: async ({ chatId }) => { tried.push(chatId); return answer === 'ok' ? { done: true, added: [], text: 'Looked at 1 new messages: nothing new to add.' } : { done: false, added: [], text: answer }; } });
  s.advance(HOUR);
  await s.tick();
  s.advance(20 * MIN);
  answer = 'ok';
  await s.tick();
  s.advance(MIN);
  await s.tick();
  assert.equal(tried.length, 2);
});
