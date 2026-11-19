'use strict';

// AI drafts: the owner asks the AI to draft a change to a linked Google file, a GitHub issue or a repository file. The
// real summary service runs with a stand-in AI; the change always waits for the confirm code, and links the AI added
// that were not already in the target are taken out. Nothing reaches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadConfig, validateConfig } = require('../src/config');
const { buildPolicies, matchBuzzword } = require('../src/chats');
const { SafetyStore, createReplyGate } = require('../src/safety');
const { createSummaryService, DRAFT_SYSTEM } = require('../src/summarise');
const { createCommands } = require('../src/commands');
const { createPending } = require('../src/pending');
const { Archive } = require('../src/archive');
const { createGitHub } = require('../src/github');
const { parseDraft, checkDraft } = require('../src/drafts');
const { tempDirectory } = require('./helpers');

const A = '111@g.us';
const REPO = 'kaihuang1425/agentic-legacy';
const R = `/repos/${REPO}`;
const DOC = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', SHEET = '1SheetIdSheetIdSheetIdSheetIdSheetId00';
const START = Date.UTC(2027, 6, 1, 12, 0);
const reply = (status, body) => ({ ok: status < 300, status, headers: new Map(), json: async () => body });
const b64 = text => Buffer.from(text, 'utf8').toString('base64');

function fixture(t, { answer = '{}' } = {}) {
  const config = loadConfig();
  config.github.cooldownSeconds = 0;
  config.summary.maxPerHour = 20;
  config.summary.maxPerDay = 50;
  config.chats = [{ id: A, label: 'Team', receive: true, send: true, buzzword: '!bot', ai: true, aiPerDay: 20, githubRepo: REPO,
    googleFiles: [{ name: 'plan', id: DOC, kind: 'doc' }, { name: 'budget', id: SHEET, kind: 'sheet' }] }];
  validateConfig(config);
  const policies = buildPolicies(config);
  const directory = tempDirectory(t, 'spam-bot-drafts-');
  const archive = new Archive(path.join(directory, 'archive'));
  const safety = new SafetyStore(path.join(directory, 'runtime'));
  let now = START, code = 6000;
  const clock = () => now;
  const ai = { answer, requests: [] };
  const service = createSummaryService({ getConfig: () => config, getPolicies: () => policies, archive, safety,
    getSecret: () => Buffer.alloc(32), clock, replyGate: createReplyGate({ config: config.replies, state: safety.state, clock }),
    // ai.during: something that happens while the AI drafts (someone edits the target).
    log: () => {}, provider: async request => { ai.requests.push(request); if (ai.during) ai.during(); return ai.answer; } });
  const googleCalls = [];
  const state = { revision: 'r1' };
  const google = {
    async readDoc(id) { googleCalls.push(['readDoc', id]); return { title: 'Plan', revisionId: state.revision, text: 'Goal: demo\nDocs: https://team.example/wiki' }; },
    async appendDoc(id, text) { googleCalls.push(['appendDoc', id, text]); return {}; },
    async replaceInDoc(id, find, replace, options) { googleCalls.push(['replaceInDoc', id, find, replace, options]); return { changed: 1 }; },
    async readRange(id, range) { googleCalls.push(['readRange', id, range]); return { range, values: [['Item', 'Cost']] }; },
    async writeRange(id, range, values) { googleCalls.push(['writeRange', id, range, values]); return {}; }
  };
  const ghRequests = [];
  const routes = {
    [`GET ${R}`]: reply(200, { full_name: REPO, default_branch: 'main' }),
    [`GET ${R}/git/ref/heads/main`]: reply(200, { object: { sha: 'a'.repeat(40) } }),
    [`GET ${R}/issues/12`]: reply(200, { number: 12, node_id: 'I_1', title: 'Fix login', body: 'Fails on Safari', state: 'open',
      user: { login: 'alice' }, labels: [], comments: 0, updated_at: 'x', html_url: `https://github.com/${REPO}/issues/12` }),
    [`POST ${R}/issues/12/comments`]: reply(201, { id: 9, html_url: '' }),
    [`GET ${R}/contents/README.md`]: reply(200, { type: 'file', path: 'README.md', sha: 'b1', size: 9, content: b64('# Demo\nhi\n') })
  };
  const github = createGitHub({ getToken: () => 'token', fetchFn: async (url, options) => {
    const { pathname } = new URL(url);
    ghRequests.push({ method: options.method, path: pathname, json: options.body ? JSON.parse(options.body) : undefined });
    return routes[`${options.method} ${pathname}`] || reply(404, {});
  } });
  const commands = createCommands({ getConfig: () => config, github, google, summaryService: service, clock,
    pending: createPending({ clock, randomInt: () => code++ }), log: () => {} });
  const run = (text, { fromMe = true } = {}) => {
    const policy = policies.get(A);
    const body = `${policy.buzzword} ${text}`;
    return commands(policy, matchBuzzword(body, policy.buzzword), {
      fromMe, message: fromMe ? { fromMe: true, to: A, type: 'chat', body, id: { _serialized: 'm' } }
        : { fromMe: false, from: A, author: 'alice@lid', type: 'chat', body, id: { _serialized: 'x' } } });
  };
  archive.write(A, { chat: A, fromMe: false, sender: 'alice@lid', kind: 'chat', id: 'm1', ts: Math.floor(START / 1000) - 60,
    text: 'Judging is at 5pm, see https://phish.example/judges' });
  // The AI keeps a minimum gap between requests in a chat (summary.cooldownSeconds): each draft comes a minute later.
  const draft = async text => { now += 61000; return run(text); };
  return { config, run, draft, ai, state, routes, googleCalls, ghRequests, set answer(value) { ai.answer = value; } };
}

test('the AI\'s draft is read as one JSON object and checked against what the target allows', () => {
  assert.deepEqual(parseDraft('Here it is:\n{"action": "append", "text": "x"}\nDone.'), { draft: { action: 'append', text: 'x' } });
  assert.match(parseDraft('no json').error, /no JSON object/);
  assert.match(parseDraft('{"action": 1}').error, /no action/);
  assert.match(parseDraft('{oops}').error, /not valid JSON/);
  assert.equal(checkDraft('doc', { action: 'append', text: 'x' }), null);
  assert.equal(checkDraft('doc', { action: 'none' }), null);
  assert.match(checkDraft('doc', { action: 'delete' }), /not one of the changes allowed here/);
  assert.match(checkDraft('doc', { action: 'append', text: '' }), /missing something or is too long/);
  assert.equal(checkDraft('sheet', { action: 'set', start: 'B2', rows: [['a', 'b']] }), null);
  assert.match(checkDraft('sheet', { action: 'set', start: 'B2:C3', rows: [['a']] }), /missing something/);
  assert.match(checkDraft('sheet', { action: 'add_row', cells: [1] }), /missing something/);
  assert.match(checkDraft('issue', { action: 'title', text: 'two\nlines' }), /missing something/);
  assert.match(checkDraft('issue', { action: 'write', content: 'x' }), /not one of the changes allowed/);
  assert.equal(checkDraft('file', { action: 'write', content: 'x' }), null);
  assert.match(checkDraft('file', { action: 'write', content: 'x'.repeat(200001) }), /too long/);
});

test('a drafted doc addition waits for the code; the AI saw the doc and the messages as data; new links are taken out', async t => {
  const f = fixture(t, { answer: '{"action": "append", "text": "Judging: 5pm. Wiki: https://team.example/wiki Map: https://phish.example/map"}' });
  assert.equal(await f.run('draft doc plan add when judging is'), 'Drafted by the AI. Add this at the end of plan?\n' +
    'Judging: 5pm. Wiki: [link] Map: [link]\nTo do it, send !bot confirm 6000 within 2 minutes (or !bot cancel 6000).');
  const [request] = f.ai.requests;
  assert.equal(request.mode, 'draft');
  assert.ok(request.system.startsWith(DRAFT_SYSTEM));
  assert.equal(request.question, 'add when judging is');
  assert.equal(request.target, 'the Google Doc "Plan"');
  assert.equal(request.content, 'Goal: demo\nDocs: https://team.example/wiki');
  assert.match(request.actions, /"action": "append"/);
  assert.match(request.transcript, /Judging is at 5pm/);
  assert.equal(request.workdir, null);
  assert.equal(f.googleCalls.filter(([name]) => name === 'appendDoc').length, 0);
  assert.match(await f.run('confirm 6000'), /^Added \d+ characters at the end of plan\./);
  assert.deepEqual(f.googleCalls.at(-1), ['appendDoc', DOC, 'Judging: 5pm. Wiki: https://team.example/wiki Map: [link]']);
});

test('drafts for a sheet, a GitHub comment and a repository file all wait for the code', async t => {
  const f = fixture(t, { answer: '{"action": "set", "start": "A2", "rows": [["Pizza", "40"]]}' });
  assert.equal(await f.draft('draft sheet budget put the pizza cost in'), 'Drafted by the AI. Write 1 row × 2 cells in budget, A2:B2?\n' +
    'now:\n2: Item | Cost\nnew:\n2: Pizza | 40\nTo do it, send !bot confirm 6000 within 2 minutes (or !bot cancel 6000).');
  assert.equal(f.ai.requests[0].content, 'row 1: Item | Cost');
  assert.equal(await f.run('confirm 6000'), `Wrote A2:B2 in budget.\nhttps://docs.google.com/spreadsheets/d/${SHEET}/edit`);
  assert.deepEqual(f.googleCalls.at(-1), ['writeRange', SHEET, 'A2:B2', [['Pizza', '40']]]);
  f.answer = '{"action": "comment", "text": "Seen on Safari 17 too."}';
  assert.equal(await f.draft('draft github #12 summarise the chat for this issue'), 'Drafted by the AI. Comment on #12?\nSeen on Safari 17 too.\n' +
    'To do it, send !bot confirm 6001 within 2 minutes (or !bot cancel 6001).');
  assert.equal(f.ghRequests.filter(r => r.method === 'POST').length, 0);
  assert.equal(await f.run('confirm 6001'), 'Commented on #12.');
  assert.deepEqual(f.ghRequests.at(-1).json, { body: 'Seen on Safari 17 too.' });
  f.answer = '{"action": "write", "content": "# Demo\\nhi\\nJudging at 5pm\\n"}';
  assert.match(await f.draft('draft gh file README.md add the judging time'), new RegExp(`^Drafted by the AI\\. Change README\\.md \\(9 B → 25 B; \\+1 −0 lines\\) in ${REPO}, on a new branch, with a pull request into main\\?\\n\\+ Judging at 5pm\\nTo do it`));
  assert.equal(f.ai.requests.at(-1).target, `the file README.md in ${REPO} (on main)`);
  assert.equal(f.ai.requests.at(-1).content, '# Demo\nhi\n');
});

test('only the owner drafts; the AI\'s refusal, broken JSON and a wrong action are said plainly, and nothing changes', async t => {
  const f = fixture(t);
  assert.equal(await f.run('draft doc plan anything', { fromMe: false }), 'Only the owner of this bot can ask the AI for a draft.');
  assert.match(await f.run('draft doc plan'), /^Usage: !bot draft doc\|sheet\|slides <name>/);
  assert.match(await f.run('draft doc nope do it'), /^No Google Doc called "nope" is linked here\./);
  assert.match(await f.run('draft gh file ../x do it'), /^Usage: !bot draft/);
  f.answer = '{"action": "none", "reason": "The chat says nothing about it."}';
  assert.equal(await f.draft('draft doc plan add the budget'), 'The AI did not draft a change: The chat says nothing about it.');
  f.answer = 'I would add a section.';
  assert.equal(await f.draft('draft doc plan add the budget'), 'No draft: the AI did not answer with a draft (no JSON object).');
  f.answer = '{"action": "delete_everything"}';
  assert.equal(await f.draft('draft doc plan add the budget'), 'No draft: the AI proposed "delete_everything", which is not one of the changes allowed here.');
  assert.equal(f.googleCalls.filter(([name]) => !name.startsWith('read')).length, 0);
  assert.equal(f.ai.requests.length, 3);
});

test('the summary service runs a draft only for the owner\'s draft command, and only with its target', async t => {
  const f = fixture(t);
  const config = f.config;
  const { createSummaryService: make } = require('../src/summarise');
  const directory = tempDirectory(t, 'spam-bot-drafts-gate-');
  const safety = new SafetyStore(path.join(directory, 'runtime'));
  const policies = buildPolicies(config);
  const service = make({ getConfig: () => config, getPolicies: () => policies, archive: new Archive(path.join(directory, 'archive')), safety,
    getSecret: () => Buffer.alloc(32), clock: () => START, replyGate: createReplyGate({ config: config.replies, state: safety.state, clock: () => START }),
    log: () => {}, provider: async () => '{"action": "none", "reason": "x"}' });
  const body = '!bot draft doc plan add it';
  const owner = { fromMe: true, to: A, type: 'chat', body, id: { _serialized: 'm' } };
  assert.equal(await service({ chatId: A, source: 'chat', message: owner }), 'Draft not run: a draft needs its target read first.');
  assert.deepEqual(await service({ chatId: A, source: 'chat', message: owner, draft: { request: 'add it', target: 'doc', content: '', actions: '' } }),
    { draft: '{"action": "none", "reason": "x"}', messages: 0, effort: config.summary.effort });
  const member = { fromMe: false, from: A, author: 'bob@lid', type: 'chat', body, id: { _serialized: 'x' } };
  assert.match(await service({ chatId: A, source: 'chat', message: member, draft: { request: 'add it', target: 'doc', content: '', actions: '' } }),
    /^Draft not run: /);
});

test('a draft must fit in full in its preview, a drafted file always goes on a new branch, and a target edited meanwhile is refused', async t => {
  const f = fixture(t);
  f.config.github.changes = 'direct';
  // Too long to show in full: refused, nothing waits.
  f.answer = JSON.stringify({ action: 'append', text: 'x'.repeat(1600) });
  assert.equal(await f.draft('draft doc plan write a lot'), 'The AI\'s draft is too long to show here in full; ask for a shorter one.');
  f.answer = JSON.stringify({ action: 'comment', text: 'line\n'.repeat(40) });
  assert.match(await f.draft('draft github #12 a long comment'), /^The AI's draft is too long to show here in full/);
  f.answer = JSON.stringify({ action: 'write', content: Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') });
  assert.match(await f.draft('draft gh file README.md rewrite it'), /^The AI's draft changes too much of README\.md to show here line by line \(\d+ changed lines\)/);
  // With changes "direct", a drafted file still goes on a new branch with a pull request.
  f.answer = JSON.stringify({ action: 'write', content: '# Demo\nhi\nmore\n' });
  assert.match(await f.draft('draft gh file README.md add a line'), /on a new branch, with a pull request into main\?\n\+ more\n/);
  // Someone edits the target while the AI drafts: refused.
  f.ai.during = () => { f.routes[`GET ${R}/contents/README.md`] = reply(200, { type: 'file', path: 'README.md', sha: 'b2', size: 9, content: b64('# Demo\nhi\n') }); };
  assert.equal(await f.draft('draft gh file README.md add a line'), 'README.md changed on GitHub while the AI was drafting; ask again.');
  f.answer = JSON.stringify({ action: 'replace', find: 'Goal', replace: 'Aim' });
  f.ai.during = () => { f.state.revision = 'r2'; };
  assert.equal(await f.draft('draft doc plan say aim'), 'plan changed while the AI was drafting; ask again.');
  f.ai.during = null;
  assert.match(await f.draft('draft doc plan say aim'), /^Drafted by the AI\. Replace "Goal" with "Aim" everywhere in plan\?/);
  assert.equal(f.googleCalls.filter(([name]) => !name.startsWith('read')).length, 0);
  assert.equal(f.ghRequests.filter(r => r.method !== 'GET').length, 0);
});
