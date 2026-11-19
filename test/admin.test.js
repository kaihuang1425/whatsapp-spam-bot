'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { loadConfig, validateConfig } = require('../src/config');
const { createAdmin } = require('../src/admin');
const { createAdminGate, emptyState, SafetyStore } = require('../src/safety');
const { MemberLists } = require('../src/members');
const { equivalentIds, findParticipant, phoneDigits } = require('../src/ids');
const { deleteGroupMessage } = require('../src/deletion');
const { SpamDetector } = require('../src/detector');
const { createRouter } = require('../src/router');
const { tempDirectory } = require('./helpers');

const GROUP = '120363000000000001@g.us';
const SPAMMER_LID = '111111@lid';
const SPAMMER_PN = '447700900111@c.us';
const OTHER_ADMIN = '447700900222@c.us';
const LIDS = {
  [SPAMMER_LID]: { lid: SPAMMER_LID, pn: SPAMMER_PN },
  [SPAMMER_PN]: { lid: SPAMMER_LID, pn: SPAMMER_PN }
};

// A WhatsApp client stand-in: the group lists members by phone number, messages may come from privacy IDs.
// joinAnswer: what the library returns for a join decision. It reports success only in the message text, swallows
// its own errors as an empty list, and reports server refusals without an error code.
function fakeClient({ meAdmin = true, removeEmits = true, removeWorks = true, removeThrows = false, recheckThrows = false,
  lockResult = true, announce = false, metadata = {}, contacts = [], requests = [], lidMap = LIDS, joinAnswer = 'ok', newIds = false } = {}) {
  // newIds: IDs as WhatsApp Web sends them since July 2026, text form in $1 only (raw data the library does not fill in).
  const wid = id => (newIds ? { $1: id } : { _serialized: id });
  const client = new EventEmitter();
  client.info = { wid: wid('me@c.us') };
  const calls = [];
  const state = { announce, removed: false };
  let participants = [
    { id: wid('me@c.us'), isAdmin: meAdmin },
    { id: wid(SPAMMER_PN), isAdmin: false },
    { id: wid(OTHER_ADMIN), isAdmin: true }
  ];
  const lookups = [];
  client.lookups = lookups;
  client.getContactLidAndPhone = async ids => { lookups.push(...ids); return ids.map(id => lidMap[id] || {}); };
  client.getChatById = async id => {
    if (recheckThrows && state.removed) throw new Error('chat unavailable');
    return {
      isGroup: id.endsWith('@g.us'), id: { _serialized: id }, participants: [...participants],
      groupMetadata: { announce: state.announce, ...metadata },
      removeParticipants: async ids => {
        calls.push(['remove', ...ids]);
        if (removeThrows) throw new Error('network down');
        state.removed = true;
        if (removeWorks) participants = participants.filter(p => !ids.includes(p.id._serialized || p.id.$1));
        if (removeEmits) setTimeout(() => client.emit('group_leave', { chatId: id, recipientIds: ids.map(wid) }), 5);
        return { status: 200 };
      },
      setMessagesAdminsOnly: async value => {
        calls.push(['lock', value]);
        if (lockResult) state.announce = value;
        return lockResult;
      }
    };
  };
  client.getContactById = async id => ({ isMyContact: contacts.includes(id) });
  client.getGroupMembershipRequests = async () => requests.map(id => ({ id: wid(id) }));
  const answer = (verb, ids) => {
    if (joinAnswer === 'swallowed') return [];
    if (joinAnswer === 'refused') return [{ requesterId: ids[0], message: 'ServerStatusCodeError' }];
    return [{ requesterId: ids[0], message: `${verb} successfully` }];
  };
  client.approveGroupMembershipRequests = async (group, options) => { calls.push(['approve', ...options.requesterIds]); return answer('Approved', options.requesterIds); };
  client.rejectGroupMembershipRequests = async (group, options) => { calls.push(['reject', ...options.requesterIds]); return answer('Rejected', options.requesterIds); };
  return { client, calls, state };
}

// The clock stands still except when the bot itself waits (sleep), so spacing between actions is really tested.
function setup(options = {}, { maxPerHour = 20, active = () => true } = {}) {
  const { client, calls, state: chat } = fakeClient(options);
  let now = 1800000000000;
  const state = emptyState();
  const clock = () => now;
  const gate = createAdminGate({ config: { minIntervalSeconds: 1, maxPerHour, maxPerDay: 100 }, clock, state });
  const members = new MemberLists(null);
  const config = loadConfig();
  config.admin.minIntervalSeconds = 1;
  config.joinScreening = { approveContacts: true, rejectRemoved: true, rejectCountryCodes: ['234'] };
  const records = [], errors = [], timers = [];
  const admin = createAdmin({ client, gate, members, getConfig: () => config, onRecord: r => records.push(r), onError: e => errors.push(e),
    clock, confirmMs: 30, sleep: async ms => { now += ms; }, isActive: active, maxPerScan: options.maxPerScan || 10,
    setTimer: (fn, ms) => { if (ms >= 60000) { timers.push({ fn, ms }); return { unref() {} }; } return setTimeout(fn, ms); },
    clearTimer: handle => { if (handle && typeof handle.hasRef === 'function') clearTimeout(handle); } });
  return { admin, client, calls, members, records, errors, state, timers, chat, advance: ms => { now += ms; } };
}

const policy = { id: GROUP, label: 'Group', joinRequests: 'screen' };
const quoted = author => ({ from: GROUP, author, fromMe: false, id: { _serialized: `q-${author}` } });

test('both forms of a person\'s ID are found; missing or failing lookups fall back to the given ID', async () => {
  const { client } = fakeClient();
  assert.deepEqual([...await equivalentIds(client, SPAMMER_LID)], [SPAMMER_LID, SPAMMER_PN]);
  assert.deepEqual([...await equivalentIds({}, SPAMMER_LID)], [SPAMMER_LID]);
  assert.deepEqual([...await equivalentIds({ getContactLidAndPhone: async () => { throw new Error('x'); } }, SPAMMER_LID)], [SPAMMER_LID]);
  assert.equal((await findParticipant(client, [{ id: { _serialized: SPAMMER_PN } }], SPAMMER_LID)).id._serialized, SPAMMER_PN);
  assert.equal(phoneDigits(new Set([SPAMMER_LID, SPAMMER_PN])), '447700900111');
});

test('deletion matches a sender reported by privacy ID against a member list kept by phone number', async () => {
  const message = { from: GROUP, author: SPAMMER_LID, id: { _serialized: 'spam-1' }, body: 'x', type: 'chat' };
  const evaluate = async () => ({ status: 'skipped', reason: 'not-admin-or-message-not-revocable' });
  const chat = async () => ({ isGroup: true, id: { _serialized: GROUP }, participants: [{ id: { _serialized: SPAMMER_PN }, isAdmin: false }] });
  const mapped = Object.assign(new EventEmitter(), { getChatById: chat, pupPage: { evaluate }, getContactLidAndPhone: async ids => ids.map(id => LIDS[id] || {}) });
  assert.equal((await deleteGroupMessage(mapped, message)).reason, 'not-admin-or-message-not-revocable', 'sender found; the revoke check ran');
  const unmapped = Object.assign(new EventEmitter(), { getChatById: chat, pupPage: { evaluate } });
  assert.equal((await deleteGroupMessage(unmapped, message)).reason, 'sender-not-in-current-metadata');
});

test('kick removes a member reported by privacy ID, waits for confirmation and remembers both IDs', async () => {
  const f = setup();
  const result = await f.admin.kick(policy, quoted(SPAMMER_LID));
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(f.calls, [['remove', SPAMMER_PN]]);
  assert.equal(f.members.wasRemoved([SPAMMER_LID]), true);
  assert.equal(f.members.wasRemoved([SPAMMER_PN]), true);
  assert.equal(f.client.listenerCount('group_leave'), 0);
});

test('kick, admin checks and join screening work with IDs only in the July 2026 form', async () => {
  // removeWorks: false keeps the member listed, so only the removal notice (raw recipient IDs) can confirm the kick.
  const f = setup({ newIds: true, removeWorks: false });
  const result = await f.admin.kick(policy, quoted(SPAMMER_LID));
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(f.calls, [['remove', SPAMMER_PN]]);
  const g = setup({ newIds: true, requests: [SPAMMER_LID, '447700900333@c.us'], contacts: ['447700900333@c.us'] });
  g.members.add('removed', [SPAMMER_LID, SPAMMER_PN]);
  const outcomes = await g.admin.screenJoinRequests(policy);
  assert.deepEqual(outcomes.map(o => [o.action, o.status]), [['join-reject', 'done'], ['join-approve', 'done']]);
  assert.deepEqual(g.calls, [['reject', SPAMMER_LID], ['approve', '447700900333@c.us']]);
  const notAdmin = setup({ newIds: true, meAdmin: false });
  assert.equal((await notAdmin.admin.kick(policy, quoted(SPAMMER_LID))).status, 'skipped');
  assert.deepEqual(notAdmin.calls, []);
});

test('kick refuses admins, yourself, non-members, direct chats, and groups where you are not admin', async () => {
  const f = setup();
  assert.equal((await f.admin.kick(policy, quoted(OTHER_ADMIN))).reason, 'target-is-admin');
  assert.equal((await f.admin.kick(policy, quoted('999@c.us'))).reason, 'not-a-current-member');
  assert.equal((await f.admin.kick(policy, { ...quoted('me@c.us') })).reason, 'target-is-admin');
  assert.equal((await f.admin.kick({ id: '447700900555@c.us' }, quoted(SPAMMER_PN))).reason, 'not-a-group');
  assert.deepEqual(f.calls, []);
  const notAdmin = setup({ meAdmin: false });
  assert.equal((await notAdmin.admin.kick(policy, quoted(SPAMMER_PN))).reason, 'you-are-not-admin');
  assert.deepEqual(notAdmin.calls, []);
});

test('without a removal notice, the member list decides; still listed means unconfirmed and admin actions pause', async () => {
  const quiet = setup({ removeEmits: false });
  assert.equal((await quiet.admin.kick(policy, quoted(SPAMMER_PN))).status, 'confirmed');
  const stuck = setup({ removeEmits: false, removeWorks: false });
  assert.equal((await stuck.admin.kick(policy, quoted(SPAMMER_PN))).status, 'unconfirmed');
  assert.equal(stuck.state.adminPause.reason, 'KICK_UNCONFIRMED');
  assert.equal(stuck.members.wasRemoved([SPAMMER_PN]), true, 'remembered anyway, so a re-join can be rejected');
  assert.equal((await stuck.admin.setLocked(policy, true)).reason, 'admin-paused-or-budget-exhausted');
});

test('a failed removal pauses admin actions; the budget limits removals', async () => {
  const broken = setup({ removeThrows: true });
  assert.equal((await broken.admin.kick(policy, quoted(SPAMMER_PN))).status, 'failed');
  assert.equal(broken.state.adminPause.reason, 'KICK_FAILURE');
  assert.ok(broken.errors.some(e => /admin actions are paused/.test(e)));
  const f = setup({}, { maxPerHour: 1 });
  await f.admin.setLocked(policy, true);
  assert.equal((await f.admin.kick(policy, quoted(SPAMMER_PN))).reason, 'admin-paused-or-budget-exhausted');
  assert.deepEqual(f.calls, [['lock', true]]);
});

test('trust exempts a person from spam checks under either ID; untrust undoes it', async () => {
  const f = setup();
  assert.equal((await f.admin.trust(policy, quoted(SPAMMER_LID))).status, 'done');
  assert.equal((await f.admin.trust(policy, quoted(SPAMMER_PN))).status, 'unchanged');
  const detector = new SpamDetector(loadConfig(), { members: f.members });
  for (const sender of [SPAMMER_LID, SPAMMER_PN]) {
    assert.equal(detector.check({ chatId: GROUP, senderId: sender, text: 'You have won! Claim at https://bit.ly/x' }).trusted, true);
  }
  assert.equal((await f.admin.untrust(policy, quoted(SPAMMER_PN))).status, 'done');
  assert.equal(detector.check({ chatId: GROUP, senderId: SPAMMER_LID, text: 'You have won! Claim at https://bit.ly/x' }).trusted, false);
});

test('lock and unlock change who can send; a timed lock unlocks itself', async () => {
  const f = setup();
  assert.equal((await f.admin.setLocked(policy, true, 15)).reason, 'only admins can send for 15 min');
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].ms, 15 * 60000);
  f.timers[0].fn();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(f.calls, [['lock', true], ['lock', false]]);
  assert.equal(f.records.at(-1).reason, 'everyone can send');
});

test('lock is refused where you are not admin; a WhatsApp refusal is reported without pausing', async () => {
  const notAdmin = setup({ meAdmin: false });
  assert.equal((await notAdmin.admin.setLocked(policy, true)).reason, 'you-are-not-admin');
  const refused = setup({ lockResult: false });
  assert.equal((await refused.admin.setLocked(policy, true)).status, 'failed');
  assert.equal(refused.state.adminPause, null);
});

test('join screening rejects people you removed and blocked country codes, approves contacts and trusted people, leaves the rest', async () => {
  const requests = [SPAMMER_LID, '2348012345678@c.us', '447700900333@c.us', '447700900444@c.us', '447700900666@c.us'];
  const f = setup({ requests, contacts: ['447700900333@c.us'] });
  f.members.add('removed', [SPAMMER_LID, SPAMMER_PN]);
  f.members.add('trusted', ['447700900666@c.us']);
  const outcomes = await f.admin.screenJoinRequests(policy);
  assert.deepEqual(outcomes.map(o => [o.action, o.status, o.reason]), [
    ['join-reject', 'done', 'previously removed by you'],
    ['join-reject', 'done', 'country code +234'],
    ['join-approve', 'done', 'saved contact'],
    ['join-pending', 'pending', 'left for you to review in WhatsApp'],
    ['join-approve', 'done', 'trusted by you']
  ]);
  assert.deepEqual(f.calls, [['reject', SPAMMER_LID], ['reject', '2348012345678@c.us'], ['approve', '447700900333@c.us'], ['approve', '447700900666@c.us']]);
});

test('join screening only answers the person who just asked, does nothing where you are not admin or screening is off', async () => {
  const f = setup({ requests: ['447700900333@c.us', '447700900444@c.us'], contacts: ['447700900333@c.us', '447700900444@c.us'] });
  await f.admin.screenJoinRequests(policy, { requesterId: '447700900444@c.us' });
  assert.deepEqual(f.calls, [['approve', '447700900444@c.us']]);
  const notAdmin = setup({ meAdmin: false, requests: ['447700900333@c.us'], contacts: ['447700900333@c.us'] });
  assert.deepEqual(await notAdmin.admin.screenJoinRequests(policy), []);
  assert.deepEqual(await notAdmin.admin.screenJoinRequests(policy), []);
  assert.equal(notAdmin.records.length, 1, 'the missing admin right is logged once');
  assert.deepEqual(await f.admin.screenJoinRequests({ ...policy, joinRequests: 'off' }), []);
});

test('a timed lock on a group that was already admins-only changes nothing and never opens it later', async () => {
  const f = setup({ announce: true });
  const result = await f.admin.setLocked(policy, true, 30);
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(f.calls, []);
  assert.equal(f.timers.length, 0);
});

test('the timed unlock is not held back by the admin budget, retries when refused, and is cancelled if the chat is no longer set up', async () => {
  const f = setup({}, { maxPerHour: 1 });
  await f.admin.setLocked(policy, true, 5);
  assert.equal((await f.admin.kick(policy, quoted(SPAMMER_PN))).reason, 'admin-paused-or-budget-exhausted', 'budget used up');
  f.timers.shift().fn();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(f.calls, [['lock', true], ['lock', false]]);

  const refused = setup();
  await refused.admin.setLocked(policy, true, 5);
  refused.client.removeAllListeners();
  const original = refused.client.getChatById;
  refused.client.getChatById = async id => ({ ...(await original(id)), setMessagesAdminsOnly: async () => false });
  refused.timers.shift().fn();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(refused.records.at(-1).reason, 'whatsapp-refused; trying again in 1 min');
  assert.equal(refused.timers[0].ms, 60000);

  let active = true;
  const gone = setup({}, { active: () => active });
  await gone.admin.setLocked(policy, true, 5);
  active = false;
  gone.timers.shift().fn();
  assert.equal(gone.records.at(-1).status, 'cancelled');
  assert.deepEqual(gone.calls, [['lock', true]]);
});

test('community and announcement groups are refused for kick and lock', async () => {
  for (const metadata of [{ isParentGroup: true }, { defaultSubgroup: true }]) {
    const f = setup({ metadata });
    assert.equal((await f.admin.kick(policy, quoted(SPAMMER_PN))).reason, 'community-or-announcement-group');
    assert.equal((await f.admin.setLocked(policy, true)).reason, 'community-or-announcement-group');
    assert.deepEqual(f.calls, []);
  }
});

test('a join answer counts only when WhatsApp says it succeeded; otherwise it is logged as failed and admin actions pause', async () => {
  for (const joinAnswer of ['swallowed', 'refused']) {
    const f = setup({ requests: ['447700900333@c.us', '447700900777@c.us'], contacts: ['447700900333@c.us', '447700900777@c.us'], joinAnswer });
    const outcomes = await f.admin.screenJoinRequests(policy);
    assert.equal(outcomes.length, 1, 'stops after the first failure');
    assert.equal(outcomes[0].status, 'failed');
    assert.equal(f.state.adminPause.reason, 'JOIN_ACTION_FAILURE');
  }
});

test('a backlog of join requests at startup is worked through with spacing, up to the per-scan cap', async () => {
  const requests = ['447700900301@c.us', '447700900302@c.us', '447700900303@c.us', '447700900304@c.us', '447700900305@c.us'];
  const f = setup({ requests, contacts: requests, maxPerScan: 4 });
  const outcomes = await f.admin.screenJoinRequests(policy);
  assert.deepEqual(outcomes.map(o => o.status), ['done', 'done', 'done', 'done', 'deferred']);
  assert.equal(f.calls.filter(c => c[0] === 'approve').length, 4);
});

test('join events during a scan fold into one follow-up scan, and requesters are looked up once', async () => {
  const f = setup({ requests: ['447700900333@c.us'], contacts: [] });
  const first = f.admin.screenJoinRequests(policy);
  const second = await f.admin.screenJoinRequests(policy, { requesterId: '447700900333@c.us' });
  assert.deepEqual(second, [], 'the second event joins the running scan');
  const outcomes = await first;
  assert.deepEqual(outcomes.map(o => o.status), ['pending', 'pending'], 'one scan plus one follow-up');
  assert.equal(f.client.lookups.filter(id => id === '447700900333@c.us').length, 1, 'the requester was looked up once');
});

test('trust needs a real sender: a group message without an author is skipped', async () => {
  const f = setup();
  assert.equal((await f.admin.trust(policy, { from: GROUP, fromMe: false })).reason, 'no-sender');
  assert.deepEqual(f.members.size, { trusted: 0, removed: 0 });
});

test('if the member-list re-check fails after a removal, the kick is unconfirmed, remembered and pauses admin actions', async () => {
  const f = setup({ removeEmits: false, recheckThrows: true });
  const result = await f.admin.kick(policy, quoted(SPAMMER_PN));
  assert.equal(result.status, 'unconfirmed');
  assert.equal(f.members.wasRemoved([SPAMMER_PN]), true);
  assert.equal(f.state.adminPause.reason, 'KICK_UNCONFIRMED');
});

test('a second lock replaces the bot\'s timed unlock: plain "lock" keeps it locked, "lock 120" moves the unlock', async () => {
  const f = setup();
  await f.admin.setLocked(policy, true, 30);
  assert.equal(f.timers.length, 1);
  const keep = await f.admin.setLocked(policy, true);
  assert.equal(keep.reason, 'already admins-only; timed unlock cancelled');
  const moved = await f.admin.setLocked(policy, true, 120);
  assert.equal(moved.reason, 'already admins-only; unlock moved to 120 min from now');
  assert.equal(f.timers.at(-1).ms, 120 * 60000);
  assert.deepEqual(f.calls, [['lock', true]], 'WhatsApp was only asked once');
});

test('an unlock straight after a lock waits out the budget interval instead of being skipped', async () => {
  const f = setup();
  await f.admin.setLocked(policy, true);
  assert.equal((await f.admin.setLocked(policy, false)).status, 'done');
  assert.deepEqual(f.calls, [['lock', true], ['lock', false]]);
});

test('a page error during the timed unlock is retried and logged, not lost', async () => {
  const f = setup();
  await f.admin.setLocked(policy, true, 5);
  f.client.getChatById = async () => { throw new Error('page reloaded'); };
  f.timers.shift().fn();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.records.at(-1).reason, 'error; trying again in 1 min');
  assert.equal(f.timers.at(-1).ms, 60000);
});

test('undecided requests never crowd out ones the rules can answer', async () => {
  const strangers = Array.from({ length: 12 }, (_, i) => `4477009004${String(i).padStart(2, '0')}@c.us`);
  const f = setup({ requests: [...strangers, SPAMMER_PN] });
  f.members.add('removed', [SPAMMER_PN]);
  const outcomes = await f.admin.screenJoinRequests(policy);
  assert.equal(outcomes.at(-1).action, 'join-reject');
  assert.equal(outcomes.at(-1).status, 'done');
  assert.deepEqual(f.calls, [['reject', SPAMMER_PN]]);
});

test('screening two groups back to back at startup spaces their answers instead of skipping the second group', async () => {
  const f = setup({ requests: ['447700900333@c.us'], contacts: ['447700900333@c.us'] });
  await f.admin.screenJoinRequests(policy);
  const second = await f.admin.screenJoinRequests({ ...policy, id: '120363000000000002@g.us' });
  assert.equal(second[0].status, 'done');
});

test('a request withdrawn before the answer is logged but does not pause admin actions', async () => {
  const f = setup({ requests: ['447700900333@c.us', '447700900777@c.us'], contacts: ['447700900333@c.us', '447700900777@c.us'] });
  let first = true;
  f.client.approveGroupMembershipRequests = async (group, { requesterIds }) => {
    f.calls.push(['approve', ...requesterIds]);
    if (first) { first = false; return [{ requesterId: requesterIds[0], error: 404, message: 'Not found' }]; }
    return [{ requesterId: requesterIds[0], message: 'Approved successfully' }];
  };
  const outcomes = await f.admin.screenJoinRequests(policy);
  assert.deepEqual(outcomes.map(o => o.status), ['failed', 'done']);
  assert.equal(outcomes[0].reason, 'whatsapp error 404: Not found');
  assert.equal(f.state.adminPause, null);
});

function routerFixture() {
  const calls = [], logs = [], replies = [];
  const admin = {
    kick: async (p, q) => calls.push(['kick', q.author]),
    trust: async (p, q) => calls.push(['trust', q.author]),
    untrust: async (p, q) => calls.push(['untrust', q.author]),
    setLocked: async (p, locked, minutes) => calls.push(['lock', locked, minutes])
  };
  const moderate = async () => undefined;
  moderate.markSpam = async q => { calls.push(['spam', q.author]); return { status: 'confirmed', learned: {} }; };
  const policies = new Map([[GROUP, { id: GROUP, label: 'Group', receive: true, send: true, buzzword: '!bot', callers: 'anyone',
    spam: 'flag', archive: false, pseudonymise: true, joinRequests: 'off' }]]);
  const config = loadConfig();
  const route = createRouter({ getPolicies: () => policies, getConfig: () => config, archive: { append() {}, revoke() {} }, moderate,
    commands: async () => null, replyGate: { reserve: () => true, pause() {} }, admin, log: l => logs.push(l), onError: e => logs.push(e),
    startedAt: Date.now() - 1000 });
  let n = 0;
  const send = async (body, { fromMe = true, quote = quoted(SPAMMER_PN) } = {}) => {
    const message = { id: { _serialized: `m${n++}` }, from: fromMe ? 'me@c.us' : GROUP, to: fromMe ? GROUP : 'me@c.us',
      author: fromMe ? undefined : 'bob@c.us', fromMe, body, type: 'chat', timestamp: Math.floor(Date.now() / 1000),
      hasQuotedMsg: Boolean(quote), getQuotedMessage: async () => quote, reply: async text => { replies.push(text); return {}; } };
    await route(message);
    await route.idle();
  };
  return { calls, logs, replies, send };
}

test('owner commands reach the admin actions, never post in the chat, and are ignored from anyone else', async () => {
  const f = routerFixture();
  await f.send('!bot kick');
  await f.send('!bot trust');
  await f.send('!bot untrust');
  await f.send('!bot lock 15', { quote: null });
  await f.send('!bot unlock', { quote: null });
  await f.send('!bot spam kick');
  assert.deepEqual(f.calls, [['kick', SPAMMER_PN], ['trust', SPAMMER_PN], ['untrust', SPAMMER_PN], ['lock', true, 15], ['lock', false, 0],
    ['spam', SPAMMER_PN], ['kick', SPAMMER_PN]]);
  await f.send('!bot kick', { fromMe: false });
  assert.ok(f.logs.some(l => l.includes('only you can use "!bot kick"')));
  await f.send('!bot kick off at 3pm');
  await f.send('!bot kick', { quote: { ...quoted(SPAMMER_PN), from: '999@g.us' } });
  await f.send('!bot kick', { quote: null });
  assert.equal(f.calls.length, 7, 'talk, another chat\'s message and a missing quote do nothing');
  assert.deepEqual(f.replies, []);
});

test('near-miss owner commands are never answered in the chat; the owner is told why in the terminal', async () => {
  const f = routerFixture();
  await f.send('!bot kick him');
  await f.send('!bot lock 30 min', { quote: null });
  await f.send('!bot lock 30 min', { fromMe: false, quote: null });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.replies, []);
  assert.equal(f.logs.filter(l => l.includes('not run; send exactly')).length, 2);
});

test('the help text lists owner commands only to the owner', async () => {
  const { createCommands } = require('../src/commands');
  const run = createCommands({ getConfig: () => loadConfig(), archive: {}, getSecret: () => Buffer.alloc(32) });
  const owner = await run({ id: GROUP, buzzword: '!bot' }, 'help', { fromMe: true });
  const member = await run({ id: GROUP, buzzword: '!bot' }, 'help', { fromMe: false });
  assert.match(owner, /!bot kick/);
  assert.doesNotMatch(member, /kick|lock|trust|spam -/);
});

test('admin budget state survives restarts, resume clears its pause, and damaged state refuses startup', t => {
  const dir = tempDirectory(t);
  const old = emptyState();
  delete old.adminPause;
  delete old.adminAttempts;
  fs.writeFileSync(path.join(dir, 'safety.json'), JSON.stringify(old));
  const store = new SafetyStore(dir);
  assert.equal(store.state.adminPause, null);
  const gate = createAdminGate({ config: { minIntervalSeconds: 1, maxPerHour: 5, maxPerDay: 5 }, state: store.state, save: () => store.save() });
  assert.equal(gate.reserve(GROUP, 'kick'), true);
  gate.pause('KICK_FAILURE');
  store.resume({ reviewed: true });
  const reloaded = new SafetyStore(dir);
  assert.equal(reloaded.state.adminPause, null);
  assert.equal(reloaded.state.adminAttempts.length, 1);
  fs.writeFileSync(path.join(dir, 'safety.json'), JSON.stringify({ ...emptyState(), adminAttempts: [{ time: 1 }] }));
  assert.throws(() => new SafetyStore(dir), /admin-action state/);
});

test('member lists persist, merge ID forms, and refuse a damaged file', t => {
  const file = path.join(tempDirectory(t), 'members.json');
  const lists = new MemberLists(file);
  assert.equal(lists.add('trusted', [SPAMMER_LID]), true);
  assert.equal(lists.add('trusted', [SPAMMER_LID, SPAMMER_PN]), true, 'a newly learned ID form is merged in');
  assert.equal(lists.add('trusted', [SPAMMER_PN]), false);
  assert.deepEqual(new MemberLists(file).size, { trusted: 1, removed: 0 });
  assert.equal(new MemberLists(file).isTrusted([SPAMMER_PN]), true);
  fs.writeFileSync(file, '{"trusted": [{"ids": [1]}], "removed": []}');
  assert.throws(() => new MemberLists(file), /not a member-list file/);
});

test('join screening and admin settings are validated', () => {
  const dm = loadConfig();
  dm.chats = [{ id: '447700900123@c.us', joinRequests: 'screen' }];
  assert.throws(() => validateConfig(dm), /only works in groups/);
  const codes = loadConfig();
  codes.joinScreening.rejectCountryCodes = ['+234'];
  assert.throws(() => validateConfig(codes), /country calling codes/);
  const limits = loadConfig();
  limits.admin.maxPerDay = 1;
  limits.admin.maxPerHour = 5;
  assert.throws(() => validateConfig(limits), /admin.maxPerDay/);
});
