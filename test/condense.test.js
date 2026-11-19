'use strict';

// Condensing a chat's older messages into its notes, per-chat AI limits, and the notes the owner can check.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, validateConfig } = require('../src/config');
const { buildPolicies } = require('../src/chats');
const { SafetyStore, createReplyGate } = require('../src/safety');
const { createSummaryService } = require('../src/summarise');
const { createCommands } = require('../src/commands');
const { Archive, ColdStore, recordKey } = require('../src/archive');
const { Notes, HISTORY } = require('../src/notes');
const { renderOldestChunk } = require('../src/transcript');
const { resumeCommand } = require('../src/hints');
const { chooseChats } = require('../src/setup');
const { tempDirectory } = require('./helpers');

const A = '111@g.us', B = '222@g.us';
const DAY = 86400;
const START = 1800000000000; // ms

function fixture(t, { chat = {}, other = {}, provider, service: extra = {} } = {}) {
  const config = loadConfig();
  config.chats = [
    { id: A, label: 'Class', receive: true, send: true, buzzword: '!bot', ai: true, keepDays: 7, ...chat },
    { id: B, label: 'Other', receive: true, send: true, buzzword: '!bot', ai: true, ...other }
  ];
  validateConfig(config);
  const policies = buildPolicies(config);
  const directory = tempDirectory(t, 'spam-bot-condense-');
  const archive = new Archive(path.join(directory, 'archive'));
  const notes = new Notes(path.join(directory, 'notes'));
  const cold = new ColdStore(path.join(directory, 'condensed'));
  const safety = new SafetyStore(path.join(directory, 'runtime'));
  let now = START;
  const requests = [];
  let answer = '- Exam moved to Friday 9:00';
  const service = createSummaryService({ getConfig: () => config, getPolicies: () => policies, archive, safety,
    getSecret: () => Buffer.alloc(32), notes, cold, clock: () => now,
    replyGate: createReplyGate({ config: config.replies, state: safety.state, clock: () => now }),
    provider: provider === undefined
      ? async request => { requests.push(request); return typeof answer === 'function' ? answer(request) : answer; } : provider,
    ...extra });
  const add = (chatId, record) => archive.write(chatId, { chat: chatId, fromMe: false, sender: 'alice@lid', kind: 'chat', ...record });
  return { config, policies, directory, archive, notes, cold, safety, service, requests, add,
    set answer(value) { answer = value; }, get now() { return now; }, advance: ms => { now += ms; },
    condense: (more = {}) => service.condense({ chatId: A, source: 'timer', ...more }) };
}

const daysAgo = days => Math.floor(START / 1000) - days * DAY;
const ids = (f, chatId = A) => f.archive.read(chatId).map(r => r.id);
const coldLines = (f, chatId = A) => {
  try { return fs.readFileSync(f.cold.file(chatId), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; }
};

test('older messages are folded into the chat\'s notes and taken out; recent ones and other chats stay', async t => {
  const f = fixture(t);
  f.add(A, { id: 'o1', ts: daysAgo(10), text: 'Exam is Thursday, call +44 7700 900123' });
  f.add(A, { id: 'o2', ts: daysAgo(9), text: 'Correction: exam moved to Friday 9:00' });
  f.add(A, { id: 'n1', ts: daysAgo(9), text: '!bot ping', fromMe: true });
  f.add(A, { id: 'r1', ts: daysAgo(2), text: 'Bring calculators' });
  f.add(B, { id: 'b1', ts: daysAgo(30), text: 'Other chat, old' });
  const result = await f.condense();
  assert.equal(result.done, true, result.text);
  assert.match(result.text, /Folded 2 messages .* took 3 messages out of the archive\. A copy stays in data\/condensed\/ for 30 days\./);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].mode, 'condense');
  assert.match(f.requests[0].transcript, /Member-[0-9a-f]{4}: Exam is Thursday, call \[phone\]/);
  assert.doesNotMatch(f.requests[0].transcript, /ping|Bring calculators|Other chat/);
  assert.match(f.requests[0].system, /at most 6000 characters/);
  assert.ok(f.requests[0].maxTokens >= 12000);
  assert.equal(f.notes.read(A), '- Exam moved to Friday 9:00');
  assert.deepEqual(ids(f), ['r1']);
  assert.deepEqual(ids(f, B), ['b1']);
  // The cold copy is the message as written, for undoing a bad run by hand; it is never sent anywhere.
  assert.deepEqual(coldLines(f).map(x => x.id).sort(), ['n1', 'o1', 'o2']);
  assert.match(coldLines(f).find(x => x.id === 'o1').text, /\+44 7700 900123/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.notes.file(A)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.cold.file(A)).mode & 0o777, 0o600);
  }
});

test('the next run sees the current notes, keeps dated versions, and waits condenseEveryHours per chat', async t => {
  const f = fixture(t);
  f.add(A, { id: 'o1', ts: daysAgo(10), text: 'Exam Friday' });
  await f.condense();
  f.add(A, { id: 'o2', ts: daysAgo(8), text: 'Trip on the 20th' });
  f.advance(3600000);
  const early = await f.condense();
  assert.equal(early.done, false);
  assert.match(early.text, /less than 6h ago/);
  f.advance(6 * 3600000);
  f.answer = request => `${request.notes}\n- Trip on the 20th`;
  assert.equal((await f.condense()).done, true);
  assert.equal(f.requests[1].notes, '- Exam moved to Friday 9:00');
  assert.equal(f.notes.read(A), '- Exam moved to Friday 9:00\n- Trip on the 20th');
  const versions = f.notes.history(A);
  assert.equal(versions.length, 1);
  assert.equal(fs.readFileSync(versions[0], 'utf8').trim(), '- Exam moved to Friday 9:00');
});

test('note history keeps every recent version, and the newest ones beyond that', t => {
  const notes = new Notes(tempDirectory(t));
  for (let i = 0; i <= HISTORY + 2; i++) notes.write(A, `- version ${i}`, START + i * 1000, { keepDays: 30 });
  assert.equal(notes.history(A).length, HISTORY + 2, 'all versions from the last 30 days stay');
  const later = START + 40 * DAY * 1000;
  notes.write(A, '- later', later, { keepDays: 30 });
  const versions = notes.history(A);
  assert.equal(versions.length, HISTORY);
  assert.equal(fs.readFileSync(versions[0], 'utf8').trim(), '- version 3');
  assert.equal(fs.readFileSync(versions[HISTORY - 1], 'utf8').trim(), `- version ${HISTORY + 2}`);
  assert.equal(Notes.versionTime(versions[HISTORY - 1]), later, 'a version is stamped when it was replaced');
  assert.equal(notes.read(A), '- later');
  assert.deepEqual(new Notes(path.dirname(path.dirname(versions[0]))).history(B), []);
});

test('notes cannot be whittled away by answers that each cut a little less than half', async t => {
  const f = fixture(t);
  const facts = n => Array.from({ length: n }, (_, i) => `- Fact ${i}: something worth keeping`).join('\n');
  f.notes.write(A, facts(100), START - DAY * 1000);
  f.add(A, { id: 'o1', ts: daysAgo(10), text: 'Exam Friday' });
  f.answer = facts(60);
  assert.equal((await f.condense()).done, true, '60% of the old notes passes');
  f.add(A, { id: 'o2', ts: daysAgo(9), text: 'Trip Monday' });
  f.advance(7 * 3600000);
  f.answer = facts(36);
  await assert.rejects(f.condense(), /less than half as long as this week's longest version/);
  assert.deepEqual(ids(f), ['o2']);
  assert.equal(f.notes.read(A), facts(60));
});

test('condensing has its own daily budget and does not use up summaries or questions', async t => {
  const f = fixture(t, { other: { keepDays: 7 } });
  f.config.summary.maxPerDay = 1;
  f.config.summary.maxPerHour = 1;
  f.config.summary.maxCondensePerDay = 1;
  f.add(A, { id: 'o1', ts: daysAgo(10), text: 'Exam Friday' });
  f.add(B, { id: 'b1', ts: daysAgo(10), text: 'Old in B' });
  f.add(A, { id: 'r1', ts: daysAgo(0), text: 'Today in A' });
  assert.equal((await f.condense()).done, true);
  f.advance(5000);
  const blocked = await f.service.condense({ chatId: B, source: 'timer' });
  assert.match(blocked.text, /daily condensing limit \(1\)/);
  assert.deepEqual(ids(f, B), ['b1']);
  const summary = await f.service({ chatId: A, source: 'cli' });
  assert.match(summary, /^Summary of the last 24h/);
});

test('nothing is taken out when the model fails, and the attempt still counts', async t => {
  const f = fixture(t, { provider: async () => { throw new Error('provider down'); } });
  f.add(A, { id: 'o1', ts: daysAgo(10), text: 'Exam Friday' });
  await assert.rejects(f.condense(), /provider down/);
  assert.deepEqual(ids(f), ['o1']);
  assert.equal(f.notes.read(A), '');
  assert.deepEqual(coldLines(f), []);
  assert.equal(f.safety.state.aiAttempts.filter(x => x.kind === 'condense').length, 1);
});

test('an empty, over-long or much shorter answer is refused and nothing is taken out', async t => {
  const old = Array.from({ length: 20 }, (_, i) => `- Fact ${i}: something worth keeping`).join('\n');
  for (const [answer, reason] of [['', /no notes/], ['   ', /no notes/], ['x'.repeat(6001), /longer than 6000/],
    ['- No changes.', /less than half as long/]]) {
    const f = fixture(t);
    f.notes.write(A, old);
    f.answer = answer;
    f.add(A, { id: 'o1', ts: daysAgo(10), text: 'Exam Friday' });
    await assert.rejects(f.condense(), reason);
    assert.deepEqual(ids(f), ['o1']);
    assert.equal(f.notes.read(A), old);
    assert.deepEqual(coldLines(f), []);
  }
});

test('with the API, an answer cut off at max_tokens or without text is refused', async t => {
  for (const response of [{ stop_reason: 'max_tokens', content: [{ type: 'text', text: '- Old note 1\n- Old no' }] },
    { stop_reason: 'end_turn', content: [] }]) {
    const sent = [];
    const client = { messages: { create: async request => { sent.push(request); return response; } } };
    const f = fixture(t, { provider: null, service: { isAvailable: () => true, clientFactory: () => client } });
    f.notes.write(A, '- Old note 1\n- Old note 2');
    f.add(A, { id: 'o1', ts: daysAgo(10), text: 'Exam Friday' });
    await assert.rejects(f.condense(), /cut off|no notes/);
    assert.equal(sent[0].max_tokens, 12000);
    assert.deepEqual(ids(f), ['o1']);
    assert.equal(f.notes.read(A), '- Old note 1\n- Old note 2');
  }
});

test('a message deleted for everyone during the AI call is not folded in, and is tried again without it', async t => {
  const f = fixture(t);
  f.add(A, { id: 'o1', ts: daysAgo(10), text: 'My new address is 5 Elm St' });
  f.add(A, { id: 'o2', ts: daysAgo(10), text: 'Exam Friday' });
  f.answer = request => { f.archive.revoke(A, 'o1'); return `- From: ${request.transcript}`; };
  const result = await f.condense();
  assert.equal(result.done, false);
  assert.match(result.text, /deleted meanwhile/);
  assert.equal(f.notes.read(A), '');
  assert.deepEqual(ids(f), ['o2']);
  f.advance(7 * 3600000);
  f.answer = request => `- From: ${request.transcript}`;
  assert.equal((await f.condense()).done, true);
  assert.doesNotMatch(f.notes.read(A), /Elm/);
  assert.deepEqual(ids(f), []);
  // The deleted message and its marker are gone from the archive, and no copy of it was kept.
  assert.equal(fs.readFileSync(f.archive.file(A), 'utf8').trim(), '');
  assert.deepEqual(coldLines(f).map(x => x.id), ['o2']);
});

test('only AI-on chats with keepDays, from the timer or CLI, ever condense', async t => {
  for (const [chat, source, reason] of [[{ ai: false }, 'timer', /AI is off/], [{ keepDays: 0 }, 'timer', /condensing is off/],
    [{ archive: false }, 'timer', /not archived/], [{}, 'chat', /only from the bot's own check/]]) {
    let calls = 0;
    const f = fixture(t, { chat, provider: async () => { calls++; return '- x'; } });
    f.add(A, { id: 'o1', ts: daysAgo(10), text: 'Exam Friday' });
    const result = await f.condense({ source });
    assert.equal(calls, 0, 'the model must not be reached');
    assert.equal(result.done, false);
    assert.match(result.text, reason);
    assert.deepEqual(ids(f), ['o1']);
  }
  let calls = 0;
  const f = fixture(t, { provider: async () => { calls++; return '- x'; } });
  f.add(A, { id: 'r1', ts: daysAgo(3), text: 'Recent' });
  assert.match((await f.condense()).text, /nothing older than 7 days/);
  f.add(A, { id: 'o1', ts: daysAgo(10), text: 'Old' });
  const dry = await f.condense({ source: 'cli', dryRun: true });
  assert.match(dry.text, /1 archived messages are older than 7 days\. The next run would fold 1/);
  assert.deepEqual(ids(f), ['o1', 'r1']);
  assert.equal(calls, 0);
});

test('only bare bot commands skip the AI; messages that merely start with a word-like buzzword go to it', async t => {
  let calls = 0;
  const f = fixture(t, { chat: { buzzword: 'hey' }, provider: async request => { calls++; f.requests.push(request); return '- Exam Friday 9:00, room 4'; } });
  f.add(A, { id: 'c1', ts: daysAgo(10), text: 'hey ping', fromMe: true });
  f.add(A, { id: 'c2', ts: daysAgo(10), text: 'hey summary 6', fromMe: true });
  f.add(A, { id: 'c3', ts: daysAgo(10), text: f.config.discoveryPhrase, fromMe: true });
  assert.match((await f.condense()).text, /^Took 3 old bot commands out of the archive/);
  assert.equal(calls, 0);
  f.add(A, { id: 'm1', ts: daysAgo(9), text: 'Hey all, the exam moved to Friday 9:00 in room 4' });
  f.add(A, { id: 'm2', ts: daysAgo(9), text: `${f.config.replyPrefix} rota: Bob brings the projector` });
  f.add(A, { id: 'm3', ts: daysAgo(9), text: 'hey ask when is the trip?', fromMe: true });
  assert.equal((await f.condense()).done, true);
  assert.equal(calls, 1);
  assert.match(f.requests[0].transcript, /exam moved to Friday[\s\S]*Bob brings the projector[\s\S]*when is the trip/);
});

test('a backlog is folded oldest first, a chunk at a time, within the transcript cap', async t => {
  const f = fixture(t);
  f.config.summary.maxTranscriptChars = 120;
  for (let i = 0; i < 6; i++) f.add(A, { id: `o${i}`, ts: daysAgo(20 - i), text: `Message ${i} ${'x'.repeat(20)}` });
  f.add(A, { id: 'cmd', ts: daysAgo(10), text: '!bot ping', fromMe: true });
  await f.condense();
  const left = ids(f);
  assert.ok(left.length < 7 && left.length > 1, left.join());
  assert.equal(left[0], `o${6 - (left.length - 1)}`, 'the oldest messages went first');
  assert.ok(left.includes('cmd'), 'a command newer than the chunk waits for its turn');
  assert.ok(f.requests[0].transcript.length <= 120);
});

test('"Nothing important" keeps existing notes, and an empty chat history leaves no notes', async t => {
  const f = fixture(t);
  f.answer = 'Nothing important.';
  f.add(A, { id: 'o1', ts: daysAgo(10), text: 'lol' });
  assert.equal((await f.condense()).done, true);
  assert.equal(f.notes.read(A), '');
  assert.equal(fs.existsSync(f.notes.file(A)), false);
  f.notes.write(A, '- Keep me');
  f.add(A, { id: 'o2', ts: daysAgo(9), text: 'haha' });
  f.advance(7 * 3600000);
  await f.condense();
  assert.equal(f.notes.read(A), '- Keep me');
  assert.deepEqual(ids(f), []);
  assert.deepEqual(coldLines(f).map(x => x.id), ['o1', 'o2']);
});

test('cold copies are deleted after condensedKeepDays, and none are kept with 0', async t => {
  const f = fixture(t);
  f.add(A, { id: 'o1', ts: daysAgo(40), text: 'Exam Friday' });
  await f.condense();
  assert.equal(f.cold.count(A), 1);
  f.advance(31 * DAY * 1000);
  f.add(A, { id: 'o2', ts: daysAgo(20), text: 'Trip Monday' });
  await f.condense();
  assert.deepEqual(coldLines(f).map(x => x.id), ['o2']);
  const none = fixture(t);
  none.config.summary.condensedKeepDays = 0;
  none.add(A, { id: 'o1', ts: daysAgo(10), text: 'Exam Friday' });
  const result = await none.condense();
  assert.doesNotMatch(result.text, /copy stays/);
  assert.equal(fs.existsSync(none.cold.file(A)), false);
  assert.deepEqual(ids(none), []);
});

test('questions include the chat\'s notes, even with no recent messages; summaries do not', async t => {
  const f = fixture(t);
  f.notes.write(A, '- Exam moved to Friday 9:00');
  f.notes.write(B, '- B secret plan');
  const answer = await f.service({ chatId: A, source: 'cli', question: 'When is the exam?' });
  assert.match(answer, /^Answer \(last 24h, 0 messages, notes\)/);
  assert.equal(f.requests[0].notes, '- Exam moved to Friday 9:00');
  assert.doesNotMatch(JSON.stringify(f.requests[0]), /B secret/);
  f.add(A, { id: 'r1', ts: daysAgo(0), text: 'Bring calculators' });
  f.advance(61000);
  await f.service({ chatId: A, source: 'cli' });
  assert.equal(f.requests[1].notes, undefined);
  assert.doesNotMatch(JSON.stringify(f.requests[1]), /Exam moved/);
  f.advance(61000);
  assert.match(await f.service({ chatId: A, source: 'cli', hours: 24 * 10 }), /^Summary of the last 240h \(1 messages\): \(messages older than 7 days are only in the notes\)/);
});

test('each chat has its own daily AI limit; other chats keep theirs', async t => {
  const f = fixture(t, { chat: { aiPerDay: 2 } });
  f.config.summary.cooldownSeconds = 0;
  f.add(A, { id: 'r1', ts: daysAgo(0), text: 'Today in A' });
  f.add(B, { id: 'b1', ts: daysAgo(0), text: 'Today in B' });
  for (let i = 0; i < 2; i++) { assert.match(await f.service({ chatId: A, source: 'cli' }), /^Summary/); f.advance(5000); }
  assert.match(await f.service({ chatId: A, source: 'cli' }), /this chat's limit of 2 AI requests a day is reached/);
  assert.match(await f.service({ chatId: B, source: 'cli' }), /^Summary/);
  assert.equal(f.safety.state.aiStats.reasons.chat_budget, 1);
  f.advance(DAY * 1000);
  assert.match(await f.service({ chatId: A, source: 'cli' }), /No archived messages|^Summary/);
});

test('!bot notes tells the owner how big the notes are but never posts them; other members are refused', async t => {
  const f = fixture(t);
  f.notes.write(A, '- Member-ab12 owes Member-cd34 50\n- Exam moved to Friday 9:00');
  const commands = createCommands({ getConfig: () => f.config, notes: f.notes });
  const owner = await commands(f.policies.get(A), 'notes', { fromMe: true });
  assert.match(owner, /^Notes: 2 lines, \d+ characters, updated .*older than 7 days[\s\S]*node src\/cli\.js notes "Class"/);
  assert.doesNotMatch(owner, /owes|Exam moved/);
  assert.match(await commands(f.policies.get(A), 'notes', { fromMe: false }), /Only the owner/);
  assert.match(await commands(f.policies.get(B), 'notes', { fromMe: true }), /No notes yet\. Condensing is off/);
  assert.match(await commands(f.policies.get(A), 'help', { fromMe: true }), /!bot notes - /);
  assert.doesNotMatch(await commands(f.policies.get(A), 'help', { fromMe: false }), /!bot notes/);
});

test('archive prune copies, then removes exactly the given messages from both files; old deleted messages go too', t => {
  const directory = tempDirectory(t);
  const archive = new Archive(directory, { maxFileMiB: 1 });
  archive.write(A, { id: 'x1', chat: A, ts: 1, text: 'one' });
  archive.write(A, { id: 'x2', chat: A, ts: 2, text: 'two' });
  fs.renameSync(archive.file(A), archive.file(A).replace(/\.jsonl$/, '.previous.jsonl'));
  archive.write(A, { id: 'x1', chat: A, ts: 1, text: 'one' }); // a copy left in both files by a roll
  archive.write(A, { chat: A, ts: 3, text: 'no id' });
  archive.write(A, { id: 'x4', chat: A, ts: 4, text: 'four' });
  archive.write(A, { id: 'x5', chat: A, ts: 50, text: 'five' });
  archive.revoke(A, 'x2');
  archive.revoke(A, 'x4');
  archive.revoke(A, 'x5');
  const copied = [];
  const keys = new Set([recordKey({ id: 'x1' }), recordKey({ ts: 3, text: 'no id' }), recordKey({ id: 'x4' })]);
  assert.equal(archive.prune(A, keys, { beforeRemoving: records => copied.push(...records) }), 2);
  assert.deepEqual(copied.map(r => r.id || r.text).sort(), ['no id', 'x1'], 'a deleted message is never copied');
  assert.deepEqual(archive.read(A), []);
  assert.match(fs.readFileSync(archive.file(A), 'utf8'), /"x4"[\s\S]*"x5"/, 'deleted messages stay without revokedBefore');
  archive.prune(A, new Set(), { revokedBefore: 10 });
  const left = [archive.file(A), archive.file(A).replace(/\.jsonl$/, '.previous.jsonl')]
    .map(file => fs.readFileSync(file, 'utf8')).join('');
  assert.doesNotMatch(left, /"x2"|"x4"|"two"|"four"/);
  assert.match(left, /"text":"five"[\s\S]*"revoked":"x5"/, 'a newer deleted message waits until it is old');
});

test('chunks keep the oldest messages', () => {
  const records = [1, 2, 3].map(i => ({ ts: 1800000000 + i, sender: 'a@lid', text: `m${i} ${'y'.repeat(30)}` }));
  const { transcript, count } = renderOldestChunk(records, { maxChars: 140, secret: Buffer.alloc(32) });
  assert.equal(count, 2);
  assert.match(transcript, /m1[\s\S]*m2/);
  // Condensing removes what it sends, so an oversized oldest message goes whole, never cut.
  const big = renderOldestChunk([{ ...records[0], text: 'z'.repeat(500) }, records[1]], { maxChars: 50, secret: Buffer.alloc(32) });
  assert.equal(big.count, 1);
  assert.ok(big.transcript.endsWith('z'.repeat(500)));
});

test('cold copies expire for every chat, also when its condensing was turned off', async t => {
  const f = fixture(t);
  f.add(A, { id: 'o1', ts: daysAgo(10), text: 'Exam Friday' });
  await f.condense();
  assert.equal(f.cold.count(A), 1);
  f.config.chats[0].keepDays = 0;
  assert.equal(f.cold.purgeAll(30, START + 29 * DAY * 1000), 0);
  assert.equal(f.cold.purgeAll(30, START + 31 * DAY * 1000), 1);
  assert.equal(fs.existsSync(f.cold.file(A)), false);
});

test('config checks per-chat limits and the condensing settings', () => {
  const check = (chat, summary = {}) => () => {
    const config = loadConfig();
    config.chats = [{ id: A, receive: true, send: true, buzzword: '!bot', ai: true, ...chat }];
    Object.assign(config.summary, summary);
    return validateConfig(config);
  };
  for (const aiPerDay of [0, 101, 1.5, '3']) assert.throws(check({ aiPerDay }), /aiPerDay/);
  for (const keepDays of [-1, 1, 2, 366, 2.5]) assert.throws(check({ keepDays }), /keepDays/);
  assert.doesNotThrow(check({ keepDays: 3 }));
  for (const maxNotesChars of [100, 8001]) assert.throws(check({}, { maxNotesChars }), /maxNotesChars/);
  assert.throws(check({}, { maxCondensePerDay: 0 }), /maxCondensePerDay/);
  for (const condenseEveryHours of [0.5, 25]) assert.throws(check({}, { condenseEveryHours }), /condenseEveryHours/);
  for (const condensedKeepDays of [-1, 366, 1.5]) assert.throws(check({}, { condensedKeepDays }), /condensedKeepDays/);
  const config = check({})();
  assert.equal(config.chats[0].aiPerDay, 3);
  assert.equal(config.chats[0].keepDays, 0);
  assert.equal(config.summary.condensedKeepDays, 30);
});

test('the chooser asks for the daily AI limit and history length only when AI is on', async () => {
  const answers = [A, 'y', 'y', '!bot', 'a', 'f', 'n', 'y', '0', '7', '400', '30', ''];
  const printed = [];
  const { chats } = await chooseChats({ rows: [], policies: new Map(), currentChats: [],
    ask: async () => (answers.length ? answers.shift() : ''), print: line => printed.push(line) });
  assert.equal(chats[0].aiPerDay, 7);
  assert.equal(chats[0].keepDays, 30);
  assert.equal(printed.filter(line => /whole number/.test(line)).length, 2);
});

test('the resume hint is a command that works on this machine', () => {
  assert.equal(resumeCommand({ platform: 'win32' }), 'npm.cmd run resume -- --reviewed');
  assert.equal(resumeCommand({ platform: 'linux', execPath: '/home/u/shared-bot-task/node/bin/node', root: '/home/u/bot' }),
    'cd /home/u/bot && /home/u/shared-bot-task/node/bin/node src/cli.js resume --reviewed');
  assert.equal(resumeCommand({ platform: 'linux', execPath: '/opt/my node/node', root: "/home/u/it's" }),
    "cd '/home/u/it'\\''s' && '/opt/my node/node' src/cli.js resume --reviewed");
});

test('a backlog that does not fit in one night says how much is left', async t => {
  const f = fixture(t);
  f.config.summary.maxTranscriptChars = 120;
  for (let i = 0; i < 6; i++) f.add(A, { id: `b${i}`, ts: daysAgo(10) + i, text: `Old message number ${i} about the exam timetable` });
  const result = await f.condense();
  assert.equal(result.done, true, result.text);
  assert.match(result.text, /\d+ older messages are still waiting for later nights\.$/);
});
