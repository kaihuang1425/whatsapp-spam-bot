'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { deleteGroupMessage } = require('../src/deletion');
const { createModerator } = require('../src/moderator');
const { loadConfig } = require('../src/config');

function fixture({ canRevoke = true, senderAdmin = false, confirm = true, fail = false, wrongTarget = false, versionOK = true } = {}) {
  const client = new EventEmitter();
  const message = { from: '123@g.us', author: 'alice@lid', id: { _serialized: 'spam-1' }, body: 'claim your prize',
    type: 'chat', timestamp: 1800000000 };
  const target = { id: { _serialized: wrongTarget ? 'other-message' : 'spam-1',
    remote: { _serialized: '123@g.us' }, participant: { _serialized: 'alice@lid' }, fromMe: false } };
  const calls = [];
  client.getChatById = async () => ({ isGroup: true, id: { _serialized: '123@g.us' },
    participants: [{ id: { _serialized: 'alice@lid' }, isAdmin: senderAdmin }] });
  const modules = {
    WAWebCollections: { Msg: { get: () => target }, Chat: { get: () => ({ id: '123@g.us' }) } },
    WAWebMsgActionCapability: { canAdminRevokeMsg: () => canRevoke },
    WAWebCmd: { Cmd: { sendRevokeMsgs: async (...args) => {
      calls.push(args);
      if (fail) throw new Error('network failure');
      if (confirm) client.emit('message_revoke_everyone', { id: message.id });
    } } }
  };
  client.pupPage = { evaluate: async (fn, args) => {
    const run = vm.runInNewContext(`(${fn.toString()})`, { window: {
      require: name => modules[name], Debug: { VERSION: '2.3000.1' },
      WWebJS: { compareWwebVersions: () => versionOK }
    } });
    return run(args);
  } };
  return { client, message, calls, modules, target };
}

test('requests revoke-for-everyone and reports confirmation only after a matching event', async () => {
  const f = fixture();
  const result = await deleteGroupMessage(f.client, f.message);
  assert.equal(result.status, 'confirmed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].list[0], f.target);
  assert.equal(f.client.listenerCount('message_revoke_everyone'), 0);
});

test('a non-admin bot never calls revoke or a local-delete fallback', async () => {
  const f = fixture({ canRevoke: false });
  assert.equal((await deleteGroupMessage(f.client, f.message)).reason, 'not-admin-or-message-not-revocable');
  assert.equal(f.calls.length, 0);
});

test('group admins are flagged for review but exempt from deletion', async () => {
  const f = fixture({ senderAdmin: true });
  assert.equal((await deleteGroupMessage(f.client, f.message)).reason, 'sender-is-group-admin');
  assert.equal(f.calls.length, 0);
});

test('missing participant metadata fails closed', async () => {
  const f = fixture();
  f.client.getChatById = async () => ({ isGroup: true, id: { _serialized: '123@g.us' }, participants: [] });
  assert.equal((await deleteGroupMessage(f.client, f.message)).status, 'skipped');
  assert.equal(f.calls.length, 0);
});

test('private, own and missing-author messages cannot be deleted', async () => {
  const f = fixture();
  for (const change of [{ from: '123@c.us' }, { fromMe: true }, { author: undefined }]) {
    assert.equal((await deleteGroupMessage(f.client, { ...f.message, ...change })).status, 'skipped');
  }
  assert.equal(f.calls.length, 0);
});

test('a changed message or group identity cannot be deleted', async () => {
  const f = fixture({ wrongTarget: true });
  assert.equal((await deleteGroupMessage(f.client, f.message)).status, 'skipped');
  f.client.getChatById = async () => ({ isGroup: true, id: { _serialized: '999@g.us' } });
  await assert.rejects(deleteGroupMessage(f.client, f.message), /identity mismatch/);
  assert.equal(f.calls.length, 0);
});

test('an unsupported Web version refuses deletion', async () => {
  const f = fixture({ versionOK: false });
  await assert.rejects(deleteGroupMessage(f.client, f.message), /Unsupported/);
  assert.equal(f.calls.length, 0);
});

test('a request without a matching event remains unconfirmed', async () => {
  const f = fixture({ confirm: false });
  const pending = deleteGroupMessage(f.client, f.message, { timeoutMs: 5 });
  f.client.emit('message_revoke_everyone', { id: { _serialized: 'unrelated' } });
  assert.equal((await pending).status, 'unconfirmed');
  assert.equal(f.client.listenerCount('message_revoke_everyone'), 0);
});

test('a failed revoke removes its confirmation listener', async () => {
  const f = fixture({ fail: true });
  await assert.rejects(deleteGroupMessage(f.client, f.message), /network failure/);
  assert.equal(f.client.listenerCount('message_revoke_everyone'), 0);
});

function moderationFixture(outcome = { status: 'confirmed' }) {
  const config = loadConfig();
  config.groupIds = ['123@g.us'];
  config.deletion.enabled = true;
  config.deletion.mode = 'score'; // these tests cover score-mode budgets and pauses
  config.deletion.keepDeletedText = false; // and that no message text is logged by default
  config.warning.enabled = true;
  const flags = [], actions = [], deleted = [], replies = [], errors = [];
  let now = 1800000000000;
  let id = 0;
  const moderate = createModerator({ config, clock: () => now, sendGuard: { canWarn: () => true }, onFlag: x => flags.push(x),
    onAction: x => actions.push(x), onError: x => errors.push(x), deleteMessage: async message => {
      deleted.push(message.id._serialized);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    } });
  const message = (changes = {}) => ({ from: '123@g.us', author: 'alice@lid', body: 'claim your prize', type: 'chat',
    timestamp: Math.floor(now / 1000), id: { _serialized: `message-${id++}` }, reply: async () => replies.push(true), ...changes });
  return { config, moderate, message, flags, actions, deleted, replies, errors, advance: ms => { now += ms; } };
}

test('moderation flags first, deletes once and does not reply to a removed message', async () => {
  const f = moderationFixture();
  const message = f.message();
  await Promise.all([f.moderate(message), f.moderate(message)]);
  assert.equal(f.flags[0].classification, 'suspected_spam');
  assert.equal(f.actions[0].status, 'confirmed');
  assert.equal(f.deleted.length, 1);
  assert.equal(f.replies.length, 0);
  assert.equal(Object.hasOwn(f.actions[0], 'text'), false);
});

test('a failed or unconfirmed deletion pauses future removals but still logs flags', async () => {
  for (const outcome of [new Error('network failure'), { status: 'unconfirmed' }]) {
    const f = moderationFixture(outcome);
    await f.moderate(f.message());
    f.advance(86400000);
    await f.moderate(f.message());
    assert.equal(f.deleted.length, 1);
    assert.equal(f.flags.length, 2);
    assert.equal(f.actions[1].reason, 'deletion-paused-or-budget-exhausted');
  }
});

test('disabled deletion, higher deletion threshold and trusted senders never remove messages', async () => {
  for (const change of [c => { c.deletion.enabled = false; }, c => { c.deletion.threshold = 9; },
    c => { c.trustedSenderIds = ['alice@lid']; }]) {
    const config = loadConfig();
    config.groupIds = ['123@g.us'];
    config.deletion.mode = 'score';
    change(config);
    let deletes = 0;
    const moderate = createModerator({ config, clock: () => 1800000000000, deleteMessage: async () => { deletes++; } });
    await moderate({ from: '123@g.us', author: 'alice@lid', body: 'claim your prize', type: 'chat', timestamp: 1800000000,
      id: { _serialized: 'one' } });
    assert.equal(deletes, 0);
  }
});

test('a failed audit write prevents deletion', async () => {
  const config = loadConfig();
  config.groupIds = ['123@g.us'];
  config.deletion.mode = 'score';
  let deletes = 0;
  const moderate = createModerator({ config, clock: () => 1800000000000,
    onFlag: () => { throw new Error('disk full'); }, onError: () => {}, deleteMessage: async () => { deletes++; } });
  await assert.rejects(moderate({ from: '123@g.us', author: 'alice@lid', body: 'claim your prize', type: 'chat',
    timestamp: 1800000000, id: { _serialized: 'one' } }), /disk full/);
  assert.equal(deletes, 0);
});
