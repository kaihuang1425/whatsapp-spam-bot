'use strict';

// Reminders, open items, and requests the AI spots in a chat's new messages.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, validateConfig } = require('../src/config');
const { buildPolicies, permissionText } = require('../src/chats');
const { SafetyStore, createReplyGate } = require('../src/safety');
const { createSummaryService, readSuggestions } = require('../src/summarise');
const { createCommands } = require('../src/commands');
const { createRouter } = require('../src/router');
const { Archive } = require('../src/archive');
const { Items, cleanText } = require('../src/items');
const { createReminderRunner, defaultReminder } = require('../src/reminders');
const { renderTranscript } = require('../src/transcript');
const { parseWhen, parseLocalIso, formatWhen } = require('../src/when');
const { tempDirectory } = require('./helpers');

const A = '111@g.us', B = '222@g.us';
const LONDON = 'Europe/London';
const NOW = Date.UTC(2026, 10, 5, 21, 30); // Thu 5 Nov 2026, 21:30 in London (GMT)
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const iso = ms => new Date(ms).toISOString().slice(0, 16);
const char = code => String.fromCharCode(code);

test('reminder times are read in London time, including summer time and its clock changes', () => {
  const at = (text, now = NOW) => {
    const parsed = parseWhen(text, { now, timeZone: LONDON, defaultHour: 9 });
    return parsed.error ? parsed : { at: iso(parsed.at), text: parsed.text };
  };
  assert.deepEqual(at('tomorrow 9am call mum'), { at: '2026-11-06T09:00', text: 'call mum' });
  assert.deepEqual(at('Fri 17:00 submit report'), { at: '2026-11-06T17:00', text: 'submit report' });
  // The same weekday: later today if that time is still ahead, otherwise next week.
  assert.equal(at('Thu 22:00 x').at, '2026-11-05T22:00');
  assert.equal(at('Thursday 21:00 x').at, '2026-11-12T21:00');
  assert.deepEqual(at('20 Nov 14:30 - dentist'), { at: '2026-11-20T14:30', text: 'dentist' });
  assert.equal(at('Nov 20 x').at, '2026-11-20T09:00');
  assert.equal(at('2026-11-20 17:00 y').at, '2026-11-20T17:00');
  assert.deepEqual(at('at 5pm to go'), { at: '2026-11-06T17:00', text: 'go' });
  assert.equal(at('22:00 tea').at, '2026-11-05T22:00');
  assert.equal(at('17:00 tea').at, '2026-11-06T17:00');
  assert.equal(at('in 2 hours x').at, '2026-11-05T23:30');
  assert.equal(at('in 45 min x').at, '2026-11-05T22:15');
  // Forms people write: a dot in the time, commas, "at", and the time before the day.
  assert.deepEqual(at('tomorrow 5.30pm call the dentist'), { at: '2026-11-06T17:30', text: 'call the dentist' });
  assert.deepEqual(at('Nov 20, 17:00 meeting'), { at: '2026-11-20T17:00', text: 'meeting' });
  assert.deepEqual(at('Friday, 5pm submit'), { at: '2026-11-06T17:00', text: 'submit' });
  assert.deepEqual(at('tomorrow at 9.30 dentist'), { at: '2026-11-06T09:30', text: 'dentist' });
  assert.deepEqual(at('on Friday at 5pm x'), { at: '2026-11-06T17:00', text: 'x' });
  assert.deepEqual(at('17:00 on 20 Nov x'), { at: '2026-11-20T17:00', text: 'x' });
  const morning = Date.UTC(2026, 10, 5, 7, 0);
  assert.deepEqual(at('9am tomorrow call mum', morning), { at: '2026-11-06T09:00', text: 'call mum' });
  assert.deepEqual(at('5pm Friday submit report', morning), { at: '2026-11-06T17:00', text: 'submit report' });
  assert.deepEqual(at('5pm Fri', morning), { at: '2026-11-06T17:00', text: '' });
  assert.deepEqual(at('5pm on Fri x', morning), { at: '2026-11-06T17:00', text: 'x' });
  // After a time, a short day name or a date in the middle of the text may be part of the text: refused, not guessed.
  assert.match(at('5pm Fri submit report', morning).error, /Is "Fri" the day\? Put the day first/);
  assert.match(at('5pm sun cream').error, /Is "sun" the day\?/);
  assert.match(at('9am may 20 people come').error, /Is "may 20" the day\?/);
  assert.deepEqual(at('tomorrow 9am may 3 people come'), { at: '2026-11-06T09:00', text: 'may 3 people come' });
  assert.deepEqual(at('9am on site visit'), { at: '2026-11-06T09:00', text: 'on site visit' });
  assert.deepEqual(at("9am today's tasks"), { at: '2026-11-06T09:00', text: "today's tasks" });
  // The bot's own format, "Fri 20 Nov 17:00", is read back, and a day name that does not match the date is refused.
  assert.deepEqual(at('Fri 20 Nov 17:00 submit'), { at: '2026-11-20T17:00', text: 'submit' });
  assert.deepEqual(at('Friday 20 November 5pm x'), { at: '2026-11-20T17:00', text: 'x' });
  assert.match(at('Thu 20 Nov 17:00 x').error, /20 Nov 2026 is a Friday, not a Thursday/);
  // Punctuation after the time, and a.m./p.m.
  assert.deepEqual(at('tomorrow 5pm: call mum'), { at: '2026-11-06T17:00', text: 'call mum' });
  assert.deepEqual(at('tomorrow 5pm. Call mum'), { at: '2026-11-06T17:00', text: 'Call mum' });
  assert.deepEqual(at('tomorrow 5 p.m. call'), { at: '2026-11-06T17:00', text: 'call' });
  assert.deepEqual(at('tomorrow 5.30 p.m. call'), { at: '2026-11-06T17:30', text: 'call' });
  assert.match(at('tomorrow 5pm:call').error, /not a time this understands/);
  assert.match(at('tomorrow 5 p m x').error, /not a time this understands/);
  assert.deepEqual(at('in 2 days at 5pm x'), { at: '2026-11-07T17:00', text: 'x' });
  assert.deepEqual(at('2026-11-20T17:00 x'), { at: '2026-11-20T17:00', text: 'x' });
  assert.deepEqual(at('tomorrow 3.5 kg flour'), { at: '2026-11-06T09:00', text: '3.5 kg flour' });
  assert.match(at('20.11 17:00 x').error, /two times in a row/);
  assert.match(at('in 2 hours at 5pm x').error, /two different times/);
  assert.match(at('tomorrow 9: x').error, /not a time this understands/);
  assert.deepEqual(at('tomorrow 5pm! x'), { at: '2026-11-06T17:00', text: 'x' });
  // Something that looks like a time but is not one this reads is refused, never read as 09:00.
  assert.match(at('tomorrow 1700 x').error, /"1700" is not a time this understands/);
  assert.match(at('tomorrow at 5:3 x').error, /not a time this understands/);
  assert.deepEqual(at('tomorrow to-do list'), { at: '2026-11-06T09:00', text: 'to-do list' });
  assert.deepEqual(at('tomorrow 3 slides'), { at: '2026-11-06T09:00', text: '3 slides' });
  // Summer time: 1 June 09:00 in London is 08:00 UTC.
  assert.equal(at('1 Jun 2027 9am x').at, '2027-06-01T08:00');
  // "in 3 days" keeps the wall-clock time across the March clock change.
  assert.equal(at('in 3 days x', Date.UTC(2027, 2, 26, 12, 0)).at, '2027-03-29T11:00');
  // 01:30 on 28 Mar 2027 does not exist in London; it lands just after the change.
  assert.equal(at('28 Mar 2027 01:30 x').at, '2027-03-28T01:30');
  // A month-name date that has passed this year means next year; today's past time stays past (refused later).
  assert.equal(at('5 Nov 9am x').at, '2027-11-05T09:00');
  assert.equal(at('today 08:00 x').at, '2026-11-05T08:00');
  assert.match(at('31 Feb x').error, /does not exist/);
  assert.match(at('25:00 x').error, /not a time/);
  assert.match(at('13pm x').error, /not a time/);
  assert.match(at('hello there').error, /Start with when/);
  assert.match(at('in 0 min x').error, /at least 1 minute/);
  assert.equal(formatWhen(Date.UTC(2026, 10, 20, 17, 0), LONDON, NOW), 'Fri 20 Nov 17:00');
  assert.equal(formatWhen(Date.UTC(2027, 5, 1, 8, 0), LONDON, NOW), 'Tue 1 Jun 2027 09:00');
  assert.equal(iso(parseLocalIso('2027-06-01T09:00', LONDON)), '2027-06-01T08:00');
  assert.equal(iso(parseLocalIso('2027-06-01T09:00:00', LONDON)), '2027-06-01T08:00');
  assert.equal(iso(parseLocalIso('2027-06-01T09:00Z', LONDON)), '2027-06-01T09:00');
  assert.equal(iso(parseLocalIso('2026-11-20', LONDON, 9)), '2026-11-20T09:00');
  assert.equal(parseLocalIso('2026-02-30T09:00', LONDON), null);
  assert.equal(parseLocalIso('next Friday', LONDON), null);
});

function fixture(t, { chat = {}, other = {}, reminders = {}, summary = {}, replies = {}, provider } = {}) {
  const config = loadConfig();
  config.chats = [
    { id: A, label: 'Class', receive: true, send: true, buzzword: '!bot', ai: true, detect: true, ...chat },
    { id: B, label: 'Other', receive: true, send: true, buzzword: '!bot', ai: true, ...other }
  ];
  Object.assign(config.reminders, reminders);
  Object.assign(config.summary, summary);
  Object.assign(config.replies, replies);
  validateConfig(config);
  const policies = buildPolicies(config);
  const directory = tempDirectory(t, 'spam-bot-reminders-');
  const archive = new Archive(path.join(directory, 'archive'));
  const items = new Items(path.join(directory, 'items'));
  const safety = new SafetyStore(path.join(directory, 'runtime'));
  let now = NOW;
  const clock = () => now;
  const requests = [];
  let answer = '[]';
  const service = createSummaryService({ getConfig: () => config, getPolicies: () => policies, archive, safety, items,
    getSecret: () => Buffer.alloc(32), clock, replyGate: createReplyGate({ config: config.replies, state: safety.state, clock }),
    provider: provider || (async request => { requests.push(request); return typeof answer === 'function' ? answer(request) : answer; }) });
  const commands = createCommands({ getConfig: () => config, items, clock, summaryService: service });
  let counter = 0;
  const run = (text, { chatId = A, fromMe = true } = {}) => commands(policies.get(chatId), text,
    { fromMe, message: { id: { _serialized: `cmd${++counter}` } } });
  const add = (record, chatId = A) => archive.write(chatId, { chat: chatId, fromMe: false, sender: 'alice@lid', kind: 'chat', ...record });
  return { config, policies, directory, archive, items, safety, service, requests, run, add, clock,
    set answer(value) { answer = value; }, get now() { return now; }, advance: ms => { now += ms; },
    detect: (more = {}) => service.detect({ chatId: A, source: 'timer', ...more }) };
}

test('remind, issue, issues, keep, drop and done work through the chat commands', async t => {
  const f = fixture(t);
  assert.equal(await f.run('remind Fri 17:00 submit the report', { fromMe: false }),
    'Reminder 1 set for Fri 6 Nov 17:00 (London time): submit the report');
  assert.match(await f.run('issue book the venue'), /^Added 2: book the venue\. Close it with !bot done 2\.$/);
  assert.match(await f.run('issue Book the venue!'), /already on the list/);
  assert.match(await f.run('remind today 08:00 too late'), /already passed \(London time\)/);
  assert.match(await f.run('remind 2028-12-01 9:00 far away'), /at most 400 days ahead/);
  assert.match(await f.run('remind tomorrow 9am'), /Say what to remind about/);
  assert.match(await f.run('remind whenever x'), /Start with when.*\nUsage: !bot remind/);
  const list = await f.run('issues', { fromMe: false });
  assert.match(list, /^Open \(2\):\n1\. submit the report \(reminder Fri 6 Nov 17:00\)\n2\. book the venue\nClose an item with !bot done N\. Times are London time\.$/);
  assert.match(await f.run('keep 2 Mon 9am'), /^Kept 2: book the venue\. Reminder Mon 9 Nov 09:00 \(London time\)\.$/);
  assert.match(await f.run('keep 2'), /already open/);
  assert.match(await f.run('keep 2 Mon 9am please'), /Only a time can follow the number/);
  assert.match(await f.run('done 1'), /^Done: 1\. submit the report$/);
  assert.match(await f.run('done 1'), /no open or suggested item 1/);
  assert.match(await f.run('keep 1 Mon 9am'), /no open or suggested item 1/);
  assert.match(await f.run('drop 2'), /^Dropped: 2\. book the venue$/);
  assert.match(await f.run('issues'), /^No open items\./);
  assert.match(await f.run('done x'), /Usage: !bot done N/);
  // Numbers are never reused, and every chat has its own list.
  assert.match(await f.run('issue next one'), /^Added 3:/);
  assert.match(await f.run('issue other chat', { chatId: B }), /^Added 1:/);
  assert.match(await f.run('help'), /remind <when> <what>.*\n.*issue <what>.*\n.*issues - open items and requests spotted in messages/);
  // Nothing outside the line itself gets in: line breaks, control and invisible characters become spaces, long text is cut.
  const odd = `line one\nline two${char(7)}${char(0x202e)}reversed${char(0x2028)}${char(0x200f)}end ${'x'.repeat(250)}`;
  assert.match(await f.run(`issue ${odd}`), /^Added 4: line one line two reversed end x+…\./);
  assert.equal([...f.items.active(A).open.find(item => item.n === 4).text].length, 200);
  assert.equal(cleanText(`family ${char(0x1f468)}${char(0x200d)}${char(0x1f469)}`, 50), `family ${char(0x1f468)}${char(0x200d)}${char(0x1f469)}`);
});

test('only the owner may put a link in a reminder, and a chat with send off gets none', async t => {
  const f = fixture(t, { other: { send: false } });
  assert.match(await f.run('remind tomorrow 9am pay at https://pay.example/x', { fromMe: false }), /Links cannot go in reminders/);
  for (const link of ['bit.ly/abc', 'evil.shop/x', 'gov-refund.uk/claim', 'bank-secure.online', 'is.gd/x', '192.168.1.1/x']) {
    assert.match(await f.run(`remind tomorrow 9am see ${link}`, { fromMe: false }), /Links cannot go in reminders/, link);
  }
  assert.match(await f.run('remind tomorrow 9am read slides.pdf, e.g. page 3', { fromMe: false }), /^Reminder 1 set/);
  assert.match(await f.run('remind tomorrow 9am pay at https://pay.example/x'), /^Reminder 2 set/);
  assert.match(await f.run('remind tomorrow 9am x', { chatId: B }), /Send is off for this chat/);
  assert.equal(f.items.active(B).open.length, 0);
});

test('open items are capped; suggestions have their own cap, and the oldest gives way', async t => {
  const f = fixture(t, { reminders: { maxOpenPerChat: 2, maxSuggestedPerChat: 2 } });
  await f.run('issue one');
  await f.run('issue two');
  assert.match(await f.run('issue three'), /already has 2 open items/);
  const suggest = text => f.items.add(A, { text, status: 'suggested', by: 'ai', now: f.now, settings: f.config.reminders });
  suggest('s1'); suggest('s2'); suggest('s3');
  assert.deepEqual(f.items.active(A).suggested.map(x => x.text), ['s2', 's3']);
  assert.match(await f.run(`keep ${f.items.active(A).suggested[0].n}`), /already has 2 open items/);
  await f.run('done 1');
  assert.match(await f.run('issue three'), /^Added/);
});

test('the list tidies itself: suggestions expire, reminded items close, closed items are forgotten', async t => {
  const f = fixture(t, { reminders: { suggestionDays: 7, closeAfterDays: 3, keepClosedDays: 30 } });
  const settings = f.config.reminders;
  f.items.add(A, { text: 'old suggestion', status: 'suggested', by: 'ai', now: f.now, settings });
  f.items.add(A, { text: 'deadline passes', status: 'suggested', by: 'ai', now: f.now, due: f.now + DAY, settings });
  await f.run('remind in 1 min take medicine');
  await f.run('issue keep me open');
  const r = runner(f);
  f.advance(MIN);
  assert.equal(await r.tick(), 1);
  f.advance(DAY);
  assert.equal(f.items.purge(A, f.now, settings), true);
  assert.deepEqual(f.items.active(A).suggested.map(x => x.text), ['old suggestion']);
  assert.equal(f.items.purge(A, f.now, settings), false);
  // The same reminder again the next day is not "already on the list": the first one went out.
  assert.match(await f.run('remind in 1 min take medicine'), /^Reminder 5 set/);
  f.advance(MIN);
  assert.equal(await r.tick(), 1);
  f.advance(3 * DAY);
  f.items.purge(A, f.now, settings);
  const texts = () => f.items.read(A).items.map(x => `${x.n}:${x.status}`).join(' ');
  // Day 4: the first reminder went out over 3 days ago and is closed; the suggestion is younger than 7 days.
  assert.equal(texts(), '1:suggested 3:done 4:open 5:open');
  f.advance(5 * DAY);
  f.items.purge(A, f.now, settings);
  assert.equal(texts(), '3:done 4:open 5:done');
  f.advance(31 * DAY);
  f.items.purge(A, f.now, settings);
  // Open items without a reminder stay until someone closes them.
  assert.equal(texts(), '4:open');
});

test('a kept request stays listed until its deadline, however early its reminder was', async t => {
  const f = fixture(t, { reminders: { closeAfterDays: 3 } });
  f.items.add(A, { text: 'hand in the thesis', status: 'suggested', by: 'ai', now: f.now, due: f.now + 20 * DAY, settings: f.config.reminders });
  assert.match(await f.run('keep 1 in 1 day'), /^Kept 1/);
  const r = runner(f);
  f.advance(DAY);
  assert.equal(await r.tick(), 1);
  f.advance(10 * DAY);
  f.items.purge(A, f.now, f.config.reminders);
  assert.equal(f.items.active(A).open.length, 1);
  f.advance(13 * DAY);
  f.items.purge(A, f.now, f.config.reminders);
  assert.equal(f.items.active(A).open.length, 0);
});

test('the same text can be set for different times, not twice for the same time; issues tidies first', async t => {
  const f = fixture(t);
  assert.match(await f.run('remind Mon 9am take the bins out'), /^Reminder 1 set/);
  assert.match(await f.run('remind Thu 9am take the bins out'), /^Reminder 2 set/);
  assert.match(await f.run('remind Mon 9am take the bins out'), /already on the list for that time/);
  f.items.add(A, { text: 'deadline soon', status: 'suggested', by: 'ai', now: f.now, due: f.now + HOUR, settings: f.config.reminders });
  assert.match(await f.run('issues'), /deadline soon/);
  f.advance(2 * HOUR);
  assert.doesNotMatch(await f.run('issues'), /deadline soon/);
});

test('a list that cannot be saved names only its file, and costs no reply budget', async t => {
  const f = fixture(t);
  const blocked = path.join(f.directory, 'not-a-folder');
  fs.writeFileSync(blocked, 'x');
  await assert.rejects(Promise.resolve().then(() => new Items(blocked).add(A, { text: 'x', by: 'owner', now: f.now, settings: f.config.reminders })), error => {
    // Linux already fails the read (ENOTDIR), Windows the save: either way only the file is named.
    assert.match(error.message, /^data\/items\/111@g\.us\.json (?:could not be saved|cannot be read) \(/);
    assert.equal(error.message.includes(f.directory), false);
    return true;
  });
  await f.run('remind in 1 min one');
  const broken = Object.create(f.items);
  broken.claim = () => { throw new Error('data/items/111@g.us.json could not be saved (EDQUOT)'); };
  const errors = [];
  const tick = createReminderRunner({ items: broken, getPolicies: () => f.policies, getConfig: () => f.config, clock: f.clock,
    replyGate: createReplyGate({ config: f.config.replies, state: f.safety.state, clock: f.clock }), log: () => {}, onError: line => errors.push(line),
    sendText: async () => { throw new Error('must not be sent'); } });
  f.advance(MIN);
  for (let i = 0; i < 5; i++) { await tick(); f.advance(15000); }
  assert.equal(f.safety.state.replyAttempts.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Reminders for Class not posted: .*EDQUOT/);
});

test('a reminder whose send failed is listed as possibly not posted', async t => {
  const f = fixture(t);
  await f.run('remind in 1 min pay the deposit');
  const r = runner(f, { send: async () => { throw new Error('offline'); } });
  f.advance(MIN);
  await r.tick();
  assert.match(await f.run('issues'), /1\. pay the deposit \(reminder Thu 5 Nov 21:31 may not have been posted: sending failed\)/);
});

test('the hourly reminder limits count posts from the lists, so a restart does not reset them', async t => {
  const f = fixture(t, { reminders: { maxRemindersPerChatPerHour: 2 }, replies: { minIntervalSeconds: 1, chatCooldownSeconds: 0 } });
  for (let i = 1; i <= 3; i++) await f.run(`remind in 1 min r${i}`);
  f.advance(MIN);
  const before = runner(f);
  await before.tick(); f.advance(2000); await before.tick(); f.advance(2000);
  assert.equal(before.sent.length, 2);
  const after = runner(f);
  await after.tick();
  assert.equal(after.sent.length, 0);
  assert.match(after.logs.join('\n'), /waits; 2 reminders an hour per chat/);
  // The reply budget the gate was made with decides the reminders' share, not a reloaded setting.
  const g = fixture(t, { replies: { minIntervalSeconds: 1, chatCooldownSeconds: 0 } });
  for (let i = 1; i <= 3; i++) await g.run(`remind in 1 min s${i}`);
  g.advance(MIN);
  const sent = [];
  const tick = createReminderRunner({ items: g.items, getPolicies: () => g.policies, getConfig: () => g.config, clock: g.clock,
    replyGate: createReplyGate({ config: g.config.replies, state: g.safety.state, clock: g.clock }), replyLimits: { maxPerHour: 2 },
    log: () => {}, onError: () => {}, sendText: async (chatId, body) => { sent.push(body); } });
  for (let i = 0; i < 4; i++) { await tick(); g.advance(2000); }
  assert.equal(sent.length, 1);
});

test('items files are private, written whole, and a damaged one is reported rather than replaced', { skip: process.platform === 'win32' && 'POSIX modes' }, async t => {
  const f = fixture(t);
  await f.run('issue one');
  assert.equal(fs.statSync(f.items.file(A)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(f.items.file(A))), [path.basename(f.items.file(A))]);
  fs.writeFileSync(f.items.file(A), '{ broken');
  // The router posts a failed command's error in the chat: it names the file, not the server's folders.
  await assert.rejects(f.run('issue two'), error => {
    assert.match(error.message, /^data\/items\/111@g\.us\.json cannot be read \(not valid JSON\); the owner can move it aside/);
    assert.equal(error.message.includes(f.directory), false);
    return true;
  });
  assert.equal(fs.readFileSync(f.items.file(A), 'utf8'), '{ broken');
});

function runner(f, { send, sendTimeoutMs } = {}) {
  const sent = [], logs = [], errors = [];
  const replyGate = createReplyGate({ config: f.config.replies, state: f.safety.state, clock: f.clock });
  const tick = createReminderRunner({ items: f.items, getPolicies: () => f.policies, getConfig: () => f.config, replyGate,
    clock: f.clock, log: line => logs.push(line), onError: line => errors.push(line), sendTimeoutMs,
    sendText: send || (async (chatId, body, options) => { sent.push({ chatId, body, quoted: options?.quotedMessageId }); }) });
  return { tick, sent, logs, errors, replyGate };
}

test('a due reminder is posted once, quoting the command that set it, with how to close it', async t => {
  const f = fixture(t);
  await f.run('remind in 10 min check the oven');
  const r = runner(f);
  assert.equal(await r.tick(), 0);
  f.advance(10 * MIN);
  assert.equal(await r.tick(), 1);
  assert.deepEqual(r.sent, [{ chatId: A, body: '🤖 Reminder 1: check the oven. When it is finished: !bot done 1', quoted: 'cmd1' }]);
  f.advance(MIN);
  assert.equal(await r.tick(), 0);
  assert.match(await f.run('issues'), /1\. check the oven \(reminded Thu 5 Nov 21:40\)/);
});

test('reminders follow the send setting, the reply budget and pauses', async t => {
  const f = fixture(t, { other: { send: false } });
  await f.run('remind in 5 min one');
  await f.run('remind in 5 min two');
  f.items.add(B, { text: 'send off here', by: 'owner', now: f.now, remindAt: f.now + 5 * MIN, settings: f.config.reminders });
  const r = runner(f);
  f.advance(5 * MIN);
  // Two due at once: the reply spacing lets one through; the other waits for the next check.
  assert.equal(await r.tick(), 1);
  assert.equal(f.items.due(A, f.now).length, 1);
  f.advance(10000);
  assert.equal(await r.tick(), 1);
  assert.deepEqual(r.sent.map(x => x.body.split(':')[0]), ['🤖 Reminder 1', '🤖 Reminder 2']);
  // A chat with send off never gets one, even with the budget free, and it is not marked as posted.
  f.advance(10000);
  assert.equal(await r.tick(), 0);
  assert.equal(r.sent.some(x => x.chatId === B), false);
  assert.equal(f.items.due(B, f.now).length, 1);
  // Send turned off by a reload after the list was read: the current setting decides.
  await f.run('remind in 1 min three');
  f.advance(MIN);
  f.policies.get(A).send = false;
  assert.equal(await r.tick(), 0);
  f.policies.get(A).send = true;
  // While replies are paused nothing is posted.
  r.replyGate.pause('TEST');
  assert.equal(await r.tick(), 0);
  assert.equal(r.sent.length, 2);
});

test('a burst of reminders is spread out: a few per chat an hour, and half the reply budget at most', async t => {
  const f = fixture(t, { reminders: { maxRemindersPerChatPerHour: 2 }, replies: { maxPerHour: 6, minIntervalSeconds: 1, chatCooldownSeconds: 0 } });
  for (let i = 1; i <= 4; i++) await f.run(`remind in 1 min a${i}`);
  for (let i = 1; i <= 3; i++) await f.run(`remind in 1 min b${i}`, { chatId: B });
  const r = runner(f);
  f.advance(MIN);
  for (let i = 0; i < 12; i++) { await r.tick(); f.advance(2000); }
  // Each chat got its turn; at most 2 per chat and 3 (half of 6) in all within the hour.
  assert.deepEqual(r.sent.map(x => /Reminder \d+: (\S+)\./.exec(x.body)[1]).sort(), ['a1', 'a2', 'b1']);
  assert.match(r.logs.join('\n'), /waits; 2 reminders an hour per chat/);
  assert.match(r.logs.join('\n'), /waits; reminders may use half of the hourly reply budget/);
  f.advance(HOUR);
  for (let i = 0; i < 12; i++) { await r.tick(); f.advance(2000); }
  assert.equal(r.sent.length, 6);
});

test('a reminder changed or closed while another is being sent is not posted with stale details', async t => {
  const f = fixture(t, { replies: { minIntervalSeconds: 1, chatCooldownSeconds: 0 } });
  await f.run('remind in 1 min one');
  await f.run('remind in 1 min two');
  await f.run('remind in 1 min three');
  let first = true;
  const sent = [];
  const r = runner(f, { send: async (chatId, body) => {
    sent.push(body);
    if (first) { first = false; f.advance(10000); await f.run('drop 2'); await f.run('keep 3 tomorrow 9am'); }
  } });
  f.advance(MIN);
  await r.tick();
  f.advance(10000);
  await r.tick();
  assert.deepEqual(sent.map(body => body.split(':')[0]), ['🤖 Reminder 1']);
  assert.equal(f.items.read(A).items.find(x => x.n === 2).firedAt, null);
  assert.match(await f.run('issues'), /3\. three \(reminder Fri 6 Nov 09:00\)/);
});

test('send turns off while reminders are going out: the rest wait, unclaimed', async t => {
  const f = fixture(t, { replies: { minIntervalSeconds: 1, chatCooldownSeconds: 0 } });
  await f.run('remind in 1 min one');
  await f.run('remind in 1 min two');
  const sent = [];
  const r = runner(f, { send: async (chatId, body) => { sent.push(body); f.advance(10000); f.policies.get(A).send = false; } });
  f.advance(MIN);
  assert.equal(await r.tick(), 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(f.items.due(A, f.now).map(item => item.n), [2]);
});

test('a reminder more than lateGraceHours late is not posted but stays on the list', async t => {
  const f = fixture(t, { reminders: { lateGraceHours: 6 } });
  await f.run('remind in 1 hour old one');
  const r = runner(f);
  f.advance(8 * HOUR);
  assert.equal(await r.tick(), 0);
  assert.equal(r.sent.length, 0);
  assert.match(r.logs.join('\n'), /reminder 1 was due Thu 5 Nov 22:30, more than 6h ago; not posted/);
  assert.match(await f.run('issues'), /1\. old one \(reminder Thu 5 Nov 22:30 not posted: the bot was off, paused or out of budget too long\)/);
  f.advance(MIN);
  assert.equal(await r.tick(), 0);
  assert.throws(() => validateConfig({ ...structuredClone(f.config), reminders: { ...f.config.reminders, lateGraceHours: 0 } }), /lateGraceHours/);
});

test('a reminder that fails to send pauses replies and is never retried', async t => {
  const f = fixture(t);
  await f.run('remind in 1 min one');
  await f.run('remind in 1 min two');
  const r = runner(f, { send: async () => { throw new Error('offline'); } });
  f.advance(MIN);
  assert.equal(await r.tick(), 0);
  assert.equal(r.replyGate.paused, true);
  assert.match(r.errors.join('\n'), /Reminder 1 in Class failed; further replies are paused.*offline/);
  // Marked before sending: a failure or crash can never post the same reminder twice.
  assert.equal(f.items.due(A, f.now).map(item => item.n).join(), '2');
});

test('a send that never settles counts as a failed send, and the next check still runs', async t => {
  const f = fixture(t);
  await f.run('remind in 1 min one');
  const r = runner(f, { send: () => new Promise(() => {}), sendTimeoutMs: 30 });
  f.advance(MIN);
  assert.equal(await r.tick(), 0);
  assert.equal(r.replyGate.paused, true);
  assert.match(r.errors.join('\n'), /did not confirm the message within 0 seconds/);
  // The runner is free again (it would return at once if it still thought a check was running).
  await f.run('remind in 1 min two');
  f.advance(MIN);
  assert.equal(await r.tick(), 0);
  assert.equal(f.items.due(A, f.now).length, 1);
});

test('members can call reminders only where the chat lets them, and only after the owner opened the chat', async t => {
  const f = fixture(t, { other: { callers: 'me' } });
  const replies = [], logs = [];
  const replyGate = createReplyGate({ config: { ...f.config.replies, minIntervalSeconds: 1, chatCooldownSeconds: 0 }, clock: f.clock });
  const route = createRouter({ getPolicies: () => f.policies, getConfig: () => f.config, archive: f.archive, moderate: async () => null,
    replyGate, startedAt: f.now - 1000, log: line => logs.push(line), onError: line => logs.push(line),
    commands: createCommands({ getConfig: () => f.config, items: f.items, clock: f.clock }) });
  let counter = 0;
  const say = async (chat, body, fromMe = false) => {
    const id = `r${counter++}`;
    await route({ id: { _serialized: `${fromMe}_${chat}_${id}`, id }, from: fromMe ? 'me@c.us' : chat, to: fromMe ? chat : 'me@c.us',
      author: fromMe ? undefined : 'alice@lid', fromMe, body, type: 'chat', timestamp: Math.floor(f.now / 1000),
      reply: async text => { replies.push({ chat, text }); return { id: { _serialized: `true_${chat}_x${counter++}` } }; } });
    await route.idle();
    f.advance(2000);
  };
  await say(A, '!bot remind tomorrow 9am before the owner');
  assert.equal(f.items.active(A).open.length, 0);
  await say(A, '!bot ping', true);
  await say(A, '!bot remind tomorrow 9am after the owner');
  assert.deepEqual(f.items.active(A).open.map(x => [x.text, x.by]), [['after the owner', 'member']]);
  await say(B, '!bot ping', true);
  await say(B, '!bot remind tomorrow 9am member here');
  assert.equal(f.items.active(B).open.length, 0);
  assert.ok(logs.some(line => /callers is "me"/.test(line)));
});

test('spotting requests: only new messages that look like requests reach the AI, and suggestions are only listed', async t => {
  const f = fixture(t);
  const ts = Math.floor(NOW / 1000);
  f.add({ id: 'm1', ts: ts - 600, text: 'Can you send the slides by Friday 5pm?' });
  f.add({ id: 'm2', ts: ts - 500, text: 'lol' });
  f.add({ id: 'm3', ts: ts - 400, text: '!bot issues', fromMe: true });
  f.add({ id: 'm4', ts: ts - 300, text: '🤖 No open items.', fromMe: true });
  f.add({ id: 'm5', ts: ts - 100, text: 'Call +44 7700 900123 tomorrow' }, B);
  await f.run('remind tomorrow 9am call Alice on +44 7700 900123 or alice@example.com');
  f.answer = '[{"text": "Send the slides", "due": "2026-11-06T17:00"}, {"text": "  lol  ", "due": "yesterday"}]';
  const result = await f.detect();
  assert.equal(result.done, true, result.text);
  assert.equal(result.text, 'Looked at 2 new messages: 2 suggestions added.');
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.mode, 'detect');
  assert.match(request.transcript, /^\[Thu 05 Nov 21:20\] Member-[0-9a-f]{4}: Can you send the slides by Friday 5pm\?/);
  assert.doesNotMatch(request.transcript, /issues|No open items|7700/);
  assert.match(request.nowText, /^Now: Thursday 5 November 2026, 21:30 \(Europe\/London\)\. The message times below are Europe\/London time too\.$/);
  assert.match(request.system, /at most 5 objects.*Europe\/London local time/s);
  // The list's own text is scrubbed like the messages before it goes to the AI.
  assert.deepEqual(request.existing, ['call Alice on [phone] or [email]']);
  const { open, suggested } = f.items.active(A);
  assert.equal(open.length, 1);
  assert.deepEqual(suggested.map(x => [x.n, x.text, x.by, x.due && iso(x.due)]), [[2, 'Send the slides', 'ai', '2026-11-06T17:00'], [3, 'lol', 'ai', null]]);
  assert.match(await f.run('issues', { fromMe: false }), /Spotted in messages by the AI, not kept yet \(2\)\. !bot keep N \[when\] or !bot drop N:\n2\. Send the slides \(due Fri 6 Nov 17:00\)\n3\. lol/);
  // Already looked at: nothing new, no AI run.
  f.advance(61 * MIN);
  assert.deepEqual(await f.detect(), { done: false, text: 'no new messages.', added: [] });
  f.advance(-61 * MIN);
  // Keeping it sets a reminder leadHours before the deadline, or an hour before if that is too soon.
  assert.match(await f.run('keep 2'), /^Kept 2: Send the slides\. Reminder Fri 6 Nov 16:00 \(London time\)\.$/);
  assert.equal(defaultReminder(NOW + 3 * DAY, f.config, NOW), NOW + 2 * DAY);
  assert.equal(defaultReminder(NOW + 30 * MIN, f.config, NOW), null);
  assert.match(await f.run('keep 3'), /^Kept 3: lol\. No reminder; set one with !bot keep 3 <when>\.$/);
  assert.match(await f.run('done 2'), /^Done: 2\./);
});

test('spotted text cannot carry links or long numbers into the chat, and a suggestion cannot be closed as done', async t => {
  const f = fixture(t);
  f.add({ id: 'l1', ts: Math.floor(NOW / 1000) - 5, text: 'Please pay the deposit today' });
  f.answer = '[{"text": "Pay the deposit at https://evil.example/pay to account 12 3456 7890", "due": null},' +
    ' {"text": "Or at bit.ly/3xYz, call 0800-123-4567 by 2026-11-20", "due": null}]';
  await f.detect();
  const [item, second] = f.items.active(A).suggested;
  assert.equal(item.text, 'Pay the deposit at [link] to account [number]');
  assert.equal(second.text, 'Or at [link] call [number] by 2026-11-20');
  assert.match(await f.run(`done ${item.n}`), /only a suggestion: keep it first, or drop it/);
});

test('message times for spotting requests are London time, summer time included', async t => {
  // Whatever this machine's own zone is, the times must come out in London time.
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Taipei';
  t.after(() => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; });
  assert.notEqual(new Date(Date.UTC(2027, 0, 1)).getHours(), 0, 'the test process must not be on UTC/London time here');
  const july = Date.UTC(2027, 6, 1, 23, 30) / 1000; // 00:30 on Fri 2 Jul in London
  assert.match(renderTranscript([{ ts: july, sender: 'a@lid', text: 'x' }], { secret: Buffer.alloc(32), timeZone: LONDON }), /^\[Fri 02 Jul 00:30\]/);
  const f = fixture(t);
  f.advance(Date.UTC(2027, 6, 1, 23, 40) - NOW);
  f.add({ id: 's1', ts: july, text: 'Bring the forms tomorrow' });
  await f.detect();
  assert.match(f.requests[0].transcript, /^\[Fri 02 Jul 00:30\]/);
  assert.match(f.requests[0].nowText, /Friday 2 July 2027, 00:40/);
});

test('spotting requests is off unless the chat has AI, detect and the archive on, and runs only from the timer or the CLI', async t => {
  const f = fixture(t, { other: { detect: false } });
  f.add({ id: 'b1', ts: Math.floor(NOW / 1000) - 60, text: 'Please pay by Monday' }, B);
  assert.match((await f.service.detect({ chatId: B, source: 'timer' })).text, /spotting requests is off/);
  assert.match((await f.service.detect({ chatId: A, source: 'web' })).text, /runs only on the bot's schedule, from the owner's "spot" message or from the local CLI/);
  // From a chat, only the owner's own message in that very chat starts a run.
  assert.match((await f.service.detect({ chatId: A, source: 'chat' })).text, /only the owner can start a check/);
  assert.match((await f.service.detect({ chatId: A, source: 'chat', message: { fromMe: false, to: A } })).text, /only the owner/);
  assert.match((await f.service.detect({ chatId: A, source: 'chat', message: { fromMe: true, to: B } })).text, /only the owner/);
  f.policies.get(A).archive = false;
  assert.match((await f.detect()).text, /not archived/);
  f.policies.get(A).archive = true;
  f.policies.get(A).ai = false;
  assert.match((await f.detect()).text, /AI is off/);
  assert.equal(f.requests.length, 0);
  assert.throws(() => validateConfig({ ...loadConfig(), chats: [{ id: A, receive: true, ai: false, detect: true }] }), /detect .* needs ai: true/);
});

test('one AI run per chat at a time', async t => {
  let release;
  const f = fixture(t, { provider: () => new Promise(resolve => { release = () => resolve('[]'); }) });
  f.add({ id: 'p1', ts: Math.floor(NOW / 1000) - 5, text: 'Please call the plumber' });
  const first = f.detect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.detect()).text, 'another AI request is running.');
  release();
  assert.equal((await first).done, true);
});

test('messages with nothing that looks like a request are skipped without an AI run', async t => {
  const f = fixture(t);
  const ts = Math.floor(NOW / 1000);
  f.add({ id: 'c1', ts: ts - 50, text: 'haha nice one' });
  assert.match((await f.detect()).text, /nothing in the new messages looks like a request/);
  assert.equal(f.requests.length, 0);
  // Counted as looked at: only the next new message goes to the AI.
  f.add({ id: 'c2', ts: ts - 10, text: '明天下午三點交報告' });
  f.answer = '[{"text": "交報告", "due": "2026-11-06T15:00"}]';
  assert.equal((await f.detect()).done, true);
  assert.equal(f.requests.length, 1);
  assert.doesNotMatch(f.requests[0].transcript, /haha/);
  assert.match(f.requests[0].transcript, /明天下午三點交報告/);
});

test('a chat whose spotting was off for a while starts again from one day back, not from its old place', async t => {
  const f = fixture(t);
  f.items.update(A, data => { data.scan = { to: Math.floor(NOW / 1000) - 30 * 86400, ids: [] }; });
  f.add({ id: 'old', ts: Math.floor(NOW / 1000) - 20 * 86400, text: 'Please book the hall for last month' });
  f.add({ id: 'new', ts: Math.floor(NOW / 1000) - 60, text: 'Please book the hall for Friday' });
  assert.equal((await f.detect()).done, true);
  assert.match(f.requests[0].transcript, /for Friday/);
  assert.doesNotMatch(f.requests[0].transcript, /last month/);
});

test('a batch that does not fit is finished next time, messages in the same second included', async t => {
  const f = fixture(t, { summary: { maxTranscriptChars: 60 } });
  const ts = Math.floor(NOW / 1000) - 30;
  f.add({ id: 'q1', ts, text: 'Please bring the cables tomorrow' });
  f.add({ id: 'q2', ts, text: 'Please bring the speakers tomorrow' });
  assert.equal((await f.detect()).text, 'Looked at 1 new messages: nothing new to add.');
  assert.match(f.requests[0].transcript, /cables/);
  assert.doesNotMatch(f.requests[0].transcript, /speakers/);
  f.advance(61 * MIN);
  assert.equal((await f.detect()).done, true);
  assert.match(f.requests[1].transcript, /speakers/);
  assert.doesNotMatch(f.requests[1].transcript, /cables/);
  f.advance(61 * MIN);
  assert.equal((await f.detect()).text, 'no new messages.');
});

test('a broken AI answer adds nothing and is not retried; a failed run is retried once, then skipped', async t => {
  const f = fixture(t, { reminders: { maxDetectPerChatPerDay: 10 } });
  const ts = Math.floor(NOW / 1000);
  f.add({ id: 'd1', ts: ts - 50, text: 'Please book the room for Monday' });
  f.answer = 'Sure! Here are the tasks: book the room';
  await assert.rejects(f.detect(), /not a usable list \(no JSON list in it\); nothing was added/);
  assert.equal(f.items.active(A).suggested.length, 0);
  f.advance(61 * MIN);
  assert.equal((await f.detect()).text, 'no new messages.');
  // A failed run (network, refusal, limits) leaves the messages for one more try.
  f.add({ id: 'd2', ts: Math.floor(f.now / 1000) - 5, text: 'Also pay the deposit by Friday' });
  f.answer = () => { throw new Error('API down'); };
  await assert.rejects(f.detect(), /^Error: API down$/);
  f.advance(61 * MIN);
  f.answer = '```json\n[{"text": "Pay the deposit", "due": null}]\n```';
  const result = await f.detect();
  assert.equal(result.done, true, result.text);
  assert.match(f.requests[f.requests.length - 1].transcript, /pay the deposit/);
  assert.deepEqual(f.items.active(A).suggested.map(x => x.text), ['Pay the deposit']);
  // A second failure on the same messages skips them, so one chat cannot use up the shared daily limit.
  f.add({ id: 'd3', ts: Math.floor(f.now / 1000) - 5, text: 'Need the keys by Monday' });
  f.answer = () => { throw new Error('refused'); };
  f.advance(61 * MIN);
  await assert.rejects(f.detect(), /^Error: refused$/);
  f.advance(61 * MIN);
  await assert.rejects(f.detect(), /refused; this was the second failed run on these messages, so they are skipped/);
  f.advance(61 * MIN);
  assert.equal((await f.detect()).text, 'no new messages.');
});

test('a message deleted for everyone while the AI looks leaves no suggestion behind', async t => {
  const f = fixture(t);
  const ts = Math.floor(NOW / 1000);
  f.add({ id: 'x1', ts: ts - 20, text: 'Ring Bob about his diagnosis tomorrow' });
  f.add({ id: 'x2', ts: ts - 10, text: 'And book the hall by Friday' });
  f.answer = () => { f.archive.revoke(A, 'x1'); return '[{"text": "Ring Bob about his diagnosis", "due": null}]'; };
  assert.match((await f.detect()).text, /deleted meanwhile; it will be looked at again without it/);
  assert.equal(f.items.active(A).suggested.length, 0);
  f.advance(61 * MIN);
  f.answer = '[{"text": "Book the hall", "due": null}]';
  assert.equal((await f.detect()).done, true);
  assert.doesNotMatch(f.requests[1].transcript, /Bob/);
  assert.deepEqual(f.items.active(A).suggested.map(x => x.text), ['Book the hall']);
});

test('spotting requests has its own budget and never uses up summaries or questions', async t => {
  const f = fixture(t, { reminders: { maxDetectPerDay: 2, detectEveryMinutes: 60 }, summary: { maxPerDay: 1, maxPerHour: 1 } });
  let ts = Math.floor(NOW / 1000);
  const next = text => { ts = Math.floor(f.now / 1000); f.add({ id: `e${ts}`, ts, text }); };
  next('Please call the plumber today');
  assert.equal((await f.detect()).done, true);
  f.advance(10 * MIN);
  next('And book the van tomorrow');
  assert.match((await f.detect()).text, /checked less than 60 minutes ago/);
  f.advance(51 * MIN);
  assert.equal((await f.detect()).done, true);
  f.advance(61 * MIN);
  next('Need milk by 5pm');
  assert.match((await f.detect()).text, /daily limit for spotting requests \(2\) is reached/);
  // Summaries and questions still have their whole budget.
  const answer = await f.service({ chatId: A, source: 'cli', hours: 24 });
  assert.match(answer, /^Summary of the last 24h/);
});

test('suggestions are cleaned: at most maxSuggestions, real future times only, no duplicates of the list', async t => {
  const now = NOW;
  const read = reply => readSuggestions(reply, { now, timeZone: LONDON, defaultHour: 9, max: 3, maxText: 20, maxDaysAhead: 400 });
  assert.deepEqual(read('[]'), []);
  assert.throws(() => read('none'), /no JSON list/);
  assert.throws(() => read('[{"text": }]'), /not valid JSON/);
  const found = read(JSON.stringify([{ text: 'a', due: '2026-11-07T10:00' }, { text: 'b', due: '2020-01-01T10:00' }, { text: 7 },
    { text: 'c'.repeat(40), due: '2026-11-07' }, { text: 'd' }]));
  assert.deepEqual(found.map(x => [x.text, x.due && iso(x.due)]), [['a', '2026-11-07T10:00'], ['b', null], [`${'c'.repeat(19)}…`, '2026-11-07T09:00']]);
  const f = fixture(t);
  await f.run('issue Send the slides');
  await f.run('remind tomorrow 9am book the room');
  f.add({ id: 'g1', ts: Math.floor(NOW / 1000) - 5, text: 'Remember to send the slides!' });
  f.answer = '[{"text": "send the slides", "due": null}, {"text": "Book the room", "due": null}, {"text": "Print handouts", "due": null}]';
  const result = await f.detect();
  assert.deepEqual(result.added.map(x => x.text), ['Print handouts']);
  assert.deepEqual(f.requests[0].existing, ['book the room', 'Send the slides']);
});

test('reminder settings are checked and shown', () => {
  const config = loadConfig();
  assert.equal(config.reminders.timeZone, 'Europe/London');
  assert.throws(() => validateConfig({ ...structuredClone(config), reminders: { ...config.reminders, timeZone: 'Mars/Base' } }), /reminders\.timeZone/);
  assert.throws(() => validateConfig({ ...structuredClone(config), reminders: { ...config.reminders, detectEveryMinutes: 5 } }), /detectEveryMinutes/);
  assert.throws(() => validateConfig({ ...structuredClone(config), reminders: { ...config.reminders, maxOpenPerChat: 0 } }), /maxOpenPerChat/);
  const older = structuredClone(config);
  delete older.reminders;
  older.chats = [{ id: A, receive: true }];
  validateConfig(older);
  assert.equal(older.reminders.maxDetectPerDay, 24);
  assert.equal(older.reminders.suggestionDays, 7);
  assert.equal(older.chats[0].detect, false);
  assert.match(permissionText({ receive: true, send: true, ai: true, detect: true, aiPerDay: 3 }), /AI on \(3 a day\), spots requests/);
});

test('a flood of messages cannot run up the AI: a few checks per chat a day, and a capped amount of text per check', async t => {
  const f = fixture(t, { reminders: { maxDetectPerChatPerDay: 2, maxDetectChars: 1000 } });
  let ts = Math.floor(NOW / 1000) - 3000;
  for (let i = 0; i < 60; i++) f.add({ id: `flood${i}`, ts: ts++, text: `Please buy item number ${i} before Friday, it is urgent` });
  assert.equal((await f.detect()).done, true);
  assert.ok(f.requests[0].transcript.length <= 1000, `transcript of ${f.requests[0].transcript.length} characters`);
  assert.ok(f.requests[0].transcript.split('\n').length < 60);
  f.advance(61 * MIN);
  assert.equal((await f.detect()).done, true);
  f.advance(61 * MIN);
  assert.match((await f.detect()).text, /this chat's limit of 2 checks a day is reached/);
  assert.equal(f.requests.length, 2);
});
