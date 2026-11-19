'use strict';

// GitHub changes from a chat: issues and comments, pull requests, files and commits, with the owner's confirm code for
// anything that removes, closes, merges or replaces. A fake GitHub answers by method and path; nothing reaches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadConfig, validateConfig } = require('../src/config');
const { buildPolicies, matchBuzzword } = require('../src/chats');
const { createCommands } = require('../src/commands');
const { createGitHub } = require('../src/github');
const { createPending } = require('../src/pending');
const { typedAfter, lineDiff } = require('../src/github-changes');
const { Items } = require('../src/items');
const { tempDirectory } = require('./helpers');

const A = '111@g.us';
const REPO = 'kaihuang1425/agentic-legacy';
const R = `/repos/${REPO}`;
const START = Date.UTC(2027, 6, 1, 12, 0);
const HEAD = 'a'.repeat(40), NEW = 'b'.repeat(40), PARENT = 'c'.repeat(40), BAD = 'd'.repeat(40), TREE = 'e'.repeat(40);
const reply = (status, body) => ({ ok: status < 300, status, headers: new Map(), json: async () => body });
const b64 = text => Buffer.from(text, 'utf8').toString('base64');

function fixture(t, { routes = {}, members = false, changes = 'pull', maxWritesPerHour = 30 } = {}) {
  const config = loadConfig();
  config.github.cooldownSeconds = 0;
  config.github.changes = changes;
  config.github.maxWritesPerHour = maxWritesPerHour;
  config.chats = [{ id: A, label: 'Hackathon', receive: true, send: true, buzzword: '!bot', githubRepo: REPO, githubMembers: members }];
  validateConfig(config);
  const policies = buildPolicies(config);
  let now = START;
  const clock = () => now;
  const requests = [];
  const all = {
    [`GET ${R}`]: reply(200, { full_name: REPO, default_branch: 'main' }),
    [`GET ${R}/git/ref/heads/main`]: reply(200, { object: { sha: HEAD } }),
    ...routes
  };
  const fetchFn = async (url, options) => {
    const { pathname } = new URL(url);
    requests.push({ method: options.method, path: pathname, url, json: options.body ? JSON.parse(options.body) : undefined, options });
    const route = all[`${options.method} ${pathname}`];
    if (typeof route === 'function') return route(url, options);
    return route || reply(404, {});
  };
  const github = createGitHub({ getToken: () => 'github_pat_test', fetchFn });
  let code = 4000;
  const pending = createPending({ clock, randomInt: () => code++ });
  const logs = [];
  const items = new Items(path.join(tempDirectory(t, 'spam-bot-gh-changes-'), 'items'));
  const commands = createCommands({ getConfig: () => config, items, github, pending, clock, log: line => logs.push(line) });
  const run = (text, { fromMe = true } = {}) => {
    const policy = policies.get(A);
    const body = `${policy.buzzword} ${text}`;
    return commands(policy, matchBuzzword(body, policy.buzzword), { fromMe, message: { fromMe, body, id: { _serialized: 'm' } } });
  };
  const writes = () => requests.filter(r => r.method !== 'GET');
  return { config, run, requests, writes, logs, advance: ms => { now += ms; } };
}

const issue = (fields = {}) => ({ number: 12, node_id: 'I_kwDOabc123', title: 'Fix the login page', body: 'It fails on Safari.\nSee https://evil.example/x',
  state: 'open', user: { login: 'alice' }, labels: [{ name: 'bug' }], comments: 2, updated_at: '2027-07-01T10:00:00Z',
  html_url: `https://github.com/${REPO}/issues/12`, ...fields });
const comments = [
  { id: 501, user: { login: 'bob' }, body: 'Same on Firefox', created_at: '2027-07-01T09:00:00Z', issue_url: `https://api.github.com${R}/issues/12` },
  { id: 502, user: { login: 'carol' }, body: 'Fixed in https://phish.example', created_at: '2027-07-01T09:30:00Z', issue_url: `https://api.github.com${R}/issues/12` }
];

test('reading: an issue with its latest comments, files and commits, with links taken out', async t => {
  const f = fixture(t, { members: true, routes: {
    [`GET ${R}/issues/12`]: reply(200, issue()),
    [`GET ${R}/issues/12/comments`]: reply(200, comments),
    [`GET ${R}/contents`]: reply(200, [{ name: 'src', type: 'dir' }, { name: 'README.md', type: 'file', size: 2100 }]),
    [`GET ${R}/contents/README.md`]: reply(200, { type: 'file', path: 'README.md', sha: 'f1', size: 40, content: b64('# Demo\nOpen https://demo.example\n') }),
    [`GET ${R}/commits`]: reply(200, [{ sha: HEAD, commit: { message: 'Add login\n\nlong text', author: { name: 'Alice', date: '2027-07-01T10:00:00Z' } }, author: { login: 'alice' } }]),
    [`GET ${R}/commits/${HEAD}`]: reply(200, { sha: HEAD, commit: { message: 'Add login', author: { date: '2027-07-01T10:00:00Z' } }, author: { login: 'alice' },
      parents: [{ sha: PARENT }], files: [{ filename: 'src/login.js', status: 'modified', additions: 3, deletions: 1, sha: 'x1' }], stats: { additions: 3, deletions: 1 } })
  } });
  assert.equal(await f.run('github #12'), '#12 Fix the login page (issue, open; by alice; labels: bug; 2 comments)\nIt fails on Safari.\nSee [link]\n' +
    'Latest comments:\n[comment 501] bob: Same on Firefox\n[comment 502] carol: Fixed in [link]\n' + `https://github.com/${REPO}/issues/12`);
  assert.match(await f.run('gh #12 comments', { fromMe: false }), /^Latest comments on #12:\n\[comment 501\] bob: Same on Firefox\n/);
  assert.equal(await f.run('github files'), `Top folder of ${REPO} on main (2):\nsrc/\nREADME.md (2 KB)`);
  assert.equal(await f.run('github file README.md', { fromMe: false }), `README.md (40 B) on main:\n# Demo\nOpen [link]\nhttps://github.com/${REPO}/blob/main/README.md`);
  assert.equal(await f.run('github commits'), `Latest commits in ${REPO}:\naaaaaaa Add login (alice, Thu 1 Jul 11:00)\nDetails: !bot github commit <id>`);
  assert.equal(await f.run(`github commit ${HEAD}`), 'aaaaaaa Add login\nBy alice, Thu 1 Jul 11:00. 1 file (+3 −1):\nmodified src/login.js (+3 −1)\n' +
    `https://github.com/${REPO}/commit/${HEAD}`);
  // Bad paths and ids never reach GitHub.
  const asked = f.requests.length;
  assert.equal(await f.run('github file ../secret'), '"../secret" is not a file path in the repository.');
  assert.match(await f.run('github commit zzz'), /^Usage: !bot github commit <id>/);
  assert.equal(f.requests.length, asked);
  assert.equal(f.writes().length, 0);
});

test('changes are the owner\'s: members who may read get a refusal, and nothing is sent', async t => {
  const f = fixture(t, { members: true });
  for (const text of ['github #12 comment hi', 'github #12 close', 'github #12 label bug', 'github #12 delete', 'github comment 501 delete',
    'github pr 3 merge', 'github file a.md write x', 'github file a.md delete', `github commit ${HEAD} revert`]) {
    assert.equal(await f.run(text, { fromMe: false }), 'Only the owner of this bot can change things on GitHub from the chat.', text);
  }
  assert.equal(await f.run('confirm 4000', { fromMe: false }), 'Only the owner of this bot can confirm changes.');
  assert.equal(await f.run('cancel', { fromMe: false }), 'Only the owner of this bot can cancel changes.');
  assert.equal(f.requests.length, 0);
  // Without githubMembers, members get nothing at all.
  const closed = fixture(t);
  assert.equal(await closed.run('github #12', { fromMe: false }), 'Only the owner of this bot can use GitHub from this chat.');
});

test('a comment and labels are added at once, with the text as typed (line breaks and full-width punctuation kept)', async t => {
  const f = fixture(t, { routes: {
    [`POST ${R}/issues/12/comments`]: reply(201, { id: 900, html_url: `https://github.com/${REPO}/issues/12#issuecomment-900` }),
    [`POST ${R}/issues/12/labels`]: reply(200, [{ name: 'bug' }, { name: 'help wanted' }])
  } });
  assert.equal(await f.run('github #12 comment 我們明天測試，好嗎？\nSecond line'), `Commented on #12.\nhttps://github.com/${REPO}/issues/12#issuecomment-900`);
  assert.deepEqual(f.writes()[0].json, { body: '我們明天測試，好嗎？\nSecond line' });
  assert.equal(await f.run('gh #12 label bug, help wanted'), '#12 now has the labels: bug, help wanted.');
  assert.deepEqual(f.writes()[1].json, { labels: ['bug', 'help wanted'] });
  assert.equal(await f.run('github #12 comment'), 'Usage: !bot github #12 comment <text>');
  assert.deepEqual(f.logs, ['[GITHUB] Hackathon: commented on #12', '[GITHUB] Hackathon: labelled #12']);
});

test('closing waits for the code: once, in the same chat, within two minutes, and cancel drops it', async t => {
  const f = fixture(t, { routes: {
    [`GET ${R}/issues/12`]: reply(200, issue()),
    [`PATCH ${R}/issues/12`]: reply(200, issue({ state: 'closed' }))
  } });
  assert.equal(await f.run('github #12 close not planned'), `Close issue #12 "Fix the login page" in ${REPO} as not planned?\n` +
    'To do it, send !bot confirm 4000 within 2 minutes (or !bot cancel 4000).');
  assert.equal(f.writes().length, 0);
  assert.equal(await f.run('confirm 9999'), 'Nothing is waiting with code 9999 in this chat (codes last 2 minutes and work once).');
  assert.equal(await f.run('confirm'), 'Waiting for your confirm code:\n4000: Close issue #12 "Fix the login page" in kaihuang1425/agentic-legacy as not planned?');
  assert.equal(await f.run('confirm 4000'), `Closed issue #12.\nhttps://github.com/${REPO}/issues/12`);
  assert.deepEqual(f.writes()[0].json, { state: 'closed', state_reason: 'not_planned' });
  assert.equal(await f.run('confirm 4000'), 'Nothing is waiting with code 4000 in this chat (codes last 2 minutes and work once).');
  // Expired after two minutes; cancelled at once.
  assert.match(await f.run('github #12 close'), /confirm 4001 /);
  f.advance(120000);
  assert.match(await f.run('confirm 4001'), /^Nothing is waiting with code 4001/);
  assert.match(await f.run('github #12 close'), /confirm 4002 /);
  assert.equal(await f.run('cancel 4002'), 'Cancelled that change.');
  assert.match(await f.run('confirm 4002'), /^Nothing is waiting/);
  assert.equal(await f.run('cancel'), 'Nothing was waiting.');
  assert.equal(f.writes().length, 1);
  // An issue already closed needs no code.
  const g = fixture(t, { routes: { [`GET ${R}/issues/12`]: reply(200, issue({ state: 'closed' })) } });
  assert.equal(await g.run('github #12 close'), '#12 is already closed.');
});

test('a title or description edit is refused at confirm time if the issue changed on GitHub in between', async t => {
  let updated = '2027-07-01T10:00:00Z';
  const f = fixture(t, { routes: {
    [`GET ${R}/issues/12`]: () => reply(200, issue({ updated_at: updated })),
    [`PATCH ${R}/issues/12`]: reply(200, issue())
  } });
  assert.equal(await f.run('github #12 title Login fails on Safari 17'), 'Change the title of issue #12\nfrom: Fix the login page\nto: Login fails on Safari 17\n' +
    'To do it, send !bot confirm 4000 within 2 minutes (or !bot cancel 4000).');
  assert.equal(await f.run('confirm 4000'), `Changed the title of #12.\nhttps://github.com/${REPO}/issues/12`);
  assert.deepEqual(f.writes()[0].json, { title: 'Login fails on Safari 17' });
  assert.match(await f.run('github #12 body Steps:\n1. Open Safari\n2. Log in'), /^Replace the description of issue #12 "Fix the login page"\nnow: It fails on Safari\.\nSee \[link\]\nnew: Steps:\n1\. Open Safari\n2\. Log in\n/);
  updated = '2027-07-01T11:00:00Z';
  // A refusal is a reply, never a thrown error the chat would not see.
  assert.equal(await f.run('confirm 4001').catch(error => `threw: ${error.message}`), 'GitHub: #12 changed on GitHub since you asked; ask again.');
  assert.equal(f.writes().length, 1);
});

test('deleting an issue goes through GraphQL and says plainly when GitHub refuses; pull requests cannot be deleted', async t => {
  let answer = { data: { deleteIssue: { clientMutationId: null } } };
  const f = fixture(t, { routes: {
    [`GET ${R}/issues/12`]: reply(200, issue()),
    [`GET ${R}/issues/13`]: reply(200, issue({ number: 13, pull_request: {} })),
    'POST /graphql': () => reply(200, answer)
  } });
  assert.match(await f.run('github #12 delete'), /^Delete issue #12 "Fix the login page" from kaihuang1425\/agentic-legacy for good, with all its comments\? This cannot be undone/);
  assert.equal(await f.run('confirm 4000'), 'Deleted issue #12.');
  assert.deepEqual(f.writes()[0].json.variables, { id: 'I_kwDOabc123' });
  assert.match(f.writes()[0].json.query, /deleteIssue\(input: \{ issueId: \$id \}\)/);
  answer = { errors: [{ message: 'must have admin rights' }] };
  await f.run('github #12 delete');
  assert.equal(await f.run('confirm 4001'), `GitHub: GitHub would not delete it (deleting an issue needs admin rights on ${REPO}; you can still close it).`);
  assert.equal(await f.run('github #13 delete'), 'Pull requests cannot be deleted. Close it with !bot github pr 13 close.');
});

test('comments are edited or deleted only after the code', async t => {
  const f = fixture(t, { routes: {
    [`GET ${R}/issues/comments/502`]: reply(200, comments[1]),
    [`PATCH ${R}/issues/comments/502`]: reply(200, comments[1]),
    [`DELETE ${R}/issues/comments/502`]: reply(204, null)
  } });
  assert.equal(await f.run('github comment 502 edit Fixed in the next build'), 'Change comment 502 by carol on #12\nnow: Fixed in [link]\nnew: Fixed in the next build\n' +
    'To do it, send !bot confirm 4000 within 2 minutes (or !bot cancel 4000).');
  assert.match(await f.run('confirm 4000'), /^Changed comment 502 on #12\./);
  assert.deepEqual(f.writes()[0].json, { body: 'Fixed in the next build' });
  assert.match(await f.run('github comment 502 delete'), /^Delete comment 502 by carol on #12: "Fixed in \[link\]"\? This cannot be undone\.\n/);
  assert.equal(await f.run('confirm 4001'), 'Deleted comment 502 on #12.');
  assert.equal(f.writes()[1].method, 'DELETE');
  assert.match(await f.run('github comment 502 frob'), /^Usage: !bot github comment ID edit <text>/);
});

test('merging shows what GitHub says and merges only the commit the owner saw; drafts and conflicts are refused', async t => {
  const pull = fields => reply(200, { number: 30, title: 'Add login form', user: { login: 'alice' }, state: 'open', merged: false, draft: false,
    mergeable_state: 'clean', head: { ref: 'feature', sha: NEW }, base: { ref: 'main' }, additions: 120, deletions: 8, changed_files: 5,
    html_url: `https://github.com/${REPO}/pull/30`, ...fields });
  let state = {};
  const f = fixture(t, { routes: {
    [`GET ${R}/pulls/30`]: () => pull(state),
    [`PUT ${R}/pulls/30/merge`]: reply(200, { merged: true, sha: HEAD })
  } });
  assert.equal(await f.run('github pr 30 merge squash'), 'Merge pull request #30 "Add login form" (feature → main, at commit bbbbbbb; 5 files, +120 −8) as a squash merge? ' +
    'GitHub says: can be merged. It merges only if nothing was pushed to it since now.\nTo do it, send !bot confirm 4000 within 2 minutes (or !bot cancel 4000).');
  assert.equal(await f.run('confirm 4000'), `Merged pull request #30 into main (squash).\nhttps://github.com/${REPO}/pull/30`);
  assert.deepEqual(f.writes()[0].json, { sha: NEW, merge_method: 'squash' });
  assert.match(await f.run('github pr 30 merge fast'), /^Usage: !bot github pr 30 merge \[merge\|squash\|rebase\]/);
  state = { draft: true };
  assert.equal(await f.run('github pr 30 merge'), 'Pull request #30 is a draft; mark it ready for review on GitHub first.');
  state = { mergeable_state: 'dirty' };
  assert.equal(await f.run('github pr 30 merge'), 'Pull request #30 has merge conflicts; resolve them on GitHub first.');
  state = { merged: true, state: 'closed' };
  assert.equal(await f.run('github pr 30 merge'), 'Pull request #30 is already merged.');
  state = {};
  assert.match(await f.run('github pr 30 close'), /^Close pull request #30 "Add login form" \(feature → main\) without merging\?\n/);
  assert.equal(f.writes().length, 1);
});

test('a file change is a commit on a new branch with a pull request, after the code; the old version guards it', async t => {
  const old = '# Demo\nRun npm start\n';
  const f = fixture(t, { routes: {
    [`GET ${R}/contents/README.md`]: reply(200, { type: 'file', path: 'README.md', sha: 'blob1', size: old.length, content: b64(old) }),
    [`POST ${R}/git/refs`]: reply(201, {}),
    [`PUT ${R}/contents/README.md`]: reply(200, { commit: { sha: NEW }, content: { html_url: `https://github.com/${REPO}/blob/x/README.md` } }),
    [`POST ${R}/pulls`]: reply(201, { number: 31, html_url: `https://github.com/${REPO}/pull/31` })
  } });
  assert.equal(await f.run('github file README.md write\n# Demo\nRun npm run dev\nThen open the app'),
    `Change README.md (21 B → 41 B; +2 −1 lines) in ${REPO}, on a new branch, with a pull request into main?\n` +
    '- Run npm start\n+ Run npm run dev\n+ Then open the app\nTo do it, send !bot confirm 4000 within 2 minutes (or !bot cancel 4000).');
  assert.equal(f.writes().length, 0);
  assert.equal(await f.run('confirm 4000'), 'Update README.md: pull request #31 (whatsapp/20270701-120000-readme-md-update → main) is ready for review.\n' +
    `https://github.com/${REPO}/pull/31`);
  const [branch, put, pull] = f.writes();
  assert.deepEqual(branch.json, { ref: 'refs/heads/whatsapp/20270701-120000-readme-md-update', sha: HEAD });
  assert.deepEqual(put.json, { message: 'Update README.md (from WhatsApp)', content: b64('# Demo\nRun npm run dev\nThen open the app\n'),
    branch: 'whatsapp/20270701-120000-readme-md-update', sha: 'blob1' });
  assert.deepEqual(pull.json, { title: 'Update README.md', head: 'whatsapp/20270701-120000-readme-md-update', base: 'main', body: 'Made from WhatsApp with the chat bot.' });
  assert.deepEqual(f.logs, ['[GITHUB] Hackathon: changed README.md']);
  // The same content again needs nothing.
  assert.equal(await f.run(`github file README.md write\n${old}`), 'README.md already has exactly that content.');
});

test('with changes "direct", a new file and a deletion are commits on the default branch', async t => {
  const f = fixture(t, { changes: 'direct', routes: {
    [`GET ${R}/contents/docs/plan.md`]: reply(404, {}),
    [`PUT ${R}/contents/docs/plan.md`]: reply(201, { commit: { sha: NEW }, content: { html_url: `https://github.com/${REPO}/blob/main/docs/plan.md` } }),
    [`GET ${R}/contents/old.txt`]: reply(200, { type: 'file', path: 'old.txt', sha: 'blob9', size: 3, content: b64('hi\n') }),
    [`DELETE ${R}/contents/old.txt`]: reply(200, { commit: { sha: NEW } })
  } });
  assert.match(await f.run('github file docs/plan.md write Day 1: build the demo'), new RegExp(`^Add docs/plan\\.md \\(22 B\\) in ${REPO}, straight onto main\\?\\n`));
  assert.equal(await f.run('confirm 4000'), `Add docs/plan.md on main.\nhttps://github.com/${REPO}/blob/main/docs/plan.md`);
  assert.deepEqual(f.writes()[0].json, { message: 'Add docs/plan.md (from WhatsApp)', content: b64('Day 1: build the demo\n'), branch: 'main' });
  assert.match(await f.run('github file old.txt delete'), new RegExp(`^Delete old\\.txt \\(3 B\\) from ${REPO}, straight onto main\\?\\n`));
  assert.equal(await f.run('confirm 4001'), 'Delete old.txt on main.');
  assert.deepEqual(f.writes()[1].json, { message: 'Delete old.txt (from WhatsApp)', sha: 'blob9', branch: 'main' });
  assert.equal(await f.run('github file missing.txt delete'), `There is no file missing.txt in ${REPO} on main.`);
  assert.equal(f.writes().length, 2);
});

test('a revert restores the files as they were before the commit, only if nothing changed them since', async t => {
  const commit = { sha: NEW, commit: { message: 'Add login\n\nmore' }, author: { login: 'alice' }, parents: [{ sha: PARENT }],
    files: [{ filename: 'src/login.js', status: 'modified', sha: 'blobNew', additions: 3, deletions: 1 },
      { filename: 'src/extra.js', status: 'added', sha: 'blobAdded', additions: 9, deletions: 0 }] };
  let loginNow = 'blobNew';
  const f = fixture(t, { routes: {
    [`GET ${R}/commits/${NEW}`]: reply(200, commit),
    [`GET ${R}/commits/${BAD}`]: reply(200, { ...commit, sha: BAD, parents: [{ sha: PARENT }, { sha: HEAD }] }),
    [`GET ${R}/contents/src/login.js`]: () => reply(200, { type: 'file', sha: loginNow }),
    [`GET ${R}/contents/src/extra.js`]: reply(200, { type: 'file', sha: 'blobAdded' }),
    [`GET ${R}/git/commits/${HEAD}`]: reply(200, { tree: { sha: HEAD } }),
    [`GET ${R}/git/commits/${PARENT}`]: reply(200, { tree: { sha: TREE } }),
    [`GET ${R}/compare/${NEW}...${HEAD}`]: reply(200, { status: 'ahead' }),
    [`GET ${R}/compare/${PARENT}...${HEAD}`]: reply(200, { status: 'diverged' }),
    [`GET ${R}/commits/${PARENT}`]: reply(200, { ...commit, sha: PARENT, commit: { message: 'Fix install script' }, author: { login: 'stranger' } }),
    [`GET ${R}/git/trees/${TREE}`]: reply(200, { truncated: false, tree: [{ path: 'src/login.js', type: 'blob', mode: '100755', sha: 'blobOld' }] }),
    [`POST ${R}/git/trees`]: reply(201, { sha: TREE }),
    [`POST ${R}/git/commits`]: reply(201, { sha: 'f'.repeat(40) }),
    [`POST ${R}/git/refs`]: reply(201, {}),
    [`POST ${R}/pulls`]: reply(201, { number: 32, html_url: `https://github.com/${REPO}/pull/32` })
  } });
  assert.equal(await f.run(`github commit ${NEW} revert`), `Revert bbbbbbb "Add login" by alice (2 files: src/login.js, src/extra.js) with a new commit in ${REPO}, ` +
    'on a new branch, with a pull request into main?\nTo do it, send !bot confirm 4000 within 2 minutes (or !bot cancel 4000).');
  assert.equal(f.writes().length, 0);
  assert.match(await f.run('confirm 4000'), /^Reverted bbbbbbb: pull request #32 \(whatsapp\/20270701-120000-revert-bbbbbbb → main\) is ready for review\./);
  const [tree, created, branch] = f.writes();
  assert.deepEqual(tree.json, { base_tree: HEAD, tree: [{ path: 'src/login.js', mode: '100755', type: 'blob', sha: 'blobOld' },
    { path: 'src/extra.js', mode: '100644', type: 'blob', sha: null }] });
  assert.deepEqual(created.json, { message: `Revert "Add login"\n\nThis reverts commit ${NEW}.`, tree: TREE, parents: [HEAD] });
  assert.deepEqual(branch.json, { ref: 'refs/heads/whatsapp/20270701-120000-revert-bbbbbbb', sha: 'f'.repeat(40) });
  // Refused: a merge commit, and a file someone changed again after the commit.
  assert.equal(await f.run(`github commit ${BAD} revert`), 'GitHub: ddddddd is a merge commit (or the first one); revert it on GitHub or locally.');
  // A commit that is not in the branch's history (a fork's, another branch's) is refused: its parent was never there.
  assert.equal(await f.run(`github commit ${PARENT} revert`), 'GitHub: ccccccc is not in the history of main; only its own commits can be reverted from the chat.');
  loginNow = 'blobLater';
  assert.equal(await f.run(`github commit ${NEW} revert`), 'GitHub: src/login.js changed again after bbbbbbb; revert it on GitHub or locally.');
  assert.equal(f.writes().length, 4);
});

test('at most github.maxWritesPerHour changes an hour from all chats', async t => {
  const f = fixture(t, { maxWritesPerHour: 2, routes: { [`POST ${R}/issues/12/comments`]: reply(201, { id: 1, html_url: '' }) } });
  assert.equal(await f.run('github #12 comment one'), 'Commented on #12.');
  assert.equal(await f.run('github #12 comment two'), 'Commented on #12.');
  assert.equal(await f.run('github #12 comment three'), 'GitHub: at most 2 changes an hour can be made from chats; try again later.');
  f.advance(3600001);
  assert.equal(await f.run('github #12 comment four'), 'Commented on #12.');
  assert.equal(f.writes().length, 3);
});

test('the typed text after a keyword, and the line counts in a preview', () => {
  const message = body => ({ body });
  assert.equal(typedAfter(message('!bot gh #1 comment a，b\nc'), 'gh #1 comment a,b\nc', 'comment'), 'a，b\nc');
  assert.equal(typedAfter(message('!bot gh file write.md write\nx'), 'gh file write.md write\nx', 'write'), 'x');
  // A message whose typed text says something else (not the same command) falls back to the router's copy.
  assert.equal(typedAfter(message('something else'), 'gh #1 comment hi', 'comment'), 'hi');
  assert.equal(typedAfter(null, 'gh #1 comment', 'comment'), '');
  // The diff lists every changed line in order; a moved line shows as removed and added.
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nc\nd'), [['-', 'b'], ['+', 'd']]);
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nc\nb'), [['-', 'b'], ['+', 'b']]);
  assert.deepEqual(lineDiff('', 'x\n'), [['+', 'x']]);
  assert.equal(lineDiff('a\n'.repeat(3000), 'b\n'.repeat(3000), 1000), null);
});

test('a confirm sent while the chat is busy keeps its code; an edited comment is not overwritten', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let updated = 'u1';
  const f = fixture(t, { routes: {
    [`GET ${R}/issues/12`]: reply(200, issue()),
    [`GET ${R}/issues/12/comments`]: async () => { await held; return reply(200, comments); },
    [`PATCH ${R}/issues/12`]: reply(200, issue({ state: 'closed' })),
    [`GET ${R}/issues/comments/502`]: () => reply(200, { ...comments[1], updated_at: updated }),
    [`PATCH ${R}/issues/comments/502`]: reply(200, comments[1])
  } });
  assert.match(await f.run('github #12 close'), /confirm 4000 /);
  const reading = f.run('github #12 comments');
  assert.equal(await f.run('confirm 4000'), 'A GitHub request for this chat is still running; try again in a moment. Code 4000 still works until it runs out.');
  release();
  await reading;
  assert.match(await f.run('confirm 4000'), /^Closed issue #12\./);
  assert.match(await f.run('github comment 502 edit New text'), /confirm 4001 /);
  updated = 'u2';
  assert.equal(await f.run('confirm 4001'), 'GitHub: comment 502 changed on GitHub since you asked; ask again.');
  assert.equal(f.writes().filter(r => r.path.endsWith('/comments/502')).length, 0);
  // A member's typed folder name is not echoed back as a link.
  const g = fixture(t, { members: true });
  assert.equal(await g.run('github files https://evil.example/login', { fromMe: false }), '"[link]" is not a folder path in the repository.');
});
