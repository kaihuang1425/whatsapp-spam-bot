'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, validateConfig } = require('../src/config');
const { buildPolicies } = require('../src/chats');
const { SafetyStore, createReplyGate } = require('../src/safety');
const { createSummaryService } = require('../src/summarise');
const { tempDirectory } = require('./helpers');

const CHAT = '123@g.us';
function fixture(t, changes = {}) {
  const config = loadConfig();
  config.chats = [{ id: CHAT, label: 'Class', receive: true, send: true, buzzword: '!bot', ai: true, ...changes }];
  validateConfig(config);
  let policies = buildPolicies(config);
  const directory = tempDirectory(t);
  const safety = new SafetyStore(directory);
  let now = 1800000000000, calls = 0, reads = 0;
  const requests = [];
  const archive = { read() { reads++; return [{ text: 'Exam Friday, call +44 7700 900123', sender: 'alice@lid', ts: now / 1000 }]; } };
  const provider = async request => { calls++; requests.push(request); return '- Exam Friday'; };
  const replyGate = createReplyGate({ config: config.replies, state: safety.state, clock: () => now });
  const options = { getConfig: () => config, getPolicies: () => policies, archive, safety, replyGate,
    getSecret: () => Buffer.alloc(32), provider, clock: () => now };
  let service = createSummaryService(options);
  const request = (extra = {}) => service({ chatId: CHAT, source: 'chat',
    message: { fromMe: true, to: CHAT, type: 'chat', body: '!bot summary' }, ...extra });
  return { config, safety, options, request, requests, directory, get calls() { return calls; }, get reads() { return reads; },
    advance: ms => { now += ms; }, policies: value => { policies = value; }, rebuild: extra => { service = createSummaryService({ ...options, ...extra }); } };
}

test('AI off and unlisted requests cannot reach a throwing provider or read transcripts', async t => {
  const f = fixture(t, { ai: false });
  f.rebuild({ provider: async () => assert.fail('AI gate was bypassed') });
  assert.match(await f.request(), /AI is off/);
  f.policies(new Map());
  assert.match(await f.request(), /not enabled/);
  assert.equal(f.reads, 0);
  assert.deepEqual(f.safety.state.aiStats, { allowed: 0, blocked: 2, reasons: { ai_off: 1, unlisted: 1 } });
});

test('AI is off by default for new chats and legacy groupIds', () => {
  const config = loadConfig();
  config.groupIds = ['456@g.us'];
  config.chats = [{ id: CHAT }];
  const policies = buildPolicies(validateConfig(config));
  assert.equal(policies.get(CHAT).ai, false);
  assert.equal(policies.get('456@g.us').ai, false);
  assert.equal(config.logOtherChats, false);
});

test('the AI gate enforces receive, send, archive, buzzword, owner and request source', async t => {
  for (const changes of [{ receive: false, buzzword: '' }, { send: false }, { archive: false }]) {
    const f = fixture(t, changes);
    assert.match(await f.request(), /not run/);
    assert.equal(f.calls, 0);
  }
  const f = fixture(t);
  for (const body of ['summary', '!botany summary', '!bot summary please', '!bot ping']) {
    await f.request({ message: { fromMe: true, to: CHAT, type: 'chat', body } });
  }
  await f.request({ message: { fromMe: false, from: CHAT, type: 'chat', body: '!bot summary' } });
  await f.request({ message: { fromMe: true, to: '999@g.us', type: 'chat', body: '!bot summary' } });
  await f.request({ source: 'timer' });
  assert.equal(f.calls, 0);
  assert.equal(f.reads, 0);
});

test('allowed requests use live permissions, scrubbed transcripts and persistent attempt counters', async t => {
  const f = fixture(t);
  assert.match(await f.request(), /Exam Friday/);
  assert.equal(f.calls, 1);
  assert.match(f.requests[0].transcript, /Member-[0-9a-f]{4}.*\[phone\]/);
  assert.equal(f.requests[0].model, f.config.summary.model);
  assert.equal(f.requests[0].effort, 'low');
  const reloaded = new SafetyStore(f.directory);
  assert.equal(reloaded.state.aiStats.allowed, 1);
  assert.equal(reloaded.state.aiAttempts.length, 1);
  assert.ok(!fs.readFileSync(path.join(f.directory, 'safety.json'), 'utf8').includes(CHAT));
  f.policies(new Map());
  assert.match(await f.request(), /not enabled/);
  assert.equal(f.calls, 1);
});

test('CLI summaries use the same AI switch and persistent cooldown; resume retains both', async t => {
  const f = fixture(t, { ai: false });
  assert.match(await f.request({ source: 'cli' }), /AI is off/);
  f.config.chats[0].ai = true;
  f.policies(buildPolicies(f.config));
  await f.request({ source: 'cli' });
  f.rebuild({ safety: new SafetyStore(f.directory) });
  f.advance(4000);
  assert.match(await f.request({ source: 'cli' }), /Please wait/);
  const stored = new SafetyStore(f.directory);
  stored.resume({ reviewed: true });
  assert.equal(new SafetyStore(f.directory).state.aiAttempts.length, 1);
  assert.equal(new SafetyStore(f.directory).state.aiStats.blocked, 2);
  assert.equal(f.calls, 1);
});

test('hourly AI budget, reply budgets and pauses block before reading transcripts', async t => {
  const f = fixture(t);
  f.config.summary.maxPerHour = 1;
  await f.request();
  f.advance(61000);
  assert.match(await f.request(), /AI hourly/);
  assert.equal(f.calls, 1);
  const paused = fixture(t);
  paused.safety.state.replyPause = { time: 1, reason: 'SEND_FAILURE' };
  assert.match(await paused.request(), /paused/);
  assert.equal(paused.reads, 0);
  const reply = fixture(t);
  reply.options.replyGate.reserve(CHAT);
  assert.match(await reply.request(), /reply budget/);
  assert.equal(reply.reads, 0);
});

test('persistence errors and API failures never replenish the AI budget', async t => {
  const f = fixture(t);
  f.safety.save = () => { throw new Error('disk full'); };
  await assert.rejects(f.request(), /disk full/);
  assert.equal(f.calls, 0);
  const failed = fixture(t);
  failed.rebuild({ provider: async () => { throw new Error('provider down'); } });
  await assert.rejects(failed.request(), /provider down/);
  assert.equal(new SafetyStore(failed.directory).state.aiAttempts.length, 1);
  failed.advance(4000);
  assert.match(await failed.request(), /Please wait/);
});

test('older safety files keep existing pauses and attempts when AI fields are added', t => {
  const f = fixture(t);
  delete f.safety.state.aiStats;
  delete f.safety.state.aiAttempts;
  f.safety.state.deletionPause = { time: 1, reason: 'DELETE_FAILURE' };
  f.safety.state.replyAttempts = [{ time: 2, chat: 'hashed' }];
  f.safety.save();
  const reloaded = new SafetyStore(f.directory);
  assert.equal(reloaded.state.deletionPause.reason, 'DELETE_FAILURE');
  assert.equal(reloaded.state.replyAttempts.length, 1);
  assert.equal(reloaded.state.aiStats.allowed, 0);
});

test('the private SDK adapter is reachable only through the gate and keeps model, effort and refusal handling', async t => {
  const f = fixture(t);
  const requests = [];
  const client = { messages: { create: async request => {
    requests.push(request);
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: '- Exam Friday' }] };
  } } };
  f.rebuild({ provider: null, isAvailable: () => true, clientFactory: () => client });
  assert.match(await f.request(), /Exam Friday/);
  assert.equal(requests[0].model, f.config.summary.model);
  assert.deepEqual(requests[0].output_config, { effort: f.config.summary.effort });
  assert.match(requests[0].messages[0].content, /^Chat: Class\n\n/);
  f.advance(61000);
  client.messages.create = async () => ({ stop_reason: 'refusal', content: [] });
  await assert.rejects(f.request(), /declined/);
  const exports = require('../src/summarise');
  assert.equal(exports.summarise, undefined);
  assert.equal(exports.createClient, undefined);
});


test('daily AI budget blocks with no hourly, cooldown or interval conflict', async t => {
  const f = fixture(t);
  f.config.summary.maxPerDay = 4;
  f.safety.state.aiAttempts = Array.from({ length: 4 }, (_, i) => ({ time: 1800000000000 - 7200000 - i * 60000, chat: 'other' }));
  assert.match(await f.request(), /AI hourly/);
  assert.equal(f.calls, 0);
  assert.equal(f.reads, 0);
});

test('busy summaries block a second request after every time limit has expired', async t => {
  const f = fixture(t);
  let finish, entries = 0;
  f.rebuild({ provider: () => {
    assert.equal(++entries, 1, 'a busy chat must not reach the provider again');
    return new Promise(resolve => { finish = resolve; });
  } });
  const first = f.request();
  assert.equal(typeof finish, 'function');
  f.advance(7200000);
  assert.match(await f.request(), /already running/);
  assert.equal(f.reads, 1);
  finish('- Finished once');
  assert.match(await first, /Finished once/);
});

test('AI minimum interval blocks another chat without a cooldown or reply-budget conflict', async t => {
  const f = fixture(t);
  f.config.summary.cooldownSeconds = 0;
  f.safety.state.aiAttempts = [{ time: 1800000000000 - 1000, chat: 'other' }];
  assert.match(await f.request(), /AI hourly/);
  assert.equal(f.calls, 0);
  assert.equal(f.reads, 0);
});

test('clock rollback blocks below all caps and independently of minimum interval and chat cooldown', async t => {
  const f = fixture(t);
  f.safety.state.aiAttempts = [{ time: 1800000000000 + 5000, chat: 'other' }];
  assert.match(await f.request(), /AI hourly/);
  assert.equal(f.calls, 0);
  assert.equal(f.reads, 0);
});

test('receive off blocks a valid summary command before archive or provider access', async t => {
  const f = fixture(t);
  f.policies(new Map([[CHAT, { ...f.config.chats[0], receive: false }]]));
  assert.match(await f.request(), /not enabled for receiving/);
  assert.equal(f.calls, 0);
  assert.equal(f.reads, 0);
});

test('callers me blocks non-owner AI requests even with summary.ownerOnly off', async t => {
  const f = fixture(t, { callers: 'me' });
  f.config.summary.ownerOnly = false;
  assert.match(await f.request({ message: { fromMe: false, from: CHAT, type: 'chat', body: '!bot summary' } }), /Only the owner/);
  assert.equal(f.calls, 0);
  assert.equal(f.reads, 0);
});

test('the production SDK constructor disables automatic retries', async t => {
  const f = fixture(t);
  const id = require.resolve('@anthropic-ai/sdk');
  require(id);
  const original = require.cache[id].exports;
  let options;
  require.cache[id].exports = class FakeSDK {
    constructor(value) {
      options = value;
      this.messages = { create: async () => ({ content: [{ type: 'text', text: '- Done' }] }) };
    }
  };
  try {
    f.rebuild({ provider: null, isAvailable: () => true });
    assert.match(await f.request(), /Done/);
    assert.equal(options.maxRetries, 0);
  } finally { require.cache[id].exports = original; }
});

test('summary transcripts retain newest messages within both message and character caps', async t => {
  const f = fixture(t);
  delete f.config.summary.maxTranscriptChars;
  validateConfig(f.config);
  assert.equal(f.config.summary.maxTranscriptChars, 60000);
  f.config.summary.maxMessages = 10;
  f.config.summary.maxTranscriptChars = 60000;
  const records = Array.from({ length: 14 }, (_, i) => ({ text: 'Message-' + String(i).padStart(2, '0') + ' ' + 'x'.repeat(80), sender: 'alice@lid', ts: 1800000000 + i }));
  f.options.archive.read = () => records;
  assert.match(await f.request(), /10 messages/);
  const full = f.requests[0].transcript;
  assert.ok(!full.includes('Message-03'));
  assert.ok(full.includes('Message-04') && full.includes('Message-13'));
  f.advance(61000);
  f.config.summary.maxTranscriptChars = 300;
  assert.match(await f.request(), /2 messages/);
  const capped = f.requests[1].transcript;
  assert.ok(capped.length <= 300);
  assert.ok(!capped.includes('Message-11'));
  assert.ok(capped.includes('Message-12') && capped.includes('Message-13'));
  f.advance(61000);
  f.options.archive.read = () => [{ ...records[0], text: 'old prefix ' + 'x'.repeat(1000) + 'NEWEST TAIL' }];
  await f.request();
  assert.equal(f.requests[2].transcript.length, 300);
  assert.ok(f.requests[2].transcript.endsWith('NEWEST TAIL'));
});
