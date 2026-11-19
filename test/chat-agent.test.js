'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { loadConfig } = require('../src/config');
const { createCommands } = require('../src/commands');
const { createGitHub } = require('../src/github');
const { createRouter } = require('../src/router');
const { createSummaryService } = require('../src/summarise');
const { createAgentWriteGate, createReplyGate, emptyState } = require('../src/safety');
const { Instructions } = require('../src/instructions');
const { tempDirectory } = require('./helpers');

const CHAT = '12345@g.us';
const OTHER = '67890@g.us';
const REPO = 'example/project';
const BASE = '/repos/' + REPO;

function fixture(t, { policy: settings = {}, response = () => ({}), privateRepo = true, provider = 'api', beforeFetch, instructions } = {}) {
  const config = loadConfig();
  Object.assign(config.summary, { ownerOnly: false, minIntervalSeconds: 0, cooldownSeconds: 0, maxPerDay: 100, maxPerHour: 100, provider });
  config.github.cooldownSeconds = 0;
  Object.assign(config.replies, { minIntervalSeconds: 0, chatCooldownSeconds: 0 });
  const policy = { id: CHAT, receive: true, send: true, callers: 'anyone', buzzword: '!bot', ai: true, aiPerDay: 100,
    githubRepo: REPO, githubMembers: true, assistant: true, ...settings };
  const policies = new Map([[CHAT, policy], [OTHER, { ...policy, id: OTHER }]]);
  let serial = 0;
  const now = Date.now();
  const clock = () => now;
  const saved = [];
  const safety = { state: emptyState(), save: () => saved.push(structuredClone(safety.state)) };
  const replyGate = createReplyGate({ config: config.replies, state: safety.state, clock, save: safety.save });
  const reserveAgentWrite = createAgentWriteGate({ state: safety.state, save: safety.save, clock });
  const ai = [], modelRequests = [], requests = [], sent = [], logs = [];
  const issues = new Map([[21, { number: 21, title: 'Document API', state: 'open' }]]);
  const github = createGitHub({ getToken: () => 'fake-token', fetchFn: async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ pathname, method: init.method, body, query: searchParams.get('q') });
    await beforeFetch?.(pathname, policies);
    const ok = data => ({ ok: true, status: 200, json: async () => data });
    if (pathname === BASE) return ok({ full_name: REPO, private: privateRepo, has_issues: true });
    if (pathname === '/search/issues') return ok({ incomplete_results: false, total_count: 0, items: [] });
    if (pathname === BASE + '/issues' && init.method === 'GET') return ok([...issues.values()].filter(issue => issue.state === 'open'));
    if (pathname === BASE + '/issues' && init.method === 'POST') {
      const issue = { number: 22, title: body.title, state: 'open' };
      issues.set(issue.number, issue);
      return ok(issue);
    }
    if (pathname === BASE + '/issues/21/comments' && init.method === 'POST') return ok({ body: body.body });
    if (pathname === BASE + '/issues/21') {
      const issue = issues.get(21);
      if (init.method === 'PATCH') issue.state = body.state;
      return ok(issue);
    }
    throw new Error('Unexpected GitHub request ' + pathname);
  } });
  const shared = { getConfig: () => config, getPolicies: () => policies, clock };
  const summaryService = createSummaryService({ ...shared, safety, replyGate, instructions, log: line => logs.push(line),
    provider: async request => {
      modelRequests.push(request);
      const prompt = JSON.parse(request.transcript);
      ai.push(prompt);
      return JSON.stringify(await response(prompt));
    } });
  const route = createRouter({ ...shared, startedAt: now, archive: { append() {} }, replyGate,
    moderate: async message => ({ isSpam: message.body === 'What issues are open? spam' }),
    burstTiming: { quietMs: 6, maxMs: 24 }, log: line => logs.push(line), onError: line => logs.push(line),
    commands: createCommands({ ...shared, summaryService, github, reserveAgentWrite, log: line => logs.push(line) }) });
  t.after(() => route.close());
  function message(body, { fromMe = false, chatId = CHAT, quote, timestamp = Math.floor(now / 1000) } = {}) {
    const id = { _serialized: 'incoming-' + ++serial };
    return {
      id, body, timestamp, fromMe, from: fromMe ? 'owner@c.us' : chatId, to: fromMe ? chatId : 'owner@c.us', type: 'chat',
      hasQuotedMsg: Boolean(quote), getQuotedMessage: async () => quote,
      async reply(text, _chat, options) {
        const posted = { id: { _serialized: 'posted-' + ++serial }, fromMe: true, to: chatId };
        sent.push({ text, to: id._serialized, options, posted });
        return posted;
      }
    };
  }
  async function deliver(text, options) { const incoming = message(text, options); await route(incoming); return incoming; }
  async function open(chatId = CHAT) {
    await deliver('!bot ping', { fromMe: true, chatId });
    await route.idle();
    return sent.at(-1).posted;
  }
  async function settle() { await wait(38); await route.idle(); }
  const writes = () => requests.filter(request => request.method !== 'GET');
  return { config, policy, policies, route, safety, saved, ai, modelRequests, sent, requests, logs, issues, deliver, open, settle, writes };
}

for (const provider of ['api', 'claude-code']) {
  test(`automatic replies load only their chat's current owner rules (${provider})`, async t => {
    const instructions = new Instructions(path.join(tempDirectory(t), 'instructions'));
    instructions.write(CHAT, 'Use British English.');
    instructions.write(OTHER, 'Use French.');
    const f = fixture(t, { provider, instructions, response: () => ({ reply: 'The parser fix is ready.' }) });
    await f.open();
    await f.deliver('!bot What changed?', { fromMe: true });
    await f.settle();
    assert.equal(f.modelRequests.length, 1);
    assert.match(f.modelRequests[0].system, /Use British English\./);
    assert.doesNotMatch(f.modelRequests[0].system, /Use French\./);
    assert.match(f.modelRequests[0].system, /Keep the JSON schema, reply-null rule, canOpen eligibility/);
    assert.match(f.modelRequests[0].system, /Distinguish proposed work, tested work and live changes/);
    assert.equal(f.sent.length, 2);
    assert.deepEqual(f.writes(), []);
    instructions.write(CHAT, 'Use Spanish.');
    await f.deliver('!bot What is next?', { fromMe: true });
    await f.settle();
    assert.match(f.modelRequests[1].system, /Use Spanish\./);
    assert.doesNotMatch(f.modelRequests[1].system, /Use British English\.|Use French\./);
    instructions.clear(CHAT);
    await f.deliver('!bot What remains?', { fromMe: true });
    await f.settle();
    assert.doesNotMatch(f.modelRequests[2].system, /Use Spanish\.|The owner of this bot set/);
    assert.deepEqual(f.writes(), []);
  });
}

test('starts silent and preserves explicit commands and disabled-chat behavior', async t => {
  const f = fixture(t);
  await f.deliver('!bot what did we decide?', { fromMe: true });
  await f.deliver('What issues are open?');
  await f.deliver('!bot ping');
  await f.settle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.ai.length, 0);
  assert.equal(f.requests.length, 0);
  await f.open();
  f.policies.set(CHAT, { ...f.policy, assistant: false });
  await f.deliver('What issues are open?');
  await f.deliver('!bot xyz');
  await f.settle();
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].text, /Unknown command "xyz"/);
  assert.equal(f.requests.length, 0);
});

test('a burst answers one addressed message using only its own scrubbed text', async t => {
  const f = fixture(t, { response: () => ({ reply: 'Use the parser fix first.' }) });
  await f.open();
  await f.deliver('Earlier, the group chose the parser fix. See https://example.net/path?secret=abc');
  await f.deliver('!bot Which fix comes first?', { fromMe: true });
  const newest = await f.deliver('Which fix, @bot?', { fromMe: true });
  await f.settle();
  assert.equal(f.ai.length, 1);
  assert.equal(f.ai[0].answer, 3);
  assert.match(f.ai[0].messages[0].text, /the group chose the parser fix.*\[link\]/);
  assert.doesNotMatch(JSON.stringify(f.ai), /example\.net|secret=|owner@|12345/);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].to, newest.id._serialized);
  assert.equal(f.sent[1].options.ignoreQuoteErrors, false);
  assert.match(f.sent[1].text, /Use the parser fix first\.$/);
  const afterRestart = createReplyGate({ config: f.config.replies, state: f.saved.at(-1) });
  assert.equal(afterRestart.canReserve(CHAT, newest.id._serialized), false);
  assert.equal(afterRestart.canReserve(CHAT, 'another-message'), true);
  await f.deliver('Mail dev@bot.example or ask @botany.');
  await f.settle();
  assert.equal(f.ai.length, 1);
});

test('only a known, same-chat bot post qualifies as a quoted reply', async t => {
  const f = fixture(t, { response: () => ({ reply: 'The parser fix is next.' }) });
  const posted = await f.open();
  await f.open(OTHER);
  await f.deliver('Please clarify.', { quote: { ...posted, id: { _serialized: 'owner-message' } } });
  await f.deliver('Please clarify.', { chatId: OTHER, quote: posted });
  await f.deliver('Please clarify.', { quote: { ...posted, fromMe: false } });
  await f.settle();
  assert.equal(f.ai.length, 0);
  const request = await f.deliver('Can you clarify?', { quote: posted });
  await f.settle();
  assert.equal(f.ai.length, 1);
  assert.equal(f.sent.at(-1).to, request.id._serialized);
  f.route.revoke(posted);
  await f.deliver('Please clarify.', { quote: posted });
  await f.settle();
  assert.equal(f.ai.length, 1);
});

test('plain repo questions read only the allowed linked repository, without AI', async t => {
  const f = fixture(t);
  await f.open();
  await f.deliver('What’s the weather?');
  await f.deliver('What issues are open? spam');
  await f.deliver('What issues are open?', { chatId: '54321@g.us' });
  await f.deliver('What issues are open?', { timestamp: 1 });
  await f.settle();
  assert.equal(f.requests.length, 0);
  const question = await f.deliver('What issues are open?');
  await f.settle();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].pathname, BASE + '/issues');
  assert.match(f.sent.at(-1).text, /Latest open issues: #21 Document API/);
  assert.equal(f.sent.at(-1).to, question.id._serialized);
  assert.equal(f.ai.length, 0);
  f.policies.set(CHAT, { ...f.policy, githubMembers: false });
  await f.deliver('What issues are open?');
  await f.settle();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.writes(), []);
});

test('policy change or message removal cancels queued and in-flight work', async t => {
  let release;
  const modelResult = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { response: () => modelResult });
  await f.open();
  const removed = await f.deliver('!bot what did we decide?', { fromMe: true });
  f.route.revoke(removed);
  await f.settle();
  assert.equal(f.ai.length, 0);
  await f.deliver('!bot what did we decide?', { fromMe: true });
  await wait(25);
  assert.equal(f.ai.length, 1);
  f.policies.set(CHAT, { ...f.policy, send: false });
  release({ reply: 'Old policy' });
  await f.route.idle();
  assert.equal(f.sent.length, 1);
});

test('opted-in private repo creates one de-duplicated issue, with a single quoted update', async t => {
  const f = fixture(t, { policy: { githubAutoIssues: true }, response: ({ messages }) =>
    ({ issue: { source: messages.find(message => message.canOpen)?.source, title: 'Fix parser timeout' } }) });
  await f.open();
  await f.deliver('[Claude] I will fix everything.');
  await f.settle();
  assert.equal(f.ai.length, 0);
  const task = await f.deliver("I'll fix the parser timeout tomorrow.");
  await f.deliver("I'll verify it on Windows too.");
  await f.settle();
  assert.equal(f.ai.length, 1);
  assert.equal(f.writes().length, 1);
  assert.equal(f.writes()[0].body.title, 'Fix parser timeout');
  assert.doesNotMatch(f.writes()[0].body.body, /tomorrow|Windows/);
  assert.match(f.requests.find(request => request.query).query, /^repo:example\/project is:issue is:open in:title/);
  assert.match(f.sent.at(-1).text, /Opened #22 Fix parser timeout.*\nhttps:\/\/github.com\/example\/project\/issues\/22/);
  assert.equal(f.sent.at(-1).to, task.id._serialized);
  const afterRestart = createAgentWriteGate({ state: f.saved.at(-1), save: () => assert.fail('duplicate write') });
  assert.equal(afterRestart(REPO, CHAT, task.id._serialized, 'Fix parser timeout'), false);
  await f.route(task);
  await f.deliver("I'll fix the parser timeout too.");
  await f.settle();
  assert.equal(f.writes().length, 1);
  assert.equal(f.sent.length, 2);
});

test('only the owner can comment, close or reopen; comment-only updates stay quiet', async t => {
  const f = fixture(t, { policy: { githubAutoIssues: true } });
  await f.open();
  await f.deliver('Issue #21 done');
  await f.settle();
  assert.equal(f.writes().length, 0);
  await f.deliver('Issue #21 progress: Tested the parser https://example.com/private', { fromMe: true });
  await f.settle();
  assert.deepEqual(f.writes()[0].body, { body: 'Tested the parser [link]' });
  assert.equal(f.sent.length, 1);
  await f.deliver('Issue #21 done', { fromMe: true });
  await f.settle();
  assert.deepEqual(f.writes()[1].body, { state: 'closed', state_reason: 'completed' });
  assert.match(f.sent.at(-1).text, /Closed #21/);
  await f.deliver('Issue #21 reopen', { fromMe: true });
  await f.settle();
  assert.deepEqual(f.writes()[2].body, { state: 'open' });
  assert.match(f.sent.at(-1).text, /Reopened #21/);
  assert.equal(f.ai.length, 0);
});

test('public repos, revoked permissions and members on a Claude subscription cannot auto-write', async t => {
  const response = () => ({ issue: { source: 1, title: 'Fix parser' } });
  const publicRepo = fixture(t, { policy: { githubAutoIssues: true }, privateRepo: false, response });
  await publicRepo.open();
  await publicRepo.deliver("I'll fix the parser.");
  await publicRepo.settle();
  assert.equal(publicRepo.writes().length, 0);
  const revoked = fixture(t, { policy: { githubAutoIssues: true }, response,
    beforeFetch: (pathname, policies) => {
      if (pathname === '/search/issues') policies.set(CHAT, { ...policies.get(CHAT), githubAutoIssues: false });
    } });
  await revoked.open();
  await revoked.deliver("I'll fix the parser.");
  await revoked.settle();
  assert.equal(revoked.writes().length, 0);
  const subscription = fixture(t, { policy: { githubAutoIssues: true }, provider: 'claude-code', response });
  await subscription.open();
  await subscription.deliver("I'll fix the parser.");
  await subscription.settle();
  assert.equal(subscription.ai.length, 0);
  assert.equal(subscription.writes().length, 0);
});
