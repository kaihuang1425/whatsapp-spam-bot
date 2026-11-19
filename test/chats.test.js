'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, validateConfig, saveChats } = require('../src/config');
const { buildPolicies, chatKind, describeChat, matchBuzzword, findPolicy, chatsTsv, sortChats } = require('../src/chats');
const { SafetyStore, createReplyGate, emptyState } = require('../src/safety');
const { tempDirectory } = require('./helpers');

const chat = (changes = {}) => ({ id: '120363000000000001@g.us', label: 'Test group', receive: true, send: true, buzzword: '!bot',
  callers: 'anyone', spam: 'delete', archive: true, pseudonymise: true, ...changes });

test('chat entries are validated with clear messages', () => {
  for (const [bad, pattern] of [
    [{ id: '12345' }, /id ending/],
    [{ buzzword: 'x' }, /buzzword/],
    [{ buzzword: ' !bot' }, /buzzword/],
    [{ callers: 'admins' }, /callers/],
    [{ spam: 'ban' }, /spam/],
    [{ receive: false }, /needs receive/]
  ]) {
    const config = loadConfig();
    config.chats = [chat(bad)];
    assert.throws(() => validateConfig(config), pattern);
  }
  const config = loadConfig();
  config.chats = [chat(), chat()];
  assert.throws(() => validateConfig(config), /listed twice/);
});

test('missing chat fields get safe defaults: read only, never send', () => {
  const config = loadConfig();
  config.chats = [{ id: '447700900123@c.us' }];
  validateConfig(config);
  assert.deepEqual(config.chats[0], { id: '447700900123@c.us', label: '', receive: true, send: false, buzzword: '', callers: 'anyone',
    spam: 'off', archive: true, pseudonymise: true, joinRequests: 'off', ai: false, hub: '', aiPerDay: 3, keepDays: 0, detect: false,
    githubRepo: '', githubMembers: false, googleFiles: [], googleMembers: false, assistant: false, githubAutoIssues: false });
});

test('a send-only chat is allowed and needs no buzzword', () => {
  const config = loadConfig();
  config.chats = [chat({ receive: false, buzzword: '', spam: 'off' })];
  assert.doesNotThrow(() => validateConfig(config));
});

test('legacy groupIds become moderated chats that are not archived; chats entries override them', () => {
  const config = loadConfig();
  config.groupIds = ['111@g.us', '120363000000000001@g.us'];
  config.chats = [chat({ spam: 'flag' })];
  const policies = buildPolicies(validateConfig(config));
  assert.equal(policies.get('111@g.us').spam, 'delete');
  assert.equal(policies.get('111@g.us').archive, false);
  assert.equal(policies.get('111@g.us').buzzword, '');
  assert.equal(policies.get('120363000000000001@g.us').spam, 'flag');
  assert.equal(policies.get('120363000000000001@g.us').legacy, false);
});

test('saving chats replaces only the chats list and validates first', t => {
  const dir = tempDirectory(t);
  const file = path.join(dir, 'config.json');
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  raw.repetition.windowSeconds = 61;
  fs.writeFileSync(file, JSON.stringify(raw));
  const saved = saveChats([chat()], file);
  assert.equal(saved.chats[0].buzzword, '!bot');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.repetition.windowSeconds, 61);
  assert.equal(Object.hasOwn(written, 'replies'), true);
  assert.equal(written.chats.length, 1);
  assert.throws(() => saveChats([chat({ spam: 'ban' })], file), /spam/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).chats[0].spam, 'delete');
});

test('saving chats keeps groupIds in step with the groups the bot works in, for the hosted supervisor', t => {
  const file = path.join(tempDirectory(t), 'config.json');
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  raw.groupIds = ['111@g.us', '120363000000000003@g.us'];
  fs.writeFileSync(file, JSON.stringify(raw));
  saveChats([
    chat(),
    chat({ id: '120363000000000002@g.us', receive: false, send: false, buzzword: '', spam: 'off', joinRequests: 'screen' }),
    chat({ id: '120363000000000003@g.us', receive: false, send: false, buzzword: '', spam: 'off' }),
    chat({ id: '447700900123@c.us', spam: 'off' })
  ], file);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written.groupIds, ['111@g.us', '120363000000000001@g.us', '120363000000000002@g.us'],
    'an old group not in chats stays; a group switched off leaves; direct chats never appear');
});

test('chat kinds cover groups, communities, direct chats and channels', () => {
  const id = (serialized, server) => ({ _serialized: serialized, server, user: serialized.split('@')[0] });
  assert.equal(chatKind({ id: id('1@c.us', 'c.us'), isGroup: false }), 'direct');
  assert.equal(chatKind({ id: id('1@lid', 'lid'), isGroup: false }), 'direct');
  assert.equal(chatKind({ id: id('1@g.us', 'g.us'), isGroup: true, groupMetadata: {} }), 'group');
  assert.equal(chatKind({ id: id('1@g.us', 'g.us'), isGroup: true, groupMetadata: { isParentGroup: true } }), 'community');
  assert.equal(chatKind({ id: id('1@g.us', 'g.us'), isGroup: true, groupMetadata: { parentGroup: { _serialized: '2@g.us' } } }), 'subgroup');
  assert.equal(chatKind({ id: id('1@newsletter', 'newsletter'), isChannel: true }), 'channel');
  const row = describeChat({ id: id('1@g.us', 'g.us'), name: 'Class', isGroup: true, timestamp: 5,
    groupMetadata: { participants: [{}, {}], parentGroup: { _serialized: '2@g.us' } } });
  assert.deepEqual(row, { id: '1@g.us', name: 'Class', kind: 'subgroup', members: 2, community: '2@g.us', lastActive: 5 });
});

test('groups sort before direct chats; direct chats by most recent', () => {
  const rows = sortChats([{ name: 'b', kind: 'direct', lastActive: 1 }, { name: 'z', kind: 'group' }, { name: 'a', kind: 'direct', lastActive: 9 }]);
  assert.deepEqual(rows.map(r => r.name), ['z', 'a', 'b']);
});

test('buzzword matching is case-insensitive, needs a word break and returns the command', () => {
  assert.equal(matchBuzzword('!bot ping', '!bot'), 'ping');
  assert.equal(matchBuzzword('  !BOT   check free money ', '!bot'), 'check free money');
  assert.equal(matchBuzzword('!bot', '!bot'), '');
  assert.equal(matchBuzzword('!bot: help', '!bot'), 'help');
  assert.equal(matchBuzzword('!botany is fun', '!bot'), null);
  assert.equal(matchBuzzword('hello !bot ping', '!bot'), null);
  assert.equal(matchBuzzword('hey bot summary 4', 'hey bot'), 'summary 4');
  assert.equal(matchBuzzword('!bot ping', ''), null);
});

test('chats are found by label or ID; unknown names list what is configured', () => {
  const config = loadConfig();
  config.chats = [chat()];
  const policies = buildPolicies(validateConfig(config));
  assert.equal(findPolicy(policies, 'test GROUP').id, '120363000000000001@g.us');
  assert.equal(findPolicy(policies, '120363000000000001@g.us').label, 'Test group');
  assert.throws(() => findPolicy(policies, 'other'), /Configured: Test group/);
});

test('the chat list TSV keeps tabs and newlines in names from breaking columns', () => {
  const tsv = chatsTsv([{ id: '1@g.us', name: 'a\tb\nc', kind: 'group', members: 3, community: '' }], new Map());
  assert.equal(tsv.split('\n')[1], '1@g.us\ta b c\tgroup\t3\t\t\t\t\t');
});

test('the reply budget enforces interval, per-chat cooldown and hourly/daily caps, and persists', () => {
  let now = 1800000000000;
  const state = emptyState();
  let saves = 0;
  const gate = createReplyGate({ config: { minIntervalSeconds: 3, chatCooldownSeconds: 10, maxPerHour: 3, maxPerDay: 4 },
    clock: () => now, state, save: () => saves++ });
  assert.equal(gate.reserve('a'), true);
  assert.equal(gate.reserve('b'), false); // 3 s minimum interval
  now += 4000;
  assert.equal(gate.reserve('a'), false); // 10 s cooldown in one chat
  assert.equal(gate.reserve('b'), true);
  now += 11000;
  assert.equal(gate.reserve('a'), true);
  now += 11000;
  assert.equal(gate.reserve('c'), false); // 3 per hour
  now += 3600000;
  assert.equal(gate.reserve('c'), true);
  now += 11000;
  assert.equal(gate.reserve('d'), false); // 4 per day
  assert.equal(saves, 4);
  gate.pause('SEND_FAILURE');
  now += 86400000;
  assert.equal(gate.reserve('a'), false);
});

test('older safety state gains reply fields; resume clears a reply pause but keeps the budget', t => {
  const dir = tempDirectory(t);
  const old = { ...emptyState(), replyPause: undefined, replyAttempts: undefined };
  delete old.replyPause;
  delete old.replyAttempts;
  fs.writeFileSync(path.join(dir, 'safety.json'), JSON.stringify(old));
  const store = new SafetyStore(dir);
  assert.equal(store.state.replyPause, null);
  assert.deepEqual(store.state.replyAttempts, []);
  store.state.replyPause = { time: 1, reason: 'SEND_FAILURE' };
  store.state.replyAttempts = [{ time: 1, chat: 'x' }];
  store.save();
  store.resume({ reviewed: true });
  const reloaded = new SafetyStore(dir);
  assert.equal(reloaded.state.replyPause, null);
  assert.equal(reloaded.state.replyAttempts.length, 1);
});


test('hand-removing chooser-managed chats never restores legacy permissions', t => {
  const file = path.join(tempDirectory(t), 'config.json');
  const raw = loadConfig();
  raw.groupIds = ['111@g.us'];
  fs.writeFileSync(file, JSON.stringify(raw));
  saveChats([chat()], file);
  const selected = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(selected.managedGroupIds, [chat().id]);
  assert.ok(selected.groupIds.includes(chat().id), 'supervisor still sees the chosen group');
  selected.chats = [];
  fs.writeFileSync(file, JSON.stringify(selected));
  const policies = buildPolicies(loadConfig(file));
  assert.equal(policies.has(chat().id), false);
  assert.equal(policies.get('111@g.us').spam, 'delete', 'genuine legacy groups still work');
  saveChats([], file);
  assert.deepEqual(loadConfig(file).groupIds, ['111@g.us']);
});

test('buzzword cleaning handles NFKC fullwidth and invisible characters', () => {
  assert.equal(matchBuzzword('\uff01\uff42\uff4f\uff54 ping', '!bot'), 'ping');
  assert.equal(matchBuzzword('!b\u200bot ping', '!bot'), 'ping');
});
