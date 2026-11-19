'use strict';

// How hard the AI thinks: "!bot ask+" for one answer, "!bot effort <level> [hours]" for a chat for a while, and
// "--effort" for one console run. Owner only; temporary; condensing never changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadConfig, validateConfig } = require('../src/config');
const { buildPolicies, matchBuzzword } = require('../src/chats');
const { SafetyStore, createReplyGate } = require('../src/safety');
const { createSummaryService } = require('../src/summarise');
const { createCommands } = require('../src/commands');
const { Archive, ColdStore } = require('../src/archive');
const { Notes } = require('../src/notes');
const { Items } = require('../src/items');
const { EFFORTS, higherEffort, parseDuration, createEffortBoosts } = require('../src/effort');
const { tempDirectory } = require('./helpers');

const A = '111@g.us', B = '222@g.us';
const DAY = 86400;
const HOUR = 3600000;
const START = Date.UTC(2027, 6, 1, 12, 0); // 13:00 in London (summer time)

test('durations, the higher of two levels, and a boost that runs out on its own', () => {
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(parseDuration('2'), 2);
  assert.equal(parseDuration('2h'), 2);
  assert.equal(parseDuration('1.5hours'), 1.5);
  assert.equal(parseDuration('30m'), 0.5);
  assert.equal(parseDuration('45min'), 0.75);
  for (const bad of ['0', '0m', '-1', 'two', '2d', '', '1e3', '2 h']) assert.equal(parseDuration(bad), null, bad);
  assert.equal(higherEffort('high', 'low'), 'high');
  assert.equal(higherEffort('high', 'max'), 'max');
  assert.equal(higherEffort('medium', 'medium'), 'medium');
  let now = START;
  const boosts = createEffortBoosts({ clock: () => now });
  assert.equal(boosts.get(A), null);
  assert.equal(boosts.set(A, 'high', 2), START + 2 * HOUR);
  assert.deepEqual(boosts.get(A), { effort: 'high', until: START + 2 * HOUR });
  assert.equal(boosts.get(B), null);
  now += 2 * HOUR - 1;
  assert.equal(boosts.get(A).effort, 'high');
  now += 1;
  assert.equal(boosts.get(A), null);
  assert.equal(boosts.clear(A), false);
  boosts.set(A, 'max', 1);
  assert.equal(boosts.clear(A), true);
  assert.throws(() => boosts.set(A, 'huge', 1), /Unknown effort: huge/);
});

test('the boost settings are checked, and missing ones get their defaults', () => {
  const config = loadConfig();
  assert.equal(config.summary.boostEffort, 'high');
  assert.equal(config.summary.maxBoostHours, 12);
  const withSummary = summary => ({ ...structuredClone(config), summary: { ...config.summary, ...summary } });
  assert.throws(() => validateConfig(withSummary({ boostEffort: 'huge' })), /summary\.boostEffort must be low, medium, high, xhigh or max/);
  assert.throws(() => validateConfig(withSummary({ maxBoostHours: 0 })), /summary\.maxBoostHours must be a number of hours above 0 and at most 48/);
  assert.throws(() => validateConfig(withSummary({ maxBoostHours: 49 })), /maxBoostHours/);
  const old = structuredClone(config);
  delete old.summary.boostEffort;
  delete old.summary.maxBoostHours;
  const filled = validateConfig(old);
  assert.equal(filled.summary.boostEffort, 'high');
  assert.equal(filled.summary.maxBoostHours, 12);
});

function fixture(t, { withEfforts = true, ai = true, provider = 'api' } = {}) {
  const config = loadConfig();
  config.summary.provider = provider;
  // Room for several requests in a row; the limits themselves are tested elsewhere.
  config.summary.maxPerHour = 20;
  config.summary.maxPerDay = 50;
  config.chats = [
    { id: A, label: 'Team', receive: true, send: true, buzzword: '!bot', ai, keepDays: 7, aiPerDay: 10, ...(ai ? { detect: true } : {}) },
    { id: B, label: 'Other', receive: true, send: true, buzzword: '!bot', ai: true, detect: true }
  ];
  validateConfig(config);
  const policies = buildPolicies(config);
  const directory = tempDirectory(t, 'spam-bot-effort-');
  const archive = new Archive(path.join(directory, 'archive'));
  const safety = new SafetyStore(path.join(directory, 'runtime'));
  let now = START;
  const clock = () => now;
  const efforts = withEfforts ? createEffortBoosts({ clock }) : null;
  const requests = [];
  let answer = '- Demo at 15:00';
  const service = createSummaryService({ getConfig: () => config, getPolicies: () => policies, archive, safety, efforts,
    items: new Items(path.join(directory, 'items')), notes: new Notes(path.join(directory, 'notes')),
    cold: new ColdStore(path.join(directory, 'condensed')), getSecret: () => Buffer.alloc(32), clock,
    replyGate: createReplyGate({ config: config.replies, state: safety.state, clock }), log: () => {},
    provider: async request => { requests.push(request); return answer; } });
  const commands = createCommands({ getConfig: () => config, efforts, clock, summaryService: service });
  // As the router calls it: the command text is what the buzzword matching leaves, the message is as typed.
  const run = (text, { fromMe = true, chat = A } = {}) => {
    const policy = policies.get(chat);
    const body = `${policy.buzzword} ${text}`;
    return commands(policy, matchBuzzword(body, policy.buzzword), {
      fromMe, message: fromMe ? { fromMe: true, to: chat, type: 'chat', body, id: { _serialized: 'm' } }
        : { fromMe: false, from: chat, author: 'alice@lid', type: 'chat', body } });
  };
  const add = (chatId, record) => archive.write(chatId, { chat: chatId, fromMe: false, sender: 'alice@lid', kind: 'chat', ...record });
  return { config, archive, efforts, service, requests, run, add, set answer(value) { answer = value; },
    advance: ms => { now += ms; }, get now() { return now; } };
}

test('the owner sets the effort for a while; members cannot; it runs out and can be reset', async t => {
  const f = fixture(t);
  assert.equal(await f.run('effort'), 'AI effort in this chat: low (the default). Raise it for a while with !bot effort high 2h, or for one question with !bot ask+ <question>.');
  assert.equal(await f.run('effort high 2h'), 'AI effort in this chat: high until Thu 1 Jul 15:00 (London time), then low again. ' +
    'It applies to summaries, answers and spotted requests here; condensing stays at low. A restart also ends it. ' +
    'Answers take longer and use more of your plan or API credits.');
  assert.deepEqual(f.efforts.get(A), { effort: 'high', until: START + 2 * HOUR });
  assert.equal(f.efforts.get(B), null);
  assert.equal(await f.run('effort'), 'AI effort in this chat: high until Thu 1 Jul 15:00 (London time), then low again.');
  // Default length 1 hour; minutes; the level is not case-sensitive.
  assert.match(await f.run('effort MAX'), /^AI effort in this chat: max until Thu 1 Jul 14:00 /);
  assert.match(await f.run('effort xhigh 30m'), /^AI effort in this chat: xhigh until Thu 1 Jul 13:30 /);
  // Members get nothing, and nothing changes.
  for (const text of ['effort', 'effort max 12h', 'effort reset']) {
    assert.equal(await f.run(text, { fromMe: false }), 'Only the owner of this bot can change the AI effort.');
  }
  assert.equal(f.efforts.get(A).effort, 'xhigh');
  // Bad levels, bad lengths, too long, extra words.
  for (const text of ['effort huge', 'effort high 0', 'effort high 13h', 'effort high 2 days', 'effort high two', 'effort reset now']) {
    assert.match(await f.run(text), /^Usage: !bot effort \(show it\), !bot effort <low\|medium\|high\|xhigh\|max> \[hours, e\.g\. 2 or 30m; default 1, at most 12\]/, text);
  }
  assert.match(await f.run('effort high 12h'), /until Fri 2 Jul 01:00/);
  // Back to the default: reset, or naming the default level.
  assert.equal(await f.run('effort reset'), 'AI effort in this chat is back to low.');
  assert.equal(await f.run('effort reset'), 'AI effort in this chat is already low, the default.');
  await f.run('effort high');
  assert.equal(await f.run('effort low 3h'), 'AI effort in this chat: low, the default.');
  assert.equal(f.efforts.get(A), null);
  // Lowering below a higher default is allowed, and costs nothing extra.
  f.config.summary.effort = 'medium';
  const lower = await f.run('effort low 2h');
  assert.match(lower, /^AI effort in this chat: low until .* then medium again\./);
  assert.doesNotMatch(lower, /use more of your plan/);
  f.config.summary.effort = 'low';
  await f.run('effort off');
  // Time runs out.
  await f.run('effort high 30m');
  f.advance(30 * 60000);
  assert.match(await f.run('effort'), /^AI effort in this chat: low \(the default\)/);
});

test('the effort command needs AI on, and help lists ask+ and effort to the owner only', async t => {
  const off = fixture(t, { ai: false });
  assert.equal(await off.run('effort high 2h'), 'AI is off in this chat, so there is no effort to change.');
  const f = fixture(t);
  const help = await f.run('help');
  assert.match(help, /!bot ask\+ <question> - the same, thinking harder \(high effort\) for this one answer \(owner only\)/);
  assert.match(help, /!bot effort \[level \[hours\] \| reset\] - how hard the AI thinks in this chat for a while: low, medium, high, xhigh, max \(owner only\)/);
  const member = await f.run('help', { fromMe: false });
  assert.doesNotMatch(member, /ask\+|effort/);
  const g = fixture(t, { withEfforts: false });
  assert.doesNotMatch(await g.run('help'), /!bot effort/);
  assert.equal(await g.run('effort high'), 'Changing the AI effort is not available here.');
});

test('summaries, answers and spotting use the chat\'s effort while it lasts; condensing and other chats do not', async t => {
  const f = fixture(t);
  const ts = Math.floor(START / 1000);
  f.add(A, { id: 'a1', ts: ts - 600, text: 'Please finish the slides by 15:00' });
  f.add(B, { id: 'b1', ts: ts - 600, text: 'Please send the repo link' });
  f.add(A, { id: 'old1', ts: ts - 10 * DAY, text: 'Judging starts at 16:00 on Sunday' });
  await f.run('effort xhigh 3h');
  const step = () => f.advance(120 * 1000);
  const summary = await f.service({ chatId: A, source: 'cli', hours: 24 });
  assert.match(summary, /^Summary of the last 24h \(1 messages, xhigh effort\):/);
  step();
  const answer = await f.service({ chatId: A, source: 'cli', question: 'what is due?' });
  assert.match(answer, /^Answer \(last 24h, 1 messages, xhigh effort\):/);
  step();
  const other = await f.service({ chatId: B, source: 'cli', hours: 24 });
  assert.match(other, /^Summary of the last 24h \(1 messages\):/);
  step();
  f.answer = '[]';
  assert.equal((await f.service.detect({ chatId: A, source: 'cli' })).done, true);
  step();
  f.answer = '- Judging Sunday 16:00';
  assert.equal((await f.service.condense({ chatId: A, source: 'cli' })).done, true);
  assert.deepEqual(f.requests.map(r => [r.mode || (r.question ? 'ask' : 'summary'), r.effort]),
    [['summary', 'xhigh'], ['ask', 'xhigh'], ['summary', 'low'], ['detect', 'xhigh'], ['condense', 'low']]);
  // Three hours later it is gone.
  f.advance(3 * HOUR);
  f.answer = '- Slides';
  await f.service({ chatId: A, source: 'cli', hours: 24 });
  assert.equal(f.requests.pop().effort, 'low');
});

test('"ask+" answers one question at the boost effort, or the chat\'s own if higher; only the owner can use it', async t => {
  const f = fixture(t);
  f.add(A, { id: 'a1', ts: Math.floor(START / 1000) - 600, text: 'Please finish the slides by 15:00' });
  const reply = await f.run('ask+ what is due today?');
  assert.match(reply, /^Answer \(last 24h, 1 messages, high effort\):\n- Demo at 15:00$/);
  const first = f.requests.pop();
  assert.equal(first.effort, 'high');
  assert.equal(first.question, 'what is due today?');
  // A plain ask right after uses the default again: ask+ changes nothing beyond its own answer.
  f.advance(120 * 1000);
  await f.run('ask what is due today?');
  assert.equal(f.requests.pop().effort, 'low');
  // The chat's own effort wins when it is higher.
  await f.run('effort max 1h');
  f.advance(120 * 1000);
  await f.run('ask+ and tomorrow?');
  assert.equal(f.requests.pop().effort, 'max');
  // A boost setting of its own.
  await f.run('effort reset');
  f.config.summary.boostEffort = 'xhigh';
  f.advance(120 * 1000);
  await f.run('ask+ and tomorrow?');
  assert.equal(f.requests.pop().effort, 'xhigh');
  // Members cannot; a question is needed; "ask +" with a space is not ask+.
  f.advance(120 * 1000);
  assert.match(await f.run('ask+ what is due?', { fromMe: false }), /^Question not run: Only the owner of this bot can ask questions\.$/);
  assert.match(await f.run('ask+'), /^Question not run: ask needs a question of 1-500 characters\.$/);
  assert.match(await f.run('ask+   '), /^Question not run: ask needs a question of 1-500 characters\.$/);
  await f.run('ask + why?');
  assert.equal(f.requests.pop().question, '+ why?');
  assert.equal(f.requests.length, 0);
});

test('on the subscription, ask+ is the owner\'s too, and passes its effort to Claude Code', async t => {
  const f = fixture(t, { provider: 'claude-code' });
  f.add(A, { id: 'a1', ts: Math.floor(START / 1000) - 600, text: 'Please finish the slides by 15:00' });
  assert.match(await f.run('ask+ what is due?', { fromMe: false }), /only the owner can ask/);
  assert.match(await f.run('ask+ what is due?'), /^Answer \(last 24h, 1 messages, high effort\):/);
  assert.equal(f.requests.pop().effort, 'high');
});

test('a console run can name its effort; a chat request cannot pass one in', async t => {
  const f = fixture(t);
  f.add(A, { id: 'a1', ts: Math.floor(START / 1000) - 600, text: 'Please finish the slides by 15:00' });
  assert.match(await f.service({ chatId: A, source: 'cli', question: 'what is due?', effort: 'max' }), /, max effort\):/);
  assert.equal(f.requests.pop().effort, 'max');
  f.advance(120 * 1000);
  assert.equal(await f.service({ chatId: A, source: 'cli', hours: 24, effort: 'huge' }), 'Summary not run: effort must be one of low, medium, high, xhigh, max (console only).');
  const message = { fromMe: true, to: A, type: 'chat', body: '!bot summary', id: { _serialized: 'm' } };
  assert.equal(await f.service({ chatId: A, source: 'chat', message, effort: 'max' }), 'Summary not run: effort must be one of low, medium, high, xhigh, max (console only).');
  assert.equal(f.requests.length, 0);
});

test('the owner\'s effort commands stay out of the notes; other messages about effort stay in', async t => {
  const f = fixture(t);
  const old = Math.floor(START / 1000) - 10 * DAY;
  f.add(A, { id: 'e1', ts: old, fromMe: true, text: '!bot effort high 2h' });
  f.add(A, { id: 'e2', ts: old + 1, fromMe: true, text: '!bot effort reset' });
  f.add(A, { id: 'k1', ts: old + 2, text: 'Judging starts at 16:00 on Sunday' });
  f.add(A, { id: 'k2', ts: old + 3, text: '!bot effort counts more than talent' });
  f.add(A, { id: 'k3', ts: old + 4, fromMe: true, text: '!bot effort really matters for the demo' });
  f.add(A, { id: 'k4', ts: old + 5, fromMe: true, text: '!bot effort matters' });
  f.add(A, { id: 'e3', ts: old + 6, fromMe: true, text: '!bot effort' });
  f.answer = '- Judging Sunday 16:00';
  assert.equal((await f.service.condense({ chatId: A, source: 'cli' })).done, true);
  const { transcript } = f.requests.pop();
  assert.match(transcript, /Judging starts/);
  assert.match(transcript, /effort counts more than talent/);
  assert.match(transcript, /effort really matters for the demo/);
  assert.match(transcript, /effort matters$/m);
  assert.doesNotMatch(transcript, /effort high 2h|effort reset|!bot effort$/m);
});

test('the console refuses an unknown effort before doing anything', t => {
  const directory = tempDirectory(t, 'spam-bot-effort-cli-');
  fs.cpSync(path.join(__dirname, '..', 'src'), path.join(directory, 'src'), { recursive: true });
  const config = loadConfig();
  config.chats = [{ id: A, label: 'Team', receive: true, send: true, buzzword: '!bot', ai: true }];
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config, null, 2));
  const env = { ...process.env, ANTHROPIC_API_KEY: '' };
  delete env.SPAM_BOT_CONFIG;
  const result = spawnSync(process.execPath, [path.join(directory, 'src', 'cli.js'), 'summarise', 'Team', '--ask', 'q', '--effort', 'huge'],
    { encoding: 'utf8', env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--effort needs one of low, medium, high, xhigh, max/);
  assert.equal(fs.existsSync(path.join(directory, '.runtime', 'instance.lock')), false);
  // "--effort" takes its value with it, so the chat name is still found.
  // "--effort" takes its value with it, so the chat name is still found (the run then stops for want of a key).
  const named = spawnSync(process.execPath, [path.join(directory, 'src', 'cli.js'), 'summarise', '--effort', 'high', 'Team'],
    { encoding: 'utf8', env });
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stdout, /^Summary not run: Summaries need ANTHROPIC_API_KEY/);
  // Where no AI runs, --effort would do nothing: say so instead of ignoring it.
  for (const args of [['summarise', 'Team', '--dry-run', '--effort', 'high'], ['transcript', 'Team', '--effort', 'high']]) {
    const ignored = spawnSync(process.execPath, [path.join(directory, 'src', 'cli.js'), ...args], { encoding: 'utf8', env });
    assert.equal(ignored.status, 1, args.join(' '));
    assert.match(ignored.stderr, /--effort applies only to a real summarise run/);
  }
});

test('a boost ends at the minute it shows, and lasts at least a minute', async t => {
  assert.equal(parseDuration('0.01'), null);
  assert.equal(parseDuration('1m'), 1 / 60);
  const f = fixture(t);
  f.advance(40 * 1000); // 13:00:40 in London
  assert.match(await f.run('effort high 30m'), /until Thu 1 Jul 13:31 /);
  assert.equal(f.efforts.get(A).until, START + 31 * 60000);
  assert.match(await f.run('effort high 0.01'), /^Usage: /);
});

test('a member\'s summary (summary.ownerOnly off) keeps the default effort, even while the owner raised it', async t => {
  const f = fixture(t);
  f.config.summary.ownerOnly = false;
  f.add(A, { id: 'a1', ts: Math.floor(START / 1000) - 600, text: 'Please finish the slides by 15:00' });
  await f.run('effort max 2h');
  assert.match(await f.run('summary', { fromMe: false }), /^Summary of the last 24h \(1 messages\):/);
  assert.equal(f.requests.pop().effort, 'low');
  f.advance(120 * 1000);
  assert.match(await f.run('summary'), /^Summary of the last 24h \(1 messages, max effort\):/);
  assert.equal(f.requests.pop().effort, 'max');
});

test('on the API, higher effort gets room to answer, and a cut-off answer is never posted as "Nothing important."', async t => {
  const config = loadConfig();
  config.chats = [{ id: A, label: 'Team', receive: true, send: true, buzzword: '!bot', ai: true, detect: true, aiPerDay: 10 }];
  config.summary.maxPerHour = 20;
  config.summary.maxPerDay = 50;
  validateConfig(config);
  const policies = buildPolicies(config);
  const directory = tempDirectory(t, 'spam-bot-effort-api-');
  const archive = new Archive(path.join(directory, 'archive'));
  const safety = new SafetyStore(path.join(directory, 'runtime'));
  let now = START;
  const clock = () => now;
  const efforts = createEffortBoosts({ clock });
  const calls = [];
  let response = { stop_reason: 'end_turn', content: [{ type: 'text', text: '- Slides due 15:00' }] };
  const client = { messages: { create: async request => { calls.push(request); return response; } } };
  const service = createSummaryService({ getConfig: () => config, getPolicies: () => policies, archive, safety, efforts,
    items: new Items(path.join(directory, 'items')), getSecret: () => Buffer.alloc(32), clock, log: () => {},
    replyGate: createReplyGate({ config: config.replies, state: safety.state, clock }),
    clientFactory: () => client, isAvailable: () => true });
  const commands = createCommands({ getConfig: () => config, efforts, clock, summaryService: service });
  const run = text => commands(policies.get(A), matchBuzzword(`!bot ${text}`, '!bot'),
    { fromMe: true, message: { fromMe: true, to: A, type: 'chat', body: `!bot ${text}`, id: { _serialized: 'm' } } });
  archive.write(A, { chat: A, fromMe: false, sender: 'alice@lid', kind: 'chat', id: 'a1', ts: Math.floor(START / 1000) - 600,
    text: 'Please finish the slides by 15:00' });
  await run('ask what is due?');
  assert.deepEqual([calls[0].max_tokens, calls[0].output_config], [4096, { effort: 'low' }]);
  now += 120 * 1000;
  await run('ask+ what is due?');
  assert.deepEqual([calls[1].max_tokens, calls[1].output_config], [16000, { effort: 'high' }]);
  // Cut off with some text: posted with a note. Cut off with none: an error, not "Nothing important.".
  now += 120 * 1000;
  response = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '- Slides due' }] };
  assert.match(await run('ask+ what is due?'), /\n- Slides due\n\(Cut off at the length limit\.\)$/);
  now += 120 * 1000;
  response = { stop_reason: 'max_tokens', content: [] };
  await assert.rejects(run('ask+ what is due?'), /Team: the answer was cut off at the length limit/);
  // Spotting at a raised effort gets room too, and a cut-off list counts as a failed run.
  await run('effort xhigh 1h');
  now += 120 * 1000;
  response = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '[{"text": "Finish the sli' }] };
  await assert.rejects(service.detect({ chatId: A, source: 'cli' }), /the answer was cut off at the length limit/);
  assert.equal(calls[calls.length - 1].max_tokens, 16000);
});
