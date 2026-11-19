'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, validateConfig } = require('../src/config');
const { buildPolicies } = require('../src/chats');
const { createRouter } = require('../src/router');
const { createCommands } = require('../src/commands');
const { createModerator } = require('../src/moderator');
const { createReplyGate } = require('../src/safety');
const { SafetyStore } = require('../src/safety');
const { createSummaryService } = require('../src/summarise');
const { createDiscovery } = require('../src/discovery');
const { Archive } = require('../src/archive');
const { LearnedSpam } = require('../src/learned');
const { tempDirectory } = require('./helpers');

const GROUP = '120363000000000001@g.us';
const OTHER = '120363000000000002@g.us';
const DM = '447700900123@c.us';
const ME = '447700900999@c.us';

function fixture(t, { chats, summariser = null, groupIds = [] } = {}) {
  const config = loadConfig();
  config.groupIds = groupIds;
  config.deletion.enabled = true;
  config.links.blockedDomains.push('bad.example');
  config.strictRules.find(r => r.name === 'prize claim with a link').action = 'delete';
  config.chats = chats || [
    { id: GROUP, label: 'Test group', send: true, buzzword: '!bot', spam: 'delete', ai: true },
    { id: OTHER, label: 'Quiet group', send: false, buzzword: '!bot', ai: true },
    { id: DM, label: 'Friend', send: true, buzzword: 'hey bot', callers: 'me' }
  ];
  validateConfig(config);
  const policies = buildPolicies(config);
  const dir = tempDirectory(t);
  const archive = new Archive(path.join(dir, 'archive'));
  let now = 1800000000000;
  const logs = [], errors = [], replies = [], deleted = [];
  const replyGate = createReplyGate({ config: { ...config.replies, minIntervalSeconds: 1, chatCooldownSeconds: 0 }, clock: () => now });
  const learned = new LearnedSpam(null);
  const flags = [];
  const summaryService = createSummaryService({ getConfig: () => config, getPolicies: () => policies, archive,
    getSecret: () => Buffer.alloc(32, 1), provider: summariser, safety: new SafetyStore(path.join(dir, '.runtime')),
    replyGate, clock: () => now });
  const discoveryFile = path.join(dir, 'discovered-chats.json');
  let lookups = 0;
  const discover = createDiscovery({ filename: discoveryFile, getConfig: () => config, clock: () => now,
    getChat: async id => { lookups++; return { id: { _serialized: id }, name: 'Discovered chat', isGroup: id.endsWith('@g.us') }; },
    log: line => logs.push(line) });
  const moderate = createModerator({ config, clock: () => now, learned, getPolicy: id => policies.get(id), onFlag: x => flags.push(x), onAction: () => {},
    onError: e => errors.push(e), deleteMessage: async m => { deleted.push(m.body); return { status: 'confirmed' }; } });
  const route = createRouter({
    getPolicies: () => policies, getConfig: () => config, archive, moderate, replyGate, startedAt: now - 1000,
    discover, commands: createCommands({ getConfig: () => config, summaryService }),
    log: line => logs.push(line), onError: e => errors.push(e)
  });
  let counter = 0;
  function message({ chat = GROUP, fromMe = false, body = 'hello', author = 'alice@lid', type = 'chat', ts, quoted } = {}) {
    const id = `m${counter++}`;
    const msg = {
      id: { _serialized: `${fromMe}_${chat}_${id}`, id },
      from: fromMe ? ME : chat, to: fromMe ? chat : ME, author: chat.endsWith('@g.us') && !fromMe ? author : undefined,
      fromMe, body, type, timestamp: ts ?? Math.floor(now / 1000), _data: { notifyName: 'Alice' },
      hasQuotedMsg: Boolean(quoted), getQuotedMessage: async () => quoted || null,
      reply: async text => {
        const reply = { id: { _serialized: `true_${chat}_reply${counter++}` }, body: text };
        replies.push({ chat, text });
        return reply;
      }
    };
    return msg;
  }
  async function send(...args) {
    const msg = message(...args);
    await route(msg);
    await route.idle();
    return msg;
  }
  return { config, policies, route, archive, logs, errors, replies, deleted, flags, message, send, discoveryFile,
    get lookups() { return lookups; }, advance: ms => { now += ms; } };
}

test('calling the bot from your own phone replies with the chat ID', async t => {
  const f = fixture(t);
  await f.send({ fromMe: true, body: '!bot ping' });
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0].text, /^🤖 pong/);
  assert.match(f.replies[0].text, new RegExp(`Chat ID: ${GROUP}`));
  assert.match(f.replies[0].text, /receive, send, buzzword "!bot", spam: delete/);
});

test('others in the chat can call it when callers is anyone', async t => {
  const f = fixture(t);
  await f.send({ fromMe: true, body: '!bot ping' });
  f.advance(2000);
  await f.send({ body: '!BOT help' });
  assert.equal(f.replies.length, 2);
  assert.match(f.replies[1].text, /!bot ping/);
});

test('a chat with send off never gets a message; the reply is shown in the terminal', async t => {
  const f = fixture(t);
  await f.send({ chat: OTHER, fromMe: true, body: '!bot ping' });
  assert.equal(f.replies.length, 0);
  assert.ok(f.logs.some(line => line.startsWith('[NOT SENT] send is off for Quiet group')));
  assert.ok(f.logs.some(line => line.includes(`Chat ID: ${OTHER}`)), 'the chat ID is still shown in the terminal');
});

test('callers "me" ignores the buzzword from anyone else', async t => {
  const f = fixture(t);
  await f.send({ chat: DM, fromMe: true, body: 'hey bot ping' });
  f.advance(61000);
  await f.send({ chat: DM, body: 'hey bot ping' });
  assert.equal(f.replies.length, 1);
  assert.ok(f.logs.some(line => line.includes('callers is "me"')));
});

test('the bot never answers its own replies', async t => {
  const f = fixture(t);
  await f.send({ fromMe: true, body: '!bot ping' });
  await f.send({ fromMe: true, body: '🤖 !bot ping' });
  assert.equal(f.replies.length, 1);
});

test('chats that are not set up are ignored without logging by default', async t => {
  const f = fixture(t);
  await f.send({ chat: '999@g.us', body: '!bot ping secret words' });
  await f.send({ chat: '999@g.us', body: '!bot ping' });
  assert.equal(f.replies.length, 0);
  const notices = f.logs.filter(line => line.includes('999@g.us'));
  assert.equal(notices.length, 0);
});

test('receive off: nothing is read, archived or answered', async t => {
  const f = fixture(t, { chats: [{ id: GROUP, receive: false, send: true }] });
  await f.send({ fromMe: true, body: '!bot ping' });
  assert.equal(f.replies.length, 0);
  assert.equal(f.archive.read(GROUP).length, 0);
});

test('spam is deleted and cannot also trigger a command', async t => {
  const f = fixture(t);
  await f.send({ body: '!bot ping you have won, claim at https://prize.example.net' });
  assert.deepEqual(f.deleted, ['!bot ping you have won, claim at https://prize.example.net']);
  assert.equal(f.replies.length, 0);
  assert.equal(f.archive.read(GROUP).length, 0, 'spam is not archived');
});

test('received messages are archived for receive chats but not for legacy groupIds', async t => {
  const f = fixture(t, { groupIds: ['111@g.us'] });
  await f.send({ body: 'meeting at 3' });
  await f.send({ fromMe: true, body: 'see you there' });
  await f.send({ chat: '111@g.us', body: 'legacy group text' });
  assert.deepEqual(f.archive.read(GROUP).map(r => [r.text, r.fromMe, r.name]), [['meeting at 3', false, 'Alice'], ['see you there', true, null]]);
  assert.equal(f.archive.read('111@g.us').length, 0);
});

test('messages from before startup are dropped', async t => {
  const f = fixture(t);
  await f.send({ fromMe: true, body: '!bot ping', ts: 1700000000 });
  assert.equal(f.replies.length, 0);
});

test('check scores a message without counting it towards anyone\'s history', async t => {
  const f = fixture(t);
  await f.send({ fromMe: true, body: '!bot check You have won! Claim at https://prize.example.net' });
  assert.match(f.replies[0].text, /Would be deleted/);
  assert.match(f.replies[0].text, /Delete signal: prize claim with a link/);
});

test('summary without an API key says so; with one it sends the pseudonymised archive', async t => {
  const plain = fixture(t);
  await plain.send({ fromMe: true, body: '!bot summary' });
  assert.match(plain.replies[0].text, /need ANTHROPIC_API_KEY/i);

  const seen = [];
  const f = fixture(t, { summariser: async ({ label, transcript }) => { seen.push({ label, transcript }); return '- Meeting at 3pm'; } });
  await f.send({ body: 'Meeting moved to 3pm, call +44 7700 900123' });
  await f.send({ fromMe: true, body: '!bot summary 2' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].label, 'Test group');
  assert.match(seen[0].transcript, /Member-[0-9a-f]{4}: Meeting moved to 3pm, call \[phone\]/);
  assert.ok(!seen[0].transcript.includes('!bot summary'), 'calls to the bot are not part of the summary');
  assert.match(f.replies[0].text, /Summary of the last 2h \(1 messages\):\n- Meeting at 3pm/);
  f.advance(4000); // past the reply and AI minimum intervals, inside the summary cooldown
  await f.send({ fromMe: true, body: '!bot summary' });
  assert.match(f.replies[1].text, /Please wait/);
});

test('a failed send pauses further replies', async t => {
  const f = fixture(t);
  const msg = f.message({ fromMe: true, body: '!bot ping' });
  msg.reply = async () => { throw new Error('offline'); };
  await f.route(msg);
  await f.route.idle();
  assert.ok(f.errors.some(e => /replies are paused/.test(e)));
  f.advance(10000);
  await f.send({ fromMe: true, body: '!bot ping' });
  assert.equal(f.replies.length, 0);
  assert.ok(f.logs.some(line => line.includes('reply budget or pause')));
});

test('saving send: false while a slow command runs stops its reply', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { summariser: async () => { await gate; return '- done'; } });
  await f.send({ body: 'some talk' });
  const call = f.message({ fromMe: true, body: '!bot summary' });
  await f.route(call);
  f.policies.set(GROUP, { ...f.policies.get(GROUP), send: false });
  release();
  await f.route.idle();
  assert.equal(f.replies.length, 0);
  assert.ok(f.logs.some(line => line.startsWith('[NOT SENT] send is off for Test group')));
});

test('summaries never run where send is off, and only for the owner by default', async t => {
  let calls = 0;
  const f = fixture(t, { summariser: async () => { calls++; return '- x'; } });
  await f.send({ chat: OTHER, body: 'talk' });
  await f.send({ chat: OTHER, fromMe: true, body: '!bot summary' });
  assert.ok(f.logs.some(line => line.includes('Summary not run: send is off')));
  await f.send({ body: 'talk' });
  await f.send({ fromMe: true, body: '!bot ping' });
  f.advance(2000);
  await f.send({ body: '!bot summary' });
  assert.match(f.replies.at(-1).text, /Only the owner/);
  assert.equal(calls, 0, 'nothing was sent to the API');
});

test('replying "!bot spam" to a message deletes it on your behalf and catches its next copy; nothing is posted', async t => {
  const f = fixture(t);
  const spam = await f.send({ body: 'Members only discount, register at https://odd.example.net/r?x=1', author: 'stranger@lid' });
  assert.deepEqual(f.deleted, [], 'not deleted by any rule on its own');
  await f.send({ fromMe: true, body: '!bot spam', quoted: spam });
  assert.deepEqual(f.deleted, [spam.body]);
  assert.ok(f.logs.some(line => line.startsWith('[MARKED] Test group: learned its text and link(s) odd.example.net/r?x=1; removal confirmed')));
  assert.equal(f.archive.read(GROUP).some(r => r.text === spam.body), false, 'the marked message leaves the archive');
  f.advance(3000); // past the deletion budget's minimum interval
  await f.send({ body: 'Members only discount, register at https://odd.example.net/r?x=1', author: 'another@lid' });
  assert.equal(f.deleted.length, 2);
  assert.equal(f.replies.length, 0, 'marking spam never posts in the chat');
});

test('only you can mark spam, and only by replying to a message from someone else', async t => {
  const f = fixture(t);
  const spam = await f.send({ body: 'Members only discount, register at https://odd.example.net/r?x=1', author: 'stranger@lid' });
  await f.send({ body: '!bot spam', quoted: spam, author: 'bob@lid' });
  assert.ok(f.logs.some(line => line.includes('only you can use "!bot spam"')));
  await f.send({ fromMe: true, body: '!bot spam' });
  assert.ok(f.logs.some(line => line.includes('reply to someone else')));
  assert.deepEqual(f.deleted, []);
});

test('a mark must be exactly "<buzzword> spam" and must quote a message from the same chat', async t => {
  const f = fixture(t);
  const spam = await f.send({ body: 'Members only discount, register at https://odd.example.net/r?x=1', author: 'stranger@lid' });
  await f.send({ fromMe: true, body: '!bot, spam again? just ignore it', quoted: spam });
  assert.deepEqual(f.deleted, [], 'a sentence that starts with the word spam is not a mark');
  const elsewhere = f.message({ chat: '999@g.us', body: 'A message from a chat the bot was never given', author: 'x@lid' });
  await f.send({ chat: DM, fromMe: true, body: 'hey bot spam', quoted: elsewhere });
  assert.ok(f.logs.some(line => line.includes('quoted message is from another chat')));
  assert.deepEqual(f.deleted, []);
  f.advance(3000);
  await f.send({ fromMe: true, body: '!BOT SPAM', quoted: spam });
  assert.deepEqual(f.deleted, [spam.body]);
});

test('marking a message that names whole sites learns only links to specific pages, and says which', async t => {
  const f = fixture(t);
  const spam = await f.send({ body: 'Trade like a pro on https://www.binance.com and follow https://www.instagram.com/ then join https://odd.example.net/Join?ref=Z', author: 'stranger@lid' });
  await f.send({ fromMe: true, body: '!bot spam', quoted: spam });
  assert.ok(f.logs.some(line => line.includes('learned its text and link(s) odd.example.net/Join?ref=Z; not learned (whole sites): binance.com, instagram.com')));
  f.advance(3000);
  await f.send({ body: 'Check out https://www.binance.com it is what I use', author: 'friend@lid' });
  await f.send({ body: 'Follow the society on https://www.instagram.com/', author: 'friend@lid' });
  f.advance(3000);
  await f.send({ body: 'different case https://odd.example.net/join?ref=z', author: 'friend@lid' });
  assert.deepEqual(f.deleted, [spam.body], 'ordinary links to those sites, and a differently cased path, are left alone');
});

test('a copy arriving straight after "!bot spam" is already checked against what was marked', async t => {
  const f = fixture(t);
  const spam = await f.send({ body: 'Members only discount, register at https://odd.example.net/r?x=1', author: 'stranger@lid' });
  // No waiting between the mark and the copy: the copy must still be judged after the mark was learned.
  // Fetching the quoted message takes a round trip to WhatsApp Web, so the fake takes a moment too.
  const command = f.message({ fromMe: true, body: '!bot spam', quoted: spam });
  command.getQuotedMessage = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return spam; };
  const mark = f.route(command);
  const copy = f.route(f.message({ body: 'Members only discount, register at https://odd.example.net/r?x=1', author: 'stranger2@lid' }));
  await Promise.all([mark, copy]);
  await f.route.idle();
  const flag = f.flags.find(x => x.senderId === 'stranger2@lid');
  assert.ok(flag, 'the copy was flagged');
  assert.ok(flag.deleteSignals.includes('text you marked as spam'));
});

test('an exact owner test in an unlisted chat records metadata, enables nothing and sends nothing', async t => {
  const f = fixture(t);
  const before = [...f.policies];
  await f.send({ chat: '999@g.us', fromMe: true, body: f.config.discoveryPhrase });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.discoveryFile, 'utf8')).map(({ id, name, kind }) => ({ id, name, kind })),
    [{ id: '999@g.us', name: 'Discovered chat', kind: 'group' }]);
  assert.ok(f.logs.some(line => line.startsWith('[DISCOVERED]')));
  assert.deepEqual([...f.policies], before);
  assert.equal(f.archive.read('999@g.us').length, 0);
  assert.equal(f.replies.length, 0);
  await f.send({ chat: '999@g.us', fromMe: true, body: '!bot ping' });
  assert.equal(f.replies.length, 0, 'discovery never enables the chat');
});

test('discovery ignores non-owners, near misses, media, old history and bot echoes without metadata lookups', async t => {
  const f = fixture(t);
  await f.send({ chat: '999@g.us', body: f.config.discoveryPhrase });
  for (const body of ['!BOT discover', '!bot discover ', ' !bot discover', '!bot discover please', '!bot\u200b discover', '🤖 !bot discover']) {
    await f.send({ chat: '999@g.us', fromMe: true, body });
  }
  await f.send({ chat: '999@g.us', fromMe: true, body: f.config.discoveryPhrase, type: 'image' });
  await f.send({ chat: '999@g.us', fromMe: true, body: f.config.discoveryPhrase, ts: 1700000000 });
  assert.equal(f.lookups, 0);
  assert.equal(fs.existsSync(f.discoveryFile), false);
  assert.equal(f.replies.length, 0);
});

test('discovery in enabled chats and direct chats is silent, deduplicated and never archived', async t => {
  const f = fixture(t);
  for (const chat of [GROUP, GROUP, DM]) await f.send({ chat, fromMe: true, body: f.config.discoveryPhrase });
  const entries = JSON.parse(fs.readFileSync(f.discoveryFile, 'utf8'));
  assert.deepEqual(entries.map(x => x.kind), ['group', 'direct']);
  assert.equal(f.archive.read(GROUP).length, 0);
  assert.equal(f.archive.read(DM).length, 0);
  assert.equal(f.replies.length, 0);
});

test('the first reply must answer an owner command, including after a fresh start', async t => {
  for (let start = 0; start < 2; start++) {
    const f = fixture(t);
    await f.route.idle();
    await f.send({ body: '!bot ping' });
    assert.equal(f.replies.length, 0);
    await f.send({ fromMe: true, body: f.config.discoveryPhrase });
    await f.send({ body: '!bot ping' });
    assert.equal(f.replies.length, 0, 'discovery does not unlock sending');
    await f.send({ fromMe: true, body: '!bot ping' });
    assert.equal(f.replies.length, 1);
    f.advance(61000); // avoid turning repeated test commands into a spam/flood signal
    await f.send({ body: '!bot ping' });
    assert.equal(f.replies.length, 2);
  }
});

test('router AI-off and unlisted calls cannot reach the provider', async t => {
  const f = fixture(t, { summariser: async () => assert.fail('provider must never be called') });
  f.policies.set(GROUP, { ...f.policies.get(GROUP), ai: false });
  await f.send({ body: 'meeting at 3' });
  await f.send({ fromMe: true, body: '!bot summary' });
  assert.match(f.replies[0].text, /AI is off/);
  await f.send({ chat: '999@g.us', fromMe: true, body: '!bot summary' });
  assert.equal(f.replies.length, 1);
});

test('reserved discovery phrases suppress commands but preserve moderation and archive handling', async t => {
  const f = fixture(t);
  await f.send({ fromMe: true, body: '!bot ping' });
  f.advance(61000);
  for (const body of [f.config.discoveryPhrase, '!BOT discover', '!bot discover ', '!bot discover please', '\uff01\uff42\uff4f\uff54 discover', '!b\u200bot discover']) {
    f.advance(61000);
    await f.send({ body });
    await f.send({ fromMe: true, body: `${body} ` });
  }
  assert.equal(f.lookups, 0);
  assert.equal(f.replies.length, 1);
  assert.equal(f.archive.read(GROUP).length, 13, 'ping and every non-discovery message are archived normally');
  assert.ok(f.logs.some(line => line.includes('[DISCOVERY]') && line.includes('exactly')));
  f.config.links.blockedDomains.push('bad.example');
  for (const type of ['chat', 'image']) {
    for (const prefix of ['!bot discover', '!BOT DISCOVER', '\uff01\uff42\uff4f\uff54 discover', '!bot\u200b discover']) {
      f.advance(61000);
      const body = `${prefix} https://bad.example/x`;
      await f.send({ body, type });
      assert.equal(f.deleted.at(-1), body, 'discovery prefixes cannot exempt spam');
    }
  }
  assert.equal(f.deleted.length, 8);
  assert.equal(f.archive.read(GROUP).length, 13, 'spam stays out of the archive');
  assert.equal(f.replies.length, 1);
});

test('an owner reply opens only that chat, and a removed managed group is ignored', async t => {
  const f = fixture(t);
  f.policies.set(OTHER, { ...f.policies.get(OTHER), send: true });
  await f.send({ fromMe: true, body: '!bot ping' });
  f.advance(61000);
  await f.send({ chat: OTHER, body: '!bot ping' });
  assert.equal(f.replies.length, 1);
  await f.send({ chat: OTHER, fromMe: true, body: '!bot ping' });
  f.advance(61000);
  await f.send({ chat: OTHER, body: '!bot help' });
  assert.equal(f.replies.length, 3);
  f.config.groupIds = [GROUP];
  f.config.managedGroupIds = [GROUP];
  f.config.chats = [];
  f.policies.clear();
  for (const [id, policy] of buildPolicies(f.config)) f.policies.set(id, policy);
  await f.send({ body: 'you have won, claim at https://prize.example.net' });
  assert.equal(f.deleted.length, 0);
});

test('a completed paid summary is printed if another reply consumes its budget during the call', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { summariser: () => pending });
  await f.send({ body: 'Exam Friday' });
  await f.route(f.message({ fromMe: true, body: '!bot summary' }));
  await f.route(f.message({ fromMe: true, body: '!bot ping' }));
  await new Promise(resolve => setImmediate(resolve));
  finish('- Paid result survives');
  await f.route.idle();
  assert.equal(f.replies.length, 1);
  assert.ok(f.logs.some(line => line.includes('[NOT SENT] reply budget') && line.includes('Paid result survives')));
});
