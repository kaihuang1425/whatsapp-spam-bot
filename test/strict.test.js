'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { loadConfig, validateConfig } = require('../src/config');
const { SpamDetector } = require('../src/detector');
const { createModerator } = require('../src/moderator');
const { removeSpamMessage, deleteForMe } = require('../src/deletion');

function detector(change = () => {}) {
  const config = loadConfig();
  change(config);
  let now = 1800000000000;
  const d = new SpamDetector(config, { clock: () => now });
  return { check: (text, sender = 'alice', chat = 'group') => d.check({ chatId: chat, senderId: sender, text }), advance: ms => { now += ms; } };
}

// Ordinary messages that must never be deleted, including the ones an independent review found deleted by an
// earlier version of the rules, and scams that must be. Add to both lists when tuning the rules.
const ORDINARY = [
  'Well done everyone, you\'ve won the league! Photos: https://photos.app.goo.gl/abc',
  'Congratulations, you have won.Well done team!',
  'Can I work from home a day next week? Rota: https://docs.google.com/spreadsheets/d/1',
  'PSA: if someone says they sent you a code by mistake, don\'t reply, it\'s a scam',
  'Mum can you send me the verification code? I am logging into our Netflix',
  'Join our non-profit volunteer group: https://chat.whatsapp.com/AbCdEf',
  'Daily profit from the stall was 40 quid, text me if you want to help',
  'I won a free coffee lol https://instagram.com/p/x',
  'Timetable is in timetable.pdf, work from home a day if you need',
  'Join our investment society group https://chat.whatsapp.com/XyZ',
  'Can you send me the code for the assignment? https://github.com/x/y',
  'Careful: never share your OTP. Ignore "you have won a prize, claim it at https://bit.ly/x" messages',
  'My part time job pays 12 per hour, rota at https://when2meet.com/x',
  'Our account will be suspended if we don\'t pay the society fee, details: https://su.example.ac.uk',
  'Work from home and earn daily.',
  'Guaranteed profit is a red flag in any investment',
  'You have won a phone'
];
const SCAMS = [
  ['You are our lucky winner. Claim now: https://bit.ly/x', 'prize claim with a link'],
  ['You have won! Claim at https://prize.example.net', 'prize claim with a link'],
  ['I accidentally sent my WhatsApp code to your number, can you forward it', 'asks for a login code sent by mistake'],
  ['Please share the 6-digit code you just got', 'asks for a login code sent by mistake'],
  ['Hi, I sent you a code by mistake, please send me the code you received', 'asks for a login code sent by mistake'],
  ['Remote job, earn $200/day, no experience needed https://jobs.example.net', 'job offer with pay and a link'],
  ['Part time job, earn $300 per day: https://jobs.example.net', 'job offer with pay and a link'],
  ['Your account will be suspended. Verify at https://secure-login.example.net', 'account suspension with a link'],
  ['Guaranteed profit with crypto trading, start here https://invest.example.net', 'guaranteed profit with a link'],
  ['Guaranteed returns 30% weekly, DM me', 'guaranteed profit, message me'],
  ['Join for crypto signals https://t.me/pumpgroup', 'invite link with a money promise']
];

test('pattern rules leave ordinary messages and scam warnings alone', () => {
  for (const text of ORDINARY) assert.deepEqual(detector().check(text).strict, [], text);
});

test('pattern rules flag common scams', () => {
  for (const [text, rule] of SCAMS) assert.deepEqual(detector().check(text).strict, [rule], text);
});

// Realistic ordinary messages an independent review wrote to trip the pattern rules. Phrase rules cannot be made
// precise enough for automatic deletion, so the shipped rules only flag; these must never carry a delete signal.
const FLAG_AT_MOST = [
  'Congrats Sarah, you won our Instagram giveaway! DM me your address to claim it https://instagram.com/p/abc',
  'You won the bet lol, claim your pint on Friday https://maps.app.goo.gl/xyz',
  'Can you forward it to me? I accidentally deleted the email with the tickets',
  'Can you share the code for assignment 2? I accidentally deleted my file',
  'Library: your account will be suspended if fines aren\'t paid, log in at https://library.uni.ac.uk',
  'Join the Signals and Systems study group https://chat.whatsapp.com/AbC',
  'Part time job at the campus cafe, no experience needed, apply here https://jobs.uni.ac.uk/123',
  'Anyone claiming 100% profit from forex trading is lying, see https://www.fca.org.uk/consumers',
  'Zoom for the meeting https://zoom.us/j/123'
];

test('out of the box nothing is deleted: pattern rules flag only', () => {
  const d = detector();
  for (const text of [...ORDINARY, ...SCAMS.map(([text]) => text), ...FLAG_AT_MOST]) assert.deepEqual(d.check(text).certain, [], text);
  for (let i = 0; i < 2; i++) d.check(FLAG_AT_MOST.at(-1));
  assert.deepEqual(d.check(FLAG_AT_MOST.at(-1)).certain, [], 'a link posted three times is flagged, not deleted');
});

test('saying "not a scam" does not hide a scam from the pattern rules', () => {
  const r = detector().check('You have won! Claim at https://bit.ly/x. This is not a scam!');
  assert.deepEqual(r.strict, ['prize claim with a link']);
  assert.equal(r.isSpam, true);
});

test('a rule the owner sets to "delete" becomes a delete signal', () => {
  const { check } = detector(c => { c.strictRules.find(r => r.name === 'prize claim with a link').action = 'delete'; });
  assert.deepEqual(check('You have won! Claim at https://prize.example.net').certain, ['prize claim with a link']);
  assert.deepEqual(check('Guaranteed returns 30% weekly, DM me').certain, []);
});

test('known gaps: leetspeak and broken-up links are not matched', () => {
  assert.deepEqual(detector().check('Y0u h4ve w0n, claim at bit[.]ly/x').strict, []);
});

test('curly apostrophes match like straight ones', () => {
  assert.deepEqual(detector().check('You’ve won! Claim at https://prize.example.net').strict, ['prize claim with a link']);
});

test('a trusted-domain link does not satisfy a strict link condition', () => {
  const { check } = detector(c => { c.links.trustedDomains = ['prize.example.net']; });
  assert.deepEqual(check('You have won! Claim at https://prize.example.net').strict, []);
});

test('the same link posted three times is a strict match on the third post only', () => {
  const { check } = detector();
  const text = 'Look at this https://promo.example.net/deal';
  assert.deepEqual(check(text).strict, []);
  assert.deepEqual(check(text).strict, []);
  assert.deepEqual(check(text).strict, ['same link posted repeatedly']);
});

test('a domain the owner blocked is a delete signal', () => {
  const { check } = detector(c => { c.links.blockedDomains = ['bad.example']; });
  assert.deepEqual(check('see https://offers.bad.example').certain, ['blocked domain: offers.bad.example']);
});

test('strict rules are validated so a rule cannot match every message', () => {
  for (const rule of [{ name: 'x', needsLink: true }, { name: 'x', alsoAnyOf: ['a'], needsLink: true },
    { name: 'x', anyOf: [''] }, { anyOf: ['a'] }]) {
    const config = loadConfig();
    config.strictRules = [rule];
    assert.throws(() => validateConfig(config), /Config:/);
  }
  const config = loadConfig();
  config.strictRules = [{ name: 'dup', anyOf: ['a'] }, { name: 'dup', anyOf: ['b'] }];
  assert.throws(() => validateConfig(config), /unique/);
  const actions = loadConfig();
  actions.strictRules = [{ name: 'a', anyOf: ['a'], action: 'remove' }];
  assert.throws(() => validateConfig(actions), /action must be/);
  const defaults = loadConfig();
  defaults.strictRules = [{ name: 'a', anyOf: ['a'] }];
  assert.equal(validateConfig(defaults).strictRules[0].action, 'flag', 'a rule without an action only flags');
});

test('configs written before deletion modes get strict mode; score deletion must be chosen explicitly', () => {
  const config = loadConfig();
  delete config.deletion.mode;
  delete config.deletion.forMeFallback;
  delete config.strictRules;
  validateConfig(config);
  assert.equal(config.deletion.mode, 'strict');
  assert.equal(config.deletion.forMeFallback, false);
  assert.deepEqual(config.strictRules, []);
});

function moderation({ spam = 'delete', send = true, mode = 'strict', outcome = { status: 'confirmed' }, chat = '123@g.us', deleteRule = true } = {}) {
  const config = loadConfig();
  config.deletion.enabled = true;
  config.deletion.mode = mode;
  // Most tests need a delete signal; the owner switching one rule to "delete" provides it.
  if (deleteRule) config.strictRules.find(r => r.name === 'prize claim with a link').action = 'delete';
  config.warning.enabled = true;
  const flags = [], actions = [], deleted = [], replies = [];
  let id = 0;
  const now = 1800000000000;
  const moderate = createModerator({
    config, clock: () => now, getPolicy: chatId => (chatId === chat ? { spam, send } : null),
    onFlag: x => flags.push(x), onAction: x => actions.push(x), onError: () => {},
    deleteMessage: async message => { deleted.push(message.body); return outcome; }
  });
  const message = (body, changes = {}) => ({ from: chat, author: chat.endsWith('@g.us') ? 'alice@lid' : undefined, body, type: 'chat',
    timestamp: Math.floor(now / 1000), id: { _serialized: `m-${id++}` }, reply: async () => replies.push(body), ...changes });
  return { moderate, message, flags, actions, deleted, replies };
}

test('strict mode deletes only on delete signals and flags everything else', async () => {
  const f = moderation();
  await f.moderate(f.message('claim your prize'));
  await f.moderate(f.message('Guaranteed returns 30% weekly, DM me'));
  await f.moderate(f.message('You have won! Claim at https://prize.example.net'));
  assert.deepEqual(f.flags.map(x => x.classification), ['suspected_spam', 'pattern_match', 'owner_pattern_match']);
  assert.deepEqual(f.deleted, ['You have won! Claim at https://prize.example.net']);
});

test('with the shipped rules a scam pattern is flagged, not deleted', async () => {
  const f = moderation({ deleteRule: false });
  await f.moderate(f.message('You have won! Claim at https://prize.example.net'));
  assert.equal(f.flags[0].classification, 'pattern_match');
  assert.deepEqual(f.deleted, []);
});

test('marking a message as spam deletes it and its future copies, and never learns short text', async () => {
  const { LearnedSpam } = require('../src/learned');
  const config = loadConfig();
  config.deletion.enabled = true;
  const learned = new LearnedSpam(null);
  const deleted = [], flags = [];
  let id = 0;
  let now = 1800000000000;
  const moderate = createModerator({ config, clock: () => now, learned, getPolicy: () => ({ spam: 'delete', send: false }),
    onFlag: x => flags.push(x), onAction: () => {}, onError: () => {}, deleteMessage: async m => { deleted.push(m.body); return { status: 'confirmed' }; } });
  // Messages arrive 3 s apart, past the deletion budget's 2 s minimum interval.
  const msg = (body, author = 'spammer@lid') => {
    now += 3000;
    return { from: '123@g.us', author, body, type: 'chat', timestamp: Math.floor(now / 1000), id: { _serialized: `x${id++}` } };
  };
  const result = await moderate.markSpam(msg('Exclusive offer for members only, visit https://odd.example.net/p?id=7'));
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(result.learned, { text: true, links: ['odd.example.net/p?id=7'], skippedLinks: [] });
  await moderate(msg('Exclusive offer for members only, visit https://odd.example.net/p?id=7', 'other@lid'));
  await moderate(msg('new wording, same link https://odd.example.net/p?id=7', 'third@lid'));
  await moderate(msg('a different page https://odd.example.net/p?id=8', 'fourth@lid'));
  assert.equal(deleted.length, 3, 'the marked message and its two copies; a different link is untouched');
  assert.deepEqual((await moderate.markSpam(msg('ok'))).learned, { text: false, links: [], skippedLinks: [] });
  assert.equal((await moderate.markSpam({ ...msg('mine'), fromMe: true })).status, 'skipped');
});

test('chats set to flag or off never delete; off is not even scored', async () => {
  const flag = moderation({ spam: 'flag' });
  await flag.moderate(flag.message('You have won! Claim at https://prize.example.net'));
  assert.equal(flag.flags.length, 1);
  assert.equal(flag.deleted.length, 0);
  const off = moderation({ spam: 'off' });
  await off.moderate(off.message('You have won! Claim at https://prize.example.net'));
  assert.equal(off.flags.length, 0);
  assert.equal(off.deleted.length, 0);
});

test('warning replies need send permission for the chat', async () => {
  const f = moderation({ spam: 'flag', send: false });
  await f.moderate(f.message('claim your prize'));
  assert.equal(f.flags.length, 1);
  assert.equal(f.replies.length, 0);
});

test('direct chats are moderated when set up, and a delete-for-me result gets no reply', async () => {
  const f = moderation({ chat: '447700900123@c.us', outcome: { status: 'deleted-for-me', reason: 'x', action: 'delete-for-me' } });
  await f.moderate(f.message('You have won! Claim at https://prize.example.net'));
  assert.equal(f.deleted.length, 1);
  assert.equal(f.actions[0].action, 'delete-for-me');
  assert.equal(f.actions[0].status, 'deleted-for-me');
  assert.equal(f.replies.length, 0);
});

function adminFixture({ canRevoke, emitLocal = true }) {
  const client = new EventEmitter();
  const calls = [];
  const message = { from: '123@g.us', author: 'alice@lid', id: { _serialized: 'spam-1' }, body: 'x', type: 'chat',
    delete: async (...args) => { calls.push(args); if (emitLocal) client.emit('message_revoke_me', { id: { _serialized: 'spam-1' } }); } };
  client.getChatById = async () => ({ isGroup: true, id: { _serialized: '123@g.us' }, participants: [{ id: { _serialized: 'alice@lid' } }] });
  client.pupPage = { evaluate: async () => (canRevoke ? { status: 'requested' } : { status: 'skipped', reason: 'not-admin-or-message-not-revocable' }) };
  return { client, message, calls };
}

test('without admin rights the fallback deletes for me only, and only when enabled', async () => {
  const on = adminFixture({ canRevoke: false });
  const result = await removeSpamMessage(on.client, on.message, { forMeFallback: true, timeoutMs: 20 });
  assert.equal(result.status, 'deleted-for-me');
  assert.deepEqual(on.calls, [[false, true]]);
  assert.equal(on.client.listenerCount('message_revoke_me'), 0);
  const off = adminFixture({ canRevoke: false });
  assert.equal((await removeSpamMessage(off.client, off.message, { forMeFallback: false })).reason, 'not-admin-or-message-not-revocable');
  assert.equal(off.calls.length, 0);
});

test('a sender missing from group metadata is left alone automatically, but hidden for me when the owner marked it', async () => {
  const unknown = adminFixture({ canRevoke: true });
  unknown.client.getChatById = async () => ({ isGroup: true, id: { _serialized: '123@g.us' }, participants: [] });
  assert.equal((await removeSpamMessage(unknown.client, unknown.message, { forMeFallback: true, timeoutMs: 20 })).reason, 'sender-not-in-current-metadata');
  assert.equal(unknown.calls.length, 0);
  assert.equal((await removeSpamMessage(unknown.client, unknown.message, { forMeFallback: true, byOwner: true, timeoutMs: 20 })).status, 'deleted-for-me');
  const admin = adminFixture({ canRevoke: true });
  admin.client.getChatById = async () => ({ isGroup: true, id: { _serialized: '123@g.us' }, participants: [{ id: { _serialized: 'alice@lid' }, isAdmin: true }] });
  assert.equal((await removeSpamMessage(admin.client, admin.message, { forMeFallback: true, byOwner: true, timeoutMs: 20 })).reason, 'sender-is-group-admin');
  assert.equal(admin.calls.length, 0);
});

test('a missing local-delete event is reported as requested, not confirmed', async () => {
  const f = adminFixture({ canRevoke: false, emitLocal: false });
  assert.equal((await deleteForMe(f.client, f.message, { timeoutMs: 5 })).status, 'requested-for-me');
  assert.equal(f.client.listenerCount('message_revoke_me'), 0);
});

test('direct-chat spam is deleted for me with the fallback and skipped without it', async () => {
  const f = adminFixture({ canRevoke: true });
  const dm = { ...f.message, from: '447700900123@c.us', author: undefined };
  assert.equal((await removeSpamMessage(f.client, dm, { forMeFallback: false })).status, 'skipped');
  assert.equal((await removeSpamMessage(f.client, dm, { forMeFallback: true, timeoutMs: 20 })).status, 'deleted-for-me');
});

test('with keepDeletedText the deletion record keeps the removed text; without it, it does not', async () => {
  for (const keep of [true, false]) {
    const config = loadConfig();
    config.deletion.enabled = true;
    config.deletion.keepDeletedText = keep;
    config.strictRules.find(r => r.name === 'prize claim with a link').action = 'delete';
    const actions = [];
    const moderate = createModerator({ config, clock: () => 1800000000000, getPolicy: () => ({ spam: 'delete', send: false }),
      onFlag: () => {}, onAction: x => actions.push(x), onError: () => {}, deleteMessage: async () => ({ status: 'confirmed' }) });
    await moderate({ from: '123@g.us', author: 'alice@lid', body: 'You have won! Claim at https://prize.example.net', type: 'chat',
      timestamp: 1800000000, id: { _serialized: 'k' } });
    assert.equal(actions[0].text === 'You have won! Claim at https://prize.example.net', keep);
  }
});
