'use strict';

// GitHub from a chat: issues opened in the chat's linked repository, open issues and pull requests listed, one pull
// request shown. A fake fetch stands in for GitHub; nothing here reaches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadConfig, validateConfig } = require('../src/config');
const { buildPolicies, matchBuzzword, permissionText } = require('../src/chats');
const { createCommands } = require('../src/commands');
const { Items } = require('../src/items');
const { createGitHub, validRepo, oneLine, tokenFrom, GitHubError } = require('../src/github');
const { tempDirectory } = require('./helpers');

const A = '111@g.us', B = '222@g.us';
const REPO = 'kaihuang1425/agentic-legacy';
const TOKEN = 'github_pat_test_never_shown';
const START = Date.UTC(2027, 6, 1, 12, 0);
const cp = code => String.fromCodePoint(code);

// A fake GitHub: answers by method and path, records every request.
function fakeGitHub(routes = {}) {
  const requests = [];
  const fetchFn = async (url, options) => {
    requests.push({ url, ...options, json: options.body ? JSON.parse(options.body) : undefined });
    const key = `${options.method} ${new URL(url).pathname}`;
    const route = routes[key];
    if (typeof route === 'function') return route(url, options);
    if (!route) return { ok: false, status: 404, headers: new Map(), json: async () => ({}) };
    return { ok: (route.status || 200) < 300, status: route.status || 200, headers: new Map(Object.entries(route.headers || {})),
      json: async () => route.body };
  };
  return { requests, fetchFn };
}

test('repository names, safe one-line text, and the token from .env', t => {
  for (const good of [REPO, 'a/b', 'my-org/repo.name_2', 'x/.github']) assert.equal(validRepo(good), true, good);
  for (const bad of ['', 'a', 'a/b/c', '-a/b', 'a/..', 'a/.', 'a b/c', 'a/b c', `${'o'.repeat(40)}/r`, '../x', 'a/b?x=1', null]) {
    assert.equal(validRepo(bad), false, String(bad));
  }
  assert.equal(oneLine(`Fix${cp(0x202e)} login\n\nnow${cp(0x07)}  please`), 'Fix login now please');
  assert.equal(oneLine('x'.repeat(150)), `${'x'.repeat(99)}…`);
  assert.equal(oneLine(undefined), '');
  const directory = tempDirectory(t, 'spam-bot-github-');
  const env = path.join(directory, '.env');
  assert.equal(tokenFrom(env, {}), '');
  assert.equal(tokenFrom(env, { GITHUB_TOKEN: ' from-env ' }), 'from-env');
  fs.writeFileSync(env, 'ANTHROPIC_API_KEY=x\nGITHUB_TOKEN=from-file\n');
  assert.equal(tokenFrom(env, { GITHUB_TOKEN: 'from-env' }), 'from-file');
  fs.writeFileSync(env, 'GITHUB_TOKEN=\n');
  assert.equal(tokenFrom(env, { GITHUB_TOKEN: 'from-env' }), 'from-env');
});

test('the client sends the token only in its header, never redirects, and maps GitHub\'s errors to plain words', async () => {
  const fake = fakeGitHub({ [`POST /repos/${REPO}/issues`]: { status: 201, body: { number: 7, html_url: `https://github.com/${REPO}/issues/7` } } });
  const github = createGitHub({ getToken: () => TOKEN, fetchFn: fake.fetchFn, timeoutMs: 5000 });
  assert.deepEqual(await github.openIssue(REPO, { title: 'Fix login', body: 'Opened from WhatsApp.' }),
    { number: 7, url: `https://github.com/${REPO}/issues/7` });
  const [sent] = fake.requests;
  assert.equal(sent.url, `https://api.github.com/repos/${REPO}/issues`);
  assert.equal(sent.method, 'POST');
  assert.deepEqual(sent.headers, { Accept: 'application/vnd.github+json', Authorization: `Bearer ${TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'whatsapp-spam-bot', 'Content-Type': 'application/json' });
  assert.deepEqual(sent.json, { title: 'Fix login', body: 'Opened from WhatsApp.' });
  assert.equal(sent.redirect, 'error');
  assert.ok(sent.signal instanceof AbortSignal);
  // No token, or not a repository name: nothing is sent.
  const quiet = fakeGitHub();
  await assert.rejects(createGitHub({ getToken: () => ' ', fetchFn: quiet.fetchFn }).listPulls(REPO), /no GITHUB_TOKEN in \.env/);
  await assert.rejects(createGitHub({ getToken: () => TOKEN, fetchFn: quiet.fetchFn }).listPulls('a/b/c'), /not a repository name like OWNER\/REPO/);
  assert.equal(quiet.requests.length, 0);
  const failing = (status, headers = {}) => createGitHub({ getToken: () => TOKEN, fetchFn: async () => ({ ok: false, status,
    headers: new Map(Object.entries(headers)), json: async () => ({ message: `secret ${TOKEN}` }) }) });
  const cases = [
    [401, {}, /GitHub rejected the token: check GITHUB_TOKEN in \.env/],
    [403, { 'x-ratelimit-remaining': '0' }, /rate limit is reached/],
    [403, {}, /the token may not do that in kaihuang1425\/agentic-legacy\. It needs Contents, Issues and Pull requests: read and write \(and Workflows for files in \.github\/workflows\)\./],
    [404, {}, /was not found, or the token cannot see it/],
    [410, {}, /issues are turned off/],
    [422, {}, /refused it as invalid/],
    [429, {}, /rate limit is reached/],
    [502, {}, /GitHub answered with error 502\./]
  ];
  for (const [status, headers, message] of cases) {
    const error = await failing(status, headers).listIssues(REPO).catch(e => e);
    assert.ok(error instanceof GitHubError, String(status));
    assert.match(error.message, message);
    assert.doesNotMatch(error.message, /github_pat|secret/);
  }
  const network = createGitHub({ getToken: () => TOKEN, fetchFn: async () => { throw new TypeError(`fetch failed ${TOKEN}`); } });
  await assert.rejects(network.listIssues(REPO), error => error instanceof GitHubError && error.message === 'could not reach GitHub (network).');
  const slow = createGitHub({ getToken: () => TOKEN, fetchFn: async () => { const e = new Error('slow'); e.name = 'TimeoutError'; throw e; } });
  await assert.rejects(slow.listIssues(REPO), /GitHub did not answer in time\./);
  const garbled = createGitHub({ getToken: () => TOKEN, fetchFn: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }) });
  await assert.rejects(garbled.listIssues(REPO), /could not be read/);
});

function fixture(t, { members = false, repo = REPO, routes = {}, withGitHub = true, maxIssuesPerHour = 10, cooldownSeconds = 0, token = TOKEN } = {}) {
  const config = loadConfig();
  config.github.maxIssuesPerHour = maxIssuesPerHour;
  config.github.cooldownSeconds = cooldownSeconds;
  config.chats = [
    { id: A, label: 'Hackathon', receive: true, send: true, buzzword: '!bot', githubRepo: repo, githubMembers: members },
    { id: B, label: 'Family', receive: true, send: true, buzzword: '!bot' }
  ];
  validateConfig(config);
  const policies = buildPolicies(config);
  const directory = tempDirectory(t, 'spam-bot-github-');
  const items = new Items(path.join(directory, 'items'));
  let now = START;
  const clock = () => now;
  const fake = fakeGitHub(routes);
  const github = withGitHub ? createGitHub({ getToken: () => token, fetchFn: fake.fetchFn }) : null;
  const commands = createCommands({ getConfig: () => config, items, github, clock });
  const run = (text, { fromMe = true, chat = A } = {}) => {
    const policy = policies.get(chat);
    const body = `${policy.buzzword} ${text}`;
    return commands(policy, matchBuzzword(body, policy.buzzword), {
      fromMe, message: fromMe ? { fromMe: true, to: chat, type: 'chat', body, id: { _serialized: 'm' } }
        : { fromMe: false, from: chat, author: 'alice@lid', type: 'chat', body, id: { _serialized: 'x' } } });
  };
  return { config, items, run, requests: fake.requests, advance: ms => { now += ms; } };
}

const created = number => ({ status: 201, body: { number, html_url: `https://github.com/${REPO}/issues/${number}` } });

test('the owner opens an issue from the chat; a member cannot unless the owner allowed it', async t => {
  const f = fixture(t, { routes: { [`POST /repos/${REPO}/issues`]: created(5) } });
  assert.equal(await f.run('github issue Fix  the login page'), `Opened GitHub issue #5 in ${REPO}: Fix the login page\nhttps://github.com/${REPO}/issues/5`);
  assert.deepEqual(f.requests[0].json, { title: 'Fix the login page', body: 'Opened from WhatsApp with the chat bot.' });
  // Members: refused, and nothing reaches GitHub.
  for (const text of ['github issue Spam', 'gh prs', 'github pr 1', 'github issues', 'github']) {
    assert.equal(await f.run(text, { fromMe: false }), 'Only the owner of this bot can use GitHub from this chat.');
  }
  assert.equal(f.requests.length, 1);
  // Bad input.
  assert.match(await f.run('github issue'), /^Usage: !bot github issue <title>/);
  assert.equal(await f.run(`github issue ${'x'.repeat(201)}`), 'An issue title needs 1-200 characters.');
  assert.equal(f.requests.length, 1);
});

test('an item from the chat\'s list becomes an issue once, with its deadline, and the list shows the number', async t => {
  let number = 11;
  const f = fixture(t, { routes: { [`POST /repos/${REPO}/issues`]: () => ({ ok: true, status: 201, headers: new Map(),
    json: async () => ({ number: number++, html_url: `https://github.com/${REPO}/issues/${number - 1}` }) }) } });
  f.items.add(A, { text: 'Submit the demo video', due: Date.UTC(2027, 6, 3, 16, 0), remindAt: Date.UTC(2027, 6, 2, 16, 0), status: 'open',
    by: 'member', now: START, settings: f.config.reminders });
  const [item] = f.items.active(A).open;
  assert.equal(await f.run(`github issue ${item.n}`), `Opened GitHub issue #11 in ${REPO} for item ${item.n}: Submit the demo video\nhttps://github.com/${REPO}/issues/11`);
  assert.equal(f.requests[0].json.title, 'Submit the demo video');
  assert.equal(f.requests[0].json.body, 'Opened from WhatsApp with the chat bot.\n\nDue: Sat 3 Jul 17:00 (London time).\n\nThe chat gets a reminder Fri 2 Jul 17:00.');
  assert.equal(f.items.active(A).open[0].githubIssue, 11);
  assert.equal(await f.run(`github issue ${item.n}`), `Item ${item.n} is already GitHub issue #11.`);
  assert.equal(await f.run('github issue 99'), 'There is no open or spotted item 99. !bot issues lists them.');
  assert.equal(f.requests.length, 1);
  // The chat's own list shows it.
  const commands = createCommands({ getConfig: () => f.config, items: f.items, clock: () => START });
  const list = await commands(buildPolicies(f.config).get(A), 'issues', { fromMe: true });
  assert.match(list, /1\. Submit the demo video \(due Sat 3 Jul 17:00, reminder Fri 2 Jul 17:00, GitHub #11\)/);
});

// A request the AI spotted in the chat, not kept yet (as the detect run stores it).
function spotted(f, text, due = null) {
  return f.items.add(A, { text, status: 'suggested', by: 'ai', due, now: START, settings: f.config.reminders }).item;
}

test('a spotted request becomes an issue in one step: kept with its usual reminder, then opened, and only once', async t => {
  const f = fixture(t, { routes: { [`POST /repos/${REPO}/issues`]: created(12) } });
  const item = spotted(f, 'Send the slides', Date.UTC(2027, 6, 3, 16, 0));
  assert.equal(await f.run(`github issue ${item.n}`), `Kept ${item.n} and opened GitHub issue #12 in ${REPO}: Send the slides\n` +
    `Reminder Fri 2 Jul 17:00 (London time).\nhttps://github.com/${REPO}/issues/12`);
  assert.equal(f.requests[0].json.title, 'Send the slides');
  assert.equal(f.requests[0].json.body, 'Opened from WhatsApp with the chat bot.\n\nSpotted in the chat\'s messages by the AI.\n\n' +
    'Due: Sat 3 Jul 17:00 (London time).\n\nThe chat gets a reminder Fri 2 Jul 17:00.');
  // Kept as "keep N" keeps it: open, the reminder a day before the deadline, answered from the command's message.
  const { open, suggested } = f.items.active(A);
  assert.equal(suggested.length, 0);
  assert.equal(open[0].n, item.n);
  assert.equal(open[0].githubIssue, 12);
  assert.equal(open[0].remindAt, Date.UTC(2027, 6, 2, 16, 0));
  assert.equal(open[0].source, 'm');
  assert.equal(await f.run(`github issue ${item.n}`), `Item ${item.n} is already GitHub issue #12.`);
  assert.equal(f.requests.length, 1);
  // Without a deadline: no reminder, and the reply says how to set one.
  const plain = spotted(f, 'Book the room');
  assert.match(await f.run(`github issue ${plain.n}`), new RegExp(`^Kept ${plain.n} and opened GitHub issue #12 in ${REPO}: Book the room\\n` +
    `No reminder; set one with !bot keep ${plain.n} <when>\\.\\n`));
  assert.equal(f.items.active(A).open.find(x => x.n === plain.n).remindAt, null);
});

test('a spotted request is not kept without a token, and two messages at once keep and open it only once', async t => {
  const none = fixture(t, { token: '' });
  const waiting = spotted(none, 'Send the slides');
  assert.equal(await none.run(`github issue ${waiting.n}`),
    'GitHub: there is no GITHUB_TOKEN in .env yet (see "GitHub" in COMMANDS.md). The request stays a suggestion.');
  assert.equal(none.items.active(A).suggested.length, 1);
  assert.equal(none.requests.length, 0);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { routes: { [`POST /repos/${REPO}/issues`]: async () => { await held; return { ok: true, status: 201, headers: new Map(), json: async () => created(7).body }; } } });
  const item = spotted(f, 'Record the demo');
  const first = f.run(`github issue ${item.n}`);
  // Raced against a second of real time: without the guard, the second call would wait for GitHub too.
  const second = await Promise.race([f.run(`github issue ${item.n}`),
    new Promise(resolve => setTimeout(() => resolve('the second call waited for GitHub'), 1000))]);
  assert.equal(second, 'A GitHub request for this chat is still running; try again in a moment.');
  release();
  assert.match(await first, new RegExp(`^Kept ${item.n} and opened GitHub issue #7 in ${REPO}: Record the demo\\n`));
  assert.equal(f.requests.length, 1);
  assert.equal(f.items.active(A).open.length, 1);
  assert.equal(f.items.active(A).open[0].githubIssue, 7);
});

test('a spotted request stays a suggestion when the request cannot go ahead, and is reported as kept when GitHub fails', async t => {
  let calls = 0;
  const f = fixture(t, { maxIssuesPerHour: 2, cooldownSeconds: 10, members: true, routes: {
    [`POST /repos/${REPO}/issues`]: () => (++calls === 1 ? { ok: false, status: 403, headers: new Map(), json: async () => ({}) }
      : { ok: true, status: 201, headers: new Map(), json: async () => ({ number: 30 + calls, html_url: '' }) }) } });
  const item = spotted(f, 'Fix the demo video', Date.UTC(2027, 6, 3, 16, 0));
  const stillSpotted = () => f.items.active(A).suggested.some(x => x.n === item.n);
  // GitHub refuses after the keep: the reply says it is kept, with its reminder, and how to retry.
  assert.equal(await f.run(`github issue ${item.n}`), `Kept ${item.n}: Fix the demo video. The issue was not opened. ` +
    `GitHub: the token may not do that in ${REPO}. It needs Contents, Issues and Pull requests: read and write (and Workflows for files in .github/workflows).\n` +
    `Reminder Fri 2 Jul 17:00 (London time).\nTry again with !bot github issue ${item.n}.`);
  assert.equal(stillSpotted(), false);
  assert.equal(f.items.active(A).open[0].githubIssue, undefined);
  // The retry opens it as an open item. The failed try counted too, so the hour's two issues are used.
  assert.match(await f.run(`github issue ${item.n}`), new RegExp(`^Opened GitHub issue #32 in ${REPO} for item ${item.n}: Fix the demo video$`));
  // The hourly limit, a member's cooldown and a list that is full leave a new suggestion as it was, and ask nothing of GitHub.
  const next = spotted(f, 'Print the posters');
  const asked = f.requests.length;
  assert.equal(await f.run(`github issue ${next.n}`), 'GitHub: at most 2 issues an hour can be opened from chats; try again later.');
  assert.equal(await f.run(`github issue ${next.n}`, { fromMe: false }), 'Please wait 10s between GitHub commands in this chat.');
  f.advance(3600000);
  f.config.reminders.maxOpenPerChat = 1;
  assert.equal(await f.run(`github issue ${next.n}`), 'This chat already has 1 open items. Close some with "done N" or "drop N" first.');
  assert.equal(f.requests.length, asked);
  assert.equal(f.items.active(A).suggested.map(x => x.n).join(), String(next.n));
  // A suggestion whose deadline has passed is gone, not kept.
  f.config.reminders.maxOpenPerChat = 50;
  const late = spotted(f, 'Send the forms', START + 3600000);
  f.advance(10000);
  assert.equal(await f.run(`github issue ${late.n}`), `There is no open or suggested item ${late.n}.`);
  assert.equal(f.requests.length, asked);
});

test('the spotted list and the spot reply point at "github issue N" only for someone who may use it', async t => {
  const f = fixture(t);
  spotted(f, 'Send the slides');
  const hint = '!bot keep N [when], !bot github issue N or !bot drop N:';
  assert.ok((await f.run('issues')).includes(hint));
  assert.ok(!(await f.run('issues', { fromMe: false })).includes('github issue'));
  const members = fixture(t, { members: true });
  spotted(members, 'Send the slides');
  assert.ok((await members.run('issues', { fromMe: false })).includes(hint));
  const without = createCommands({ getConfig: () => f.config, items: f.items, clock: () => START });
  assert.ok(!(await without(buildPolicies(f.config).get(A), 'issues', { fromMe: true })).includes('github issue'));
  // The owner's "spot": the same hint after what was found.
  const summaryService = async () => '';
  summaryService.detect = async () => ({ done: true, text: 'Looked at 3 new messages: 1 suggestion added.',
    added: [{ n: 2, text: 'Book the room', due: null }] });
  const spot = github => createCommands({ getConfig: () => f.config, items: f.items, summaryService, clock: () => START,
    github: github ? createGitHub({ getToken: () => TOKEN, fetchFn: async () => { throw new Error('not called'); } }) : null });
  const policy = buildPolicies(f.config).get(A);
  assert.equal(await (spot(true))(policy, 'spot', { fromMe: true }), 'Looked at 3 new messages: 1 suggestion added.\n2. Book the room\n' +
    'Keep one with !bot keep N [when], open it as a GitHub issue with !bot github issue N, or remove it with !bot drop N.');
  assert.ok(!(await (spot(false))(policy, 'spot', { fromMe: true })).includes('github issue'));
});

test('with githubMembers on, members can read and open issues, but not with links; at most N issues an hour', async t => {
  let number = 1;
  const f = fixture(t, { members: true, maxIssuesPerHour: 2, routes: {
    [`POST /repos/${REPO}/issues`]: () => ({ ok: true, status: 201, headers: new Map(), json: async () => ({ number: number++, html_url: '' }) }),
    [`GET /repos/${REPO}/pulls`]: { body: [] } } });
  assert.equal(await f.run('gh prs', { fromMe: false }), `No open pull requests in ${REPO}.`);
  assert.equal(await f.run('github issue See bit.ly/x', { fromMe: false }), 'Only the owner can put a link in an issue title.');
  assert.equal(await f.run('github issue Logo is too big', { fromMe: false }), `Opened GitHub issue #1 in ${REPO}: Logo is too big`);
  assert.match(await f.run('github issue See https://example.org/spec'), /^Opened GitHub issue #2/);
  assert.equal(await f.run('github issue Third one'), 'GitHub: at most 2 issues an hour can be opened from chats; try again later.');
  f.advance(3600 * 1000 + 1);
  assert.match(await f.run('github issue Third one'), /^Opened GitHub issue #3/);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 3);
});

test('open issues and pull requests are listed, and one pull request is described, never merged', async t => {
  const pulls = Array.from({ length: 12 }, (_, i) => ({ number: 30 - i, title: i === 0 ? `Add${cp(0x202e)} login\nform` : `Change ${i}`,
    user: { login: i % 2 ? 'bob' : 'alice' }, draft: i === 1, head: { ref: `feature-${i}` }, base: { ref: 'main' } }));
  const f = fixture(t, { routes: {
    [`GET /repos/${REPO}/issues`]: { body: [
      { number: 3, title: 'Login fails', user: { login: 'carol' }, comments: 2 },
      { number: 4, title: 'A pull request', user: { login: 'bob' }, comments: 0, pull_request: {} },
      { number: 2, title: 'Typo', user: { login: 'dan' }, comments: 0 }] },
    [`GET /repos/${REPO}/pulls`]: { body: pulls },
    [`GET /repos/${REPO}/pulls/30`]: { body: { number: 30, title: 'Add login form', user: { login: 'alice' }, state: 'open', merged: false,
      draft: false, mergeable_state: 'blocked', head: { ref: 'feature-0' }, base: { ref: 'main' }, additions: 120, deletions: 8,
      changed_files: 5, comments: 1, review_comments: 2, html_url: `https://github.com/${REPO}/pull/30` } },
    [`GET /repos/${REPO}/pulls/29`]: { body: { number: 29, title: 'Done', user: { login: 'bob' }, state: 'closed', merged: true,
      head: { ref: 'x' }, base: { ref: 'main' }, html_url: 'http://evil.example/pull/29' } } } });
  assert.equal(await f.run('github issues'), `Open issues in ${REPO} (2):\n#3 Login fails (carol, 2 comments)\n#2 Typo (dan)`);
  const list = await f.run('gh prs');
  assert.match(list, new RegExp(`^Open pull requests in ${REPO} \\(12\\):\\n#30 Add login form \\(alice; feature-0 → main\\)\\n#29 Change 1 \\(bob, draft; feature-1 → main\\)`));
  assert.match(list, /\n\.\.\.and 2 more on GitHub\nDetails: !bot github pr N$/);
  assert.equal(list.split('\n').filter(line => line.startsWith('#')).length, 10);
  assert.equal(await f.run('github pr #30'), '#30 Add login form\nBy alice: feature-0 → main. State: open, blocked: a required review or check is missing.\n' +
    `5 files changed (+120 −8), 3 comments.\nReview and merge on GitHub: https://github.com/${REPO}/pull/30`);
  // A link that is not GitHub's is not posted.
  assert.equal(await f.run('github pr 29'), '#29 Done\nBy bob: x → main. State: merged.\n0 files changed (+0 −0), 0 comments.');
  assert.equal(await f.run('github merge 30'), 'To merge pull request N: !bot github pr N merge (you get a code to confirm).');
  for (const text of ['github pr', 'github pr abc', 'github pr 1 2', 'github prs now', 'github', 'github close 3']) {
    assert.match(await f.run(text), /^GitHub for this chat: kaihuang1425\/agentic-legacy\n/, text);
  }
  assert.equal(f.requests.every(r => r.method === 'GET'), true);
  // A GitHub failure is a reply, not a crash.
  assert.equal(await f.run('github pr 404'), `GitHub: ${REPO} was not found, or the token cannot see it (add it under the token's Repository access).`);
});

test('a chat without a repository, a bot without GitHub, and the help lines', async t => {
  const f = fixture(t);
  assert.equal(await f.run('github prs', { chat: B }), 'This chat is not linked to a GitHub repository. The owner links it on the server: node src/cli.js github "Family" --repo OWNER/REPO');
  assert.match(await f.run('help'), /!bot github issue <title> \| issues \| prs \| pr N \| #N \| files \| file <path> \| commits - this chat's GitHub repository, kaihuang1425\/agentic-legacy \(also !bot gh; !bot github alone lists everything, changes too\)/);
  assert.match(await f.run('help'), /!bot confirm <code> \/ !bot cancel \[code\] - go ahead with, or drop, a change that waits for you \(owner only\)/);
  assert.doesNotMatch(await f.run('help', { fromMe: false }), /github/);
  assert.doesNotMatch(await f.run('help', { chat: B }), /github/);
  const m = fixture(t, { members: true });
  assert.match(await m.run('help', { fromMe: false }), /!bot github issue <title>/);
  const g = fixture(t, { withGitHub: false });
  assert.equal(await g.run('github prs'), 'GitHub is not available here.');
  assert.doesNotMatch(await g.run('help'), /github/);
});

test('the GitHub settings are checked, and shown with the chat\'s permissions', () => {
  const config = loadConfig();
  const withChat = chat => ({ ...structuredClone(config), chats: [{ id: A, receive: true, send: true, buzzword: '!bot', ...chat }] });
  assert.throws(() => validateConfig(withChat({ githubRepo: 'not a repo' })), /githubRepo must be "" or OWNER\/REPO/);
  assert.throws(() => validateConfig(withChat({ githubRepo: REPO, githubMembers: 'yes' })), /githubMembers must be true or false/);
  assert.throws(() => validateConfig({ ...structuredClone(config), github: { maxIssuesPerHour: 0, timeoutSeconds: 15 } }), /github\.maxIssuesPerHour/);
  assert.throws(() => validateConfig({ ...structuredClone(config), github: { maxIssuesPerHour: 10, timeoutSeconds: 2 } }), /github\.timeoutSeconds/);
  const valid = validateConfig(withChat({ githubRepo: REPO, githubMembers: true }));
  assert.match(permissionText(buildPolicies(valid).get(A)), /GitHub kaihuang1425\/agentic-legacy \(members too\)$/);
  const old = structuredClone(config);
  delete old.github;
  assert.deepEqual(validateConfig(old).github, { maxIssuesPerHour: 10, timeoutSeconds: 15, cooldownSeconds: 10, maxWritesPerHour: 30, changes: 'pull' });
  assert.throws(() => validateConfig({ ...structuredClone(config), github: { ...config.github, changes: 'force' } }), /github.changes/);
  assert.throws(() => validateConfig({ ...structuredClone(config), github: { ...config.github, maxWritesPerHour: 0 } }), /github.maxWritesPerHour/);
  assert.throws(() => validateConfig({ ...structuredClone(config), github: { maxIssuesPerHour: 10, timeoutSeconds: 15, cooldownSeconds: -1 } }), /github\.cooldownSeconds/);
});

test('the console links and unlinks a chat, keeps its other settings, and checks the token without one', t => {
  const directory = tempDirectory(t, 'spam-bot-github-cli-');
  fs.cpSync(path.join(__dirname, '..', 'src'), path.join(directory, 'src'), { recursive: true });
  const config = loadConfig();
  config.chats = [{ id: A, label: 'Hackathon', receive: true, send: true, buzzword: '!bot', spam: 'flag', ai: true, aiPerDay: 10, hub: 'hackathon' }];
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config, null, 2));
  const env = { ...process.env, GITHUB_TOKEN: '' };
  delete env.SPAM_BOT_CONFIG;
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [path.join(directory, 'src', 'cli.js'), 'github', ...args], { encoding: 'utf8', env });
    return { out: result.stdout.trim(), err: result.stderr.trim(), status: result.status };
  };
  const saved = () => JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')).chats[0];
  assert.deepEqual(cli('Hackathon'), { out: 'Hackathon is not linked to GitHub. Link it with: npm run github -- "Hackathon" --repo OWNER/REPO', err: '', status: 0 });
  const linked = cli('Hackathon', '--repo', REPO);
  assert.equal(linked.out, `Hackathon is linked to ${REPO}. Only you can use it from the chat.\n` +
    'Not checked: there is no GITHUB_TOKEN in .env yet (see "GitHub" in COMMANDS.md).');
  assert.equal(linked.status, 1);
  assert.equal(saved().githubRepo, REPO);
  assert.equal(saved().githubMembers, false);
  assert.equal(saved().hub, 'hackathon');
  assert.equal(saved().aiPerDay, 10);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory, 'config.json')).mode & 0o777, 0o600);
  assert.match(cli('Hackathon', '--repo', REPO, '--members').out, /Members can use it too\./);
  assert.equal(saved().githubMembers, true);
  assert.match(cli('Hackathon').out, new RegExp(`^Hackathon is linked to ${REPO}\\. Members can use it too\\.\\nNot checked: there is no GITHUB_TOKEN`));
  assert.match(cli('Hackathon', '--repo', 'bad repo').err, /--repo needs OWNER\/REPO/);
  assert.match(cli('Hackathon', '--repo').err, /--repo needs OWNER\/REPO/);
  assert.match(cli('Hackathon', '--members').err, /--members goes with --repo/);
  assert.match(cli('Hackathon', '--repo', REPO, '--off').err, /Use --repo or --off, not both/);
  assert.match(cli().err, /Name a chat: npm run github/);
  assert.equal(cli('Hackathon', '--off').out, 'Hackathon is no longer linked to GitHub.');
  assert.equal(saved().githubRepo, '');
  assert.equal(saved().githubMembers, false);
  assert.equal(saved().hub, 'hackathon');
});

test('links and long numbers written on GitHub are not posted into the chat', async t => {
  const f = fixture(t, { routes: {
    [`GET /repos/${REPO}/issues`]: { body: [{ number: 9, title: 'URGENT verify your account at https://phish.example/login', user: { login: 'stranger' }, comments: 0 },
      { number: 8, title: 'Call +44 7700 900123 or see wa.me/447700900123', user: { login: 'x' }, comments: 0 }] },
    [`GET /repos/${REPO}/pulls`]: { body: [{ number: 3, title: 'Docs at bit.ly/x', user: { login: 'bob' }, head: { ref: 'feature/x.com' }, base: { ref: 'main' } }] },
    [`GET /repos/${REPO}/pulls/3`]: { body: { number: 3, title: 'Docs at bit.ly/x', user: { login: 'bob' }, state: 'open', head: { ref: 'feature/x.com' },
      base: { ref: 'main' }, mergeable_state: 'clean', html_url: `https://github.com/${REPO}/pull/3` } } } });
  const issues = await f.run('github issues');
  assert.match(issues, /#9 URGENT verify your account at \[link\] \(stranger\)/);
  assert.match(issues, /#8 Call \[number\] or see \[link\] \(x\)/);
  assert.doesNotMatch(issues, /phish|wa\.me|7700/);
  assert.equal(await f.run('github prs'), `Open pull requests in ${REPO} (1):\n#3 Docs at [link] (bob; feature/[link] → main)\nDetails: !bot github pr N`);
  // GitHub's own link to the pull request is still posted.
  assert.match(await f.run('github pr 3'), new RegExp(`^#3 Docs at \\[link\\]\\nBy bob: feature/\\[link\\] → main\\. State: open, can be merged\\.\\n.*\\nReview and merge on GitHub: https://github\\.com/${REPO}/pull/3$`));
});

test('one GitHub request per chat at a time, a cooldown between them, and an item never becomes two issues', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let number = 40;
  const f = fixture(t, { cooldownSeconds: 10, members: true, routes: {
    [`POST /repos/${REPO}/issues`]: async () => { await held; return { ok: true, status: 201, headers: new Map(), json: async () => ({ number: number++, html_url: '' }) }; },
    [`GET /repos/${REPO}/pulls`]: { body: [] } } });
  f.items.add(A, { text: 'Record the demo', status: 'open', by: 'owner', now: START, settings: f.config.reminders });
  const [item] = f.items.active(A).open;
  // Two messages at once: the second waits for nothing and opens nothing.
  const first = f.run(`github issue ${item.n}`);
  // Raced against a second of real time: without the guard, the second call would wait for GitHub too.
  const second = await Promise.race([f.run(`github issue ${item.n}`),
    new Promise(resolve => setTimeout(() => resolve('the second call waited for GitHub'), 1000))]);
  assert.equal(second, 'A GitHub request for this chat is still running; try again in a moment.');
  release();
  assert.match(await first, /^Opened GitHub issue #40 .* for item 1: Record the demo$/);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
  // Then a cooldown for members; a usage reply does not start one.
  assert.equal(await f.run('github prs', { fromMe: false }), 'Please wait 10s between GitHub commands in this chat.');
  f.advance(4000);
  assert.equal(await f.run('github prs', { fromMe: false }), 'Please wait 6s between GitHub commands in this chat.');
  assert.match(await f.run('github pr x', { fromMe: false }), /^GitHub for this chat:/);
  f.advance(6000);
  assert.equal(await f.run('github prs', { fromMe: false }), `No open pull requests in ${REPO}.`);
  // The owner is never kept waiting by a member's request.
  assert.equal(await f.run('github prs'), `No open pull requests in ${REPO}.`);
  assert.equal(await f.run('github prs', { fromMe: false }), 'Please wait 10s between GitHub commands in this chat.');
  // Later, the same item is refused: it already has its issue.
  f.advance(10000);
  assert.equal(await f.run(`github issue ${item.n}`), `Item ${item.n} is already GitHub issue #40.`);
});
