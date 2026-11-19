'use strict';

// WhatsApp Web's July 2026 update renamed an ID's text form from _serialized to $1. whatsapp-web.js 1.34.7 from npm
// read only _serialized, so every message reached the bot without an ID and was dropped in silence. These tests
// build data the way WhatsApp Web now sends it and run it through the bundled library and the bot's own code.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Message, GroupChat, GroupNotification } = require('whatsapp-web.js/src/structures');
const { serialized, findParticipant } = require('../src/ids');
const { describeChat, chatKind } = require('../src/chats');
const { revokeInPage } = require('../src/deletion');
const { createRouter } = require('../src/router');
const { createDiscovery } = require('../src/discovery');
const { tempDirectory } = require('./helpers');

const GROUP = '120363000000000001@g.us';
const COMMUNITY = '120363000000000009@g.us';
const ME = '11112222333344@lid';
const MEMBER = '55556666777788@lid';
const NOW = 1800000000000;

function rawMessage({ body = '!bot discover', fromMe = true, author = ME, key = '3EB0AA', type = 'chat' } = {}) {
  return {
    id: { $1: `${fromMe}_${GROUP}_${key}_${author}`, fromMe, id: key, remote: { $1: GROUP, server: 'g.us' }, participant: { $1: author } },
    from: { $1: fromMe ? ME : GROUP }, to: { $1: fromMe ? GROUP : ME }, author: { $1: author },
    body, type, t: Math.floor(NOW / 1000)
  };
}

function rawGroup() {
  return {
    id: { $1: GROUP, server: 'g.us', user: '120363000000000001' }, formattedTitle: 'Class', isGroup: true, t: Math.floor(NOW / 1000),
    groupMetadata: { parentGroup: { $1: COMMUNITY }, participants: [
      { id: { $1: ME, server: 'lid' }, isAdmin: true, isSuperAdmin: false },
      { id: { $1: MEMBER, server: 'lid' }, isAdmin: false, isSuperAdmin: false }
    ] }
  };
}

test('the bundled whatsapp-web.js reads the renamed ID field on messages, chats and group notices', () => {
  const message = new Message({}, rawMessage());
  assert.equal(message.id._serialized, `true_${GROUP}_3EB0AA_${ME}`);
  assert.equal(message.from, ME);
  assert.equal(message.to, GROUP);
  assert.equal(message.author, ME);
  assert.equal(message.fromMe, true);
  const chat = new GroupChat({}, rawGroup());
  assert.equal(chat.id._serialized, GROUP);
  const notice = new GroupNotification({}, { id: { $1: 'n1', remote: { $1: GROUP } }, author: { $1: MEMBER },
    subtype: 'membership_approval_request', body: '', t: 1 });
  assert.equal(notice.chatId, GROUP);
  assert.equal(notice.author, MEMBER);
});

test('member lists and other raw IDs are read in either form', async () => {
  assert.equal(serialized({ $1: MEMBER }), MEMBER);
  assert.equal(serialized({ _serialized: MEMBER }), MEMBER);
  assert.equal(serialized(MEMBER), MEMBER);
  assert.equal(serialized(null), null);
  const chat = new GroupChat({}, rawGroup());
  const me = await findParticipant({}, chat.participants, ME);
  assert.equal(me?.isAdmin, true);
  const member = await findParticipant({}, chat.participants, { $1: MEMBER });
  assert.equal(member?.isAdmin, false);
});

test('chat listings name the chat and its community from renamed IDs', () => {
  const chat = new GroupChat({}, rawGroup());
  const row = describeChat(chat);
  assert.equal(row.id, GROUP);
  assert.equal(row.name, 'Class');
  assert.equal(row.community, COMMUNITY);
  assert.equal(row.members, 2);
  assert.equal(chatKind(chat), 'subgroup');
  assert.equal(chatKind({ id: { $1: '447700900123@c.us' }, isGroup: false }), 'direct');
  // Raw chat data, without the library's fill-in.
  assert.equal(describeChat({ id: { $1: GROUP }, isGroup: true, name: 'Raw' }).id, GROUP);
});

test('deletion inside WhatsApp Web checks the renamed IDs before revoking', async t => {
  const target = { id: { $1: `false_${GROUP}_X1_${MEMBER}`, fromMe: false, remote: { $1: GROUP }, participant: { $1: MEMBER } } };
  const revoked = [];
  const previous = globalThis.window;
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  globalThis.window = {
    Debug: { VERSION: '2.3000.1' },
    WWebJS: { compareWwebVersions: () => true },
    require: name => ({
      WAWebCollections: { Msg: { get: id => (id === serialized(target.id) ? target : undefined) }, Chat: { get: () => ({ id: { $1: GROUP } }) } },
      WAWebMsgActionCapability: { canAdminRevokeMsg: () => true },
      WAWebCmd: { Cmd: { sendRevokeMsgs: async (_group, { list }) => { revoked.push(...list); } } }
    })[name]
  };
  const ids = { messageId: serialized(target.id), groupId: GROUP, senderId: MEMBER };
  assert.deepEqual(await revokeInPage(ids), { status: 'requested' });
  assert.deepEqual(revoked, [target]);
  assert.deepEqual(await revokeInPage({ ...ids, senderId: ME }), { status: 'skipped', reason: 'message-unavailable-or-changed' });
  assert.equal(revoked.length, 1);
});

function router(t, { logOtherChats = false } = {}) {
  const logs = [], errors = [];
  const config = { discoveryPhrase: '!bot discover', replyPrefix: '🤖', logOtherChats, archive: { enabled: false } };
  const filename = path.join(tempDirectory(t), 'discovered-chats.json');
  const discover = createDiscovery({ filename, getConfig: () => config, clock: () => NOW, log: line => logs.push(line),
    getChat: async id => (id === GROUP ? new GroupChat({}, rawGroup()) : null) });
  const route = createRouter({ getPolicies: () => new Map(), getConfig: () => config, archive: null, moderate: async () => null,
    commands: async () => null, replyGate: null, startedAt: NOW - 1000, discover, log: line => logs.push(line), onError: e => errors.push(e) });
  return { route, logs, errors, filename };
}

test('an owner discovery message in the new format reaches discovery and is saved', async t => {
  const r = router(t);
  await r.route(new Message({}, rawMessage()));
  assert.equal(r.errors.length, 0);
  assert.ok(r.logs.some(line => line.startsWith('[DISCOVERED] Class [subgroup] ID: ' + GROUP)), r.logs.join('\n'));
  assert.deepEqual(JSON.parse(fs.readFileSync(r.filename, 'utf8')).map(x => x.id), [GROUP]);
});

test('activity in an unchosen chat is noticed from messages in the new format', async t => {
  const r = router(t, { logOtherChats: true });
  await r.route(new Message({}, rawMessage({ body: 'test', fromMe: false, author: MEMBER, key: 'B1' })));
  assert.ok(r.logs.some(line => line.includes(`activity in a chat that is not set up: ${GROUP}`)), r.logs.join('\n'));
});

test('a message the library could not read is reported once instead of vanishing', async t => {
  const r = router(t, { logOtherChats: true });
  // What npm's 1.34.7 produced after the rename: no _serialized on the ID and no sender or chat.
  const unread = key => ({ id: { $1: `true_${GROUP}_${key}_${ME}`, fromMe: true }, fromMe: true, body: '!bot discover', type: 'chat',
    timestamp: Math.floor(NOW / 1000) });
  await r.route(unread('C1'));
  await r.route(unread('C2'));
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /without a readable ID.*whatsapp-web\.js library needs an update/s);
  const noChat = router(t);
  await noChat.route({ id: { _serialized: 'x1' }, fromMe: true, body: 'hi', type: 'chat', timestamp: Math.floor(NOW / 1000) });
  assert.match(noChat.errors[0], /without a readable chat ID/);
  assert.equal(r.logs.length + noChat.logs.length, 0);
});
