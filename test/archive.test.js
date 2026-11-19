'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Archive, textOf } = require('../src/archive');
const { label, scrub, renderTranscript, loadOrCreateSecret } = require('../src/transcript');
const { hasApiKey } = require('../src/summarise');
const { chooseChats } = require('../src/setup');
const { tempDirectory } = require('./helpers');

const msg = (changes = {}) => ({ id: { id: 'A1', _serialized: 'false_1@g.us_A1' }, from: '1@g.us', author: '447700900123@c.us',
  fromMe: false, type: 'chat', body: 'hi', timestamp: 1800000000, _data: { notifyName: 'Alice' }, ...changes });

test('media becomes a placeholder with its caption; system messages are not content', () => {
  assert.equal(textOf(msg({ type: 'image', body: 'poster' })), '[image] poster');
  assert.equal(textOf(msg({ type: 'image', body: '' })), '[image]');
  assert.equal(textOf(msg({ type: 'document', body: '', _data: { filename: 'notes.pdf' } })), '[file notes.pdf]');
  assert.equal(textOf(msg({ type: 'ptt' })), '[voice note]');
  assert.equal(textOf(msg({ type: 'poll_creation', pollName: 'Lunch?', pollOptions: [{ name: 'Yes' }, { name: 'No' }] })), '[poll] Lunch?: Yes / No');
  assert.equal(textOf(msg({ type: 'e2e_notification' })), '');
});

test('the archive keeps order, drops duplicates and honours delete-for-everyone', t => {
  const archive = new Archive(path.join(tempDirectory(t), 'archive'));
  archive.append(msg({ id: { id: 'B' }, body: 'second', timestamp: 1800000060 }), '1@g.us');
  archive.append(msg({ id: { id: 'A' }, body: 'first' }), '1@g.us');
  archive.append(msg({ id: { id: 'A' }, body: 'first' }), '1@g.us');
  archive.append(msg({ id: { id: 'C' }, type: 'e2e_notification' }), '1@g.us');
  assert.deepEqual(archive.read('1@g.us').map(r => r.text), ['first', 'second']);
  archive.revoke('1@g.us', 'A');
  assert.deepEqual(archive.read('1@g.us').map(r => r.text), ['second']);
  assert.deepEqual(archive.read('1@g.us', { since: 1800000061 }), []);
  assert.deepEqual(archive.stats('1@g.us'), { count: 1, last: 1800000060 });
  archive.revoke('2@g.us', 'X');
  assert.equal(fs.existsSync(archive.file('2@g.us')), false, 'a revoke never creates an archive for another chat');
});

test('the archive rolls at its size limit and still reads the previous file', t => {
  const archive = new Archive(path.join(tempDirectory(t), 'archive'), { maxFileMiB: 1 });
  archive.maxBytes = 200;
  for (let i = 0; i < 5; i++) archive.append(msg({ id: { id: `M${i}` }, body: `message ${i} ${'x'.repeat(60)}`, timestamp: 1800000000 + i }), '1@g.us');
  assert.ok(fs.existsSync(archive.file('1@g.us').replace('.jsonl', '.previous.jsonl')));
  assert.ok(archive.read('1@g.us').length >= 2);
});

test('pseudonyms are stable per person and hide numbers, emails and link tokens', () => {
  const secret = Buffer.alloc(32, 7);
  assert.equal(label(secret, '447700900123@c.us'), label(secret, '447700900123@lid'.replace('@lid', '@c.us')));
  assert.match(label(secret, '447700900123@c.us'), /^Member-[0-9a-f]{4}$/);
  assert.equal(scrub(secret, 'call +44 7700 900123 or a@b.org, https://x.org/doc?token=abc, at 2026-10-08 19:00'),
    'call [phone] or [email], https://x.org/doc at 2026-10-08 19:00'); // like the reader: the whole token tail goes
  assert.equal(scrub(secret, 'thanks @447700900123'), `thanks @${label(secret, '447700900123')}`);
});

test('one person gets a different label in each chat, the same one within a chat, mentions included', () => {
  const secret = Buffer.alloc(32, 7);
  const person = '447700900123@c.us';
  const inA = label(secret, person, 'A@g.us');
  const inB = label(secret, person, 'B@g.us');
  assert.notEqual(inA, inB);
  assert.equal(label(secret, person, 'A@g.us'), inA);
  assert.notEqual(inA, label(secret, person), 'a chat-scoped label differs from the unscoped one');
  assert.equal(scrub(secret, 'thanks @447700900123', 'A@g.us'), `thanks @${inA}`);
  const records = chat => [
    { id: 'M', ts: 1800000000, chat, fromMe: false, sender: person, text: 'hi @447700900123', quoted: null }
  ];
  const a = renderTranscript(records('A@g.us'), { secret });
  const b = renderTranscript(records('B@g.us'), { secret });
  assert.ok(a.includes(`${inA}: hi @${inA}`), a);
  assert.ok(b.includes(`${inB}: hi @${inB}`), b);
  // An explicit scope wins over the record's own chat.
  assert.ok(renderTranscript(records('B@g.us'), { secret, scope: 'A@g.us' }).includes(`${inA}:`));
});

test('transcripts show Me, pseudonyms or profile names, quotes and indented continuation lines', () => {
  const secret = Buffer.alloc(32, 7);
  const records = [
    { id: 'A', ts: 1800000000, fromMe: false, sender: '447700900123@c.us', name: 'Alice', text: 'line one\nline two', quoted: null },
    { id: 'B', ts: 1800000060, fromMe: true, sender: null, name: null, text: 'ok', quoted: 'line one line two' }
  ];
  const hidden = renderTranscript(records, { secret, ids: true }).split('\n');
  assert.match(hidden[0], /^\[\w{3} \d{2} \w{3} \d{2}:\d{2} #A\] Member-[0-9a-f]{4}: line one$/);
  assert.equal(hidden[1], '    line two');
  assert.match(hidden[2], /\] Me: ok \(replying to "line one line two"\)$/);
  assert.match(renderTranscript(records, { pseudonymise: false }), /\] Alice: line one/);
});

test('the pseudonym secret is created once and reused', t => {
  const file = path.join(tempDirectory(t), 'data', 'pseudonym.secret');
  const first = loadOrCreateSecret(file);
  assert.equal(first.length, 32);
  assert.deepEqual(loadOrCreateSecret(file), first);
});

test('API key detection accepts both supported environment variables', () => {
  assert.equal(hasApiKey({}), false);
  assert.equal(hasApiKey({ ANTHROPIC_API_KEY: 'k' }), true);
});

test('the summariser error messages come from the SDK error classes', () => {
  const { describeError } = require('../src/summarise');
  const SDK = require('@anthropic-ai/sdk');
  const Anthropic = SDK.default || SDK;
  for (const name of ['AuthenticationError', 'PermissionDeniedError', 'NotFoundError', 'RateLimitError', 'BadRequestError', 'APIConnectionError', 'APIError']) {
    assert.equal(typeof Anthropic[name], 'function', name);
  }
  assert.match(describeError(new Anthropic.APIConnectionError({ message: 'down' })), /network/);
  assert.equal(describeError(new Error('plain')), 'plain');
});

function scripted(answers) {
  const asked = [];
  return { asked, ask: async question => { asked.push(question); return answers.length ? answers.shift() : ''; } };
}

test('the chat chooser records permissions including AI and never offers to send first', async () => {
  const rows = [
    { id: '1@g.us', name: 'Class', kind: 'group', members: 30, community: '', lastActive: 0 },
    { id: '447700900123@c.us', name: 'Alice', kind: 'direct', members: '', community: '', lastActive: 9 }
  ];
  const s = scripted(['1, 2', '', 'y', '!help', 'm', 'd', 'y', 'y', '5', '14', 'y', '', 'y', 'n', '', '']);
  const printed = [];
  const { chats, tests } = await chooseChats({ rows, policies: new Map(), currentChats: [], ask: s.ask, print: x => printed.push(x) });
  assert.deepEqual(chats[0], { id: '1@g.us', label: 'Class', receive: true, send: true, buzzword: '!help', callers: 'me', spam: 'delete',
    archive: true, pseudonymise: true, joinRequests: 'screen', ai: true, aiPerDay: 5, keepDays: 14, detect: true, hub: '' });
  assert.deepEqual(chats[1], { id: '447700900123@c.us', label: 'Alice', receive: true, send: false, buzzword: '!bot', callers: 'anyone',
    spam: 'flag', archive: true, pseudonymise: true, joinRequests: 'off', ai: false, aiPerDay: 3, keepDays: 0, detect: false, hub: '' });
  assert.ok(s.asked.some(question => /Spot requests and deadlines/.test(question)));
  assert.equal(tests, undefined);
  assert.ok(s.asked.every(question => !/test message|send.*now/i.test(question)));
  assert.ok(printed.some(line => line.includes('ID: 1@g.us')));
});

test('answering no to both receive and send removes a chat; pasted IDs work', async () => {
  const current = [{ id: '1@g.us', label: 'Class', receive: true, send: true, buzzword: '!bot', callers: 'anyone', spam: 'flag', archive: true, pseudonymise: true }];
  const s = scripted(['1@g.us', 'n', 'n', '']);
  const { chats } = await chooseChats({ rows: [], policies: new Map(), currentChats: current, ask: s.ask, print: () => {} });
  assert.deepEqual(chats, []);
});

test('chooser answers must be a whole word or one letter; "disable" never means delete', async () => {
  const rows = [{ id: '1@g.us', name: 'Class', kind: 'group', members: 3, community: '', lastActive: 0 }];
  const s = scripted(['1', '', 'n', '-', 'disable', 'dont', 'delete please', '']);
  const { chats } = await chooseChats({ rows, policies: new Map(), currentChats: [], ask: s.ask, print: () => {} });
  assert.equal(chats[0].spam, 'flag', 'three unclear answers keep the safe default');
  const t = scripted(['1', '', 'n', '-', 'd', '']);
  assert.equal((await chooseChats({ rows, policies: new Map(), currentChats: [], ask: t.ask, print: () => {} })).chats[0].spam, 'delete');
});

test('removing a chat that is also in groupIds leaves an entry that switches it off', async () => {
  const s = scripted(['1@g.us', 'n', 'n', '']);
  const { chats } = await chooseChats({ rows: [], policies: new Map(), currentChats: [], groupIds: ['1@g.us'], ask: s.ask, print: () => {} });
  assert.deepEqual(chats.map(c => [c.id, c.receive, c.send, c.spam]), [['1@g.us', false, false, 'off']]);
});


test('chooser AI stays off when receive, send and buzzword are enabled but AI is left blank', async () => {
  const s = scripted(['1@g.us', '', 'y', '', '', '', '', '', '']);
  const { chats } = await chooseChats({ rows: [], policies: new Map(), currentChats: [], ask: s.ask, print: () => {} });
  assert.equal(chats[0].send, true);
  assert.equal(chats[0].buzzword, '!bot');
  assert.equal(chats[0].ai, false);
  assert.ok(s.asked.some(q => q.includes('AI summaries') && q.includes('y/N')));
});

test('chooser refuses channels and keeps earlier and later answers in the same session', async () => {
  const rows = [{ id: '1@g.us', name: 'Class', kind: 'group' }, { id: '1@newsletter', name: 'Channel', kind: 'channel' },
    { id: '2@c.us', name: 'Friend', kind: 'direct' }];
  const s = scripted(['1, 2, 1@newsletter, 3', '', '', '-', '', '', '', '', '-', '', '']);
  const printed = [];
  const { chats } = await chooseChats({ rows, policies: new Map(), currentChats: [], ask: s.ask, print: x => printed.push(x) });
  assert.deepEqual(chats.map(x => x.id), ['1@g.us', '2@c.us']);
  assert.equal(printed.filter(x => x.includes('receipt is unverified')).length, 2);
});
