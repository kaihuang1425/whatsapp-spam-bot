'use strict';

// Per-chat file hubs: each chat reaches its own folder under hubs/ and nothing else.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validHubName, hubFolder, listHub, hubIsPlain, findHubFile, hubFilePath } = require('../src/hubs');
const { createCommands } = require('../src/commands');
const { createRouter } = require('../src/router');
const { loadConfig, validateConfig } = require('../src/config');
const { buildPolicies } = require('../src/chats');
const { chooseChats } = require('../src/setup');
const { tempDirectory } = require('./helpers');

const A = '111@g.us', B = '222@g.us';

function hubs(t) {
  const root = path.join(tempDirectory(t, 'spam-bot-hubs-'), 'hubs');
  const files = {
    'class-a/slides/week1.pdf': 'week one', 'class-a/slides/week2.pdf': 'week two', 'class-a/reading.txt': 'read me',
    'class-a/.git/config': 'hidden', 'class-b/b-secret.pdf': 'B only'
  };
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

function setup(t, { maxSendMiB = 25, chats = null } = {}) {
  const config = loadConfig();
  config.hubs.maxSendMiB = maxSendMiB;
  config.chats = chats || [
    { id: A, label: 'Class A', receive: true, send: true, buzzword: '!bot', hub: 'class-a' },
    { id: B, label: 'Class B', receive: true, send: true, buzzword: '!bot', hub: 'class-b' }
  ];
  validateConfig(config);
  const policies = buildPolicies(config);
  const root = hubs(t);
  const commands = createCommands({ getConfig: () => config, hubsRoot: root });
  return { config, policies, root, run: (chatId, rest) => commands(policies.get(chatId), rest, { fromMe: true }) };
}

test('hub names are plain folder names', () => {
  for (const name of ['class-a', 'Slides_2026', 'a.b', 'x']) assert.equal(validHubName(name), true, name);
  for (const name of ['', '.', '..', '../b', 'a/b', 'a\\b', '.hidden', 'a..b', 'a b', 'x'.repeat(65), null]) assert.equal(validHubName(name), false, String(name));
});

test('a chat lists and sends only files from its own folder; hidden files are not offered', async t => {
  const s = setup(t);
  const list = await s.run(A, 'files');
  assert.match(list, /Files for this chat \(3\)/);
  assert.match(list, /slides\/week1\.pdf/);
  assert.doesNotMatch(list, /secret|\.git/);
  const sent = await s.run(A, 'send week1.pdf');
  assert.equal(sent.file, path.join(s.root, 'class-a', 'slides', 'week1.pdf'));
  assert.match(sent.text, /^slides\/week1\.pdf \(\d+ B\)$/);
  assert.match(await s.run(A, 'send week'), /Several files match/);
  assert.match((await s.run(B, 'files')), /b-secret\.pdf/);
});

test('nothing typed in a chat reaches another chat\'s files or the machine', async t => {
  const s = setup(t);
  for (const query of ['b-secret.pdf', '../class-b/b-secret.pdf', '..\\class-b\\b-secret.pdf', '/etc/passwd', '../../config.json', '.git/config']) {
    const reply = await s.run(A, `send ${query}`);
    assert.equal(typeof reply, 'string', query);
    assert.match(reply, /No file matching/, query);
  }
});

test('links inside a hub are skipped, and a hub that is itself a link is refused', async t => {
  const s = setup(t);
  try {
    fs.symlinkSync(path.join(s.root, 'class-b', 'b-secret.pdf'), path.join(s.root, 'class-a', 'shortcut.pdf'));
  } catch { t.skip('cannot create links here'); return; }
  const listing = listHub(path.join(s.root, 'class-a'));
  assert.equal(listing.links, 1);
  assert.ok(!listing.files.some(f => f.name === 'shortcut.pdf'));
  assert.match(await s.run(A, 'send shortcut.pdf'), /No file matching/);
  fs.renameSync(path.join(s.root, 'class-b'), path.join(s.root, 'real-b'));
  fs.symlinkSync(path.join(s.root, 'real-b'), path.join(s.root, 'class-b'));
  assert.equal(hubFolder(s.root, 'class-b'), null);
  assert.match(await s.run(B, 'files'), /missing or is not a plain folder/);
});

test('files over the size limit are not sent; a chat without a hub says so', async t => {
  const s = setup(t, { maxSendMiB: 1 });
  fs.writeFileSync(path.join(s.root, 'class-a', 'big.pdf'), Buffer.alloc(1024 * 1024 + 1));
  assert.match(await s.run(A, 'send big.pdf'), /the limit is 1 MB/);
  const none = setup(t, { chats: [{ id: A, receive: true, send: true, buzzword: '!bot' }] });
  assert.match(await none.run(A, 'files'), /No shared files are set up/);
  assert.match(await none.run(A, 'help'), /^(?![\s\S]*!bot files)/);
  assert.match(await s.run(A, 'help'), /!bot files - list this chat's shared files/);
});

test('file matching prefers exact names, then case, then the bare file name, then a unique part', () => {
  const files = [{ name: 'Slides/Week1.pdf' }, { name: 'slides/week2.pdf' }, { name: 'notes.txt' }];
  assert.equal(findHubFile(files, 'Slides/Week1.pdf').file.name, 'Slides/Week1.pdf');
  assert.equal(findHubFile(files, 'slides/week1.pdf').file.name, 'Slides/Week1.pdf');
  assert.equal(findHubFile(files, 'WEEK2.PDF').file.name, 'slides/week2.pdf');
  assert.equal(findHubFile(files, 'note').file.name, 'notes.txt');
  assert.equal(findHubFile(files, 'week').matches.length, 2);
  assert.deepEqual(findHubFile(files, '').matches, []);
});

test('a listed file that has been swapped for something else is not sent', t => {
  const root = hubs(t);
  const dir = path.join(root, 'class-a');
  const [file] = listHub(dir).files;
  fs.rmSync(path.join(dir, ...file.name.split('/')));
  fs.mkdirSync(path.join(dir, ...file.name.split('/')));
  assert.throws(() => hubFilePath(dir, file), /not a plain file/);
});

test('the router sends a hub file as a document with the reply as its caption', async t => {
  const s = setup(t);
  const replies = [];
  const loaded = [];
  const commands = createCommands({ getConfig: () => s.config, hubsRoot: s.root });
  const route = createRouter({ getPolicies: () => s.policies, getConfig: () => s.config, archive: { append() {} },
    moderate: async () => null, commands, replyGate: { reserve: () => true, canReserve: () => true, pause() {} },
    loadMedia: file => { loaded.push(file); return { media: file }; }, log: () => {}, onError: e => assert.fail(e), startedAt: 0 });
  await route({ id: { _serialized: 'm1' }, fromMe: true, from: 'me@lid', to: A, type: 'chat', body: '!bot send reading', timestamp: 1800000000,
    reply: async (content, chatId, options) => { replies.push({ content, options }); return { id: { _serialized: 'r1' } }; } });
  await route.idle();
  assert.deepEqual(loaded, [path.join(s.root, 'class-a', 'reading.txt')]);
  assert.deepEqual(replies[0].content, { media: loaded[0] });
  assert.equal(replies[0].options.sendMediaAsDocument, true);
  assert.match(replies[0].options.caption, new RegExp(`^${s.config.replyPrefix} reading\\.txt`));
});

test('config keeps one hub per chat and only where the bot can answer', () => {
  const base = { receive: true, send: true, buzzword: '!bot' };
  const check = chats => { const config = loadConfig(); config.chats = chats; return () => validateConfig(config); };
  assert.throws(check([{ id: A, ...base, hub: 'shared' }, { id: B, ...base, hub: 'Shared' }]), /already used by 111@g\.us/);
  assert.throws(check([{ id: A, ...base, hub: '../x' }]), /folder name/);
  assert.throws(check([{ id: A, ...base, send: false, hub: 'x' }]), /needs receive, send and a buzzword/);
  assert.doesNotThrow(check([{ id: A, ...base, hub: 'a' }, { id: B, ...base, hub: 'b' }]));
});

test('the chooser asks for a hub folder and refuses one another chat uses', async t => {
  const current = [{ id: B, label: 'Class B', receive: true, send: true, buzzword: '!bot', callers: 'anyone', spam: 'flag',
    archive: true, pseudonymise: true, joinRequests: 'off', ai: false, hub: 'class-b' }];
  const answers = [A, 'y', 'y', '!bot', 'a', 'f', 'n', 'n', 'CLASS-B', '../x', 'class-a', ''];
  const printed = [];
  const { chats } = await chooseChats({ rows: [], policies: new Map(), currentChats: current,
    ask: async () => (answers.length ? answers.shift() : ''), print: line => printed.push(line) });
  assert.equal(chats.find(chat => chat.id === A).hub, 'class-a');
  assert.ok(printed.some(line => /Another chat already uses that folder/.test(line)));
  assert.ok(printed.some(line => /Use letters, digits/.test(line)));
  void t;
});

// A file system in memory for the AI's folder check: { path: 'dir' | 'file' | 'link' }.
function memoryFs(entries) {
  return {
    readdirSync: p => Object.keys(entries).filter(x => path.dirname(x) === p && x !== p).map(x => path.basename(x)),
    lstatSync: p => ({ isDirectory: () => entries[p] === 'dir', isFile: () => entries[p] === 'file' })
  };
}

test('the AI only gets a hub whose whole tree is plain: hidden and deep links count, and so does size', () => {
  const root = path.join(path.sep, 'hubs', 'class-a');
  const at = (...parts) => path.join(root, ...parts);
  const plain = { [root]: 'dir', [at('slides')]: 'dir', [at('slides', 'w1.pdf')]: 'file', [at('.git')]: 'dir', [at('.git', 'HEAD')]: 'file' };
  assert.equal(hubIsPlain(root, { fsApi: memoryFs(plain) }), true);
  assert.equal(hubIsPlain(root, { fsApi: memoryFs({ ...plain, [at('.cache')]: 'link' }) }), false, 'hidden link');
  const deep = { ...plain, [at('a')]: 'dir', [at('a', 'b')]: 'dir', [at('a', 'b', 'c')]: 'dir', [at('a', 'b', 'c', 'd')]: 'dir',
    [at('a', 'b', 'c', 'd', 'root')]: 'link' };
  assert.equal(hubIsPlain(root, { fsApi: memoryFs(deep) }), false, 'deep link');
  assert.equal(hubIsPlain(root, { fsApi: memoryFs(plain), maxEntries: 2 }), false, 'too large to check');
});

test('a hub file that cannot be read here is not sent and does not pause the bot\'s replies', async t => {
  const s = setup(t);
  const errors = [];
  let paused = false;
  const commands = createCommands({ getConfig: () => s.config, hubsRoot: s.root });
  const route = createRouter({ getPolicies: () => s.policies, getConfig: () => s.config, archive: { append() {} },
    moderate: async () => null, commands, replyGate: { reserve: () => true, canReserve: () => true, pause() { paused = true; } },
    loadMedia: () => { throw new Error('EACCES: permission denied'); }, log: () => {}, onError: e => errors.push(e), startedAt: 0 });
  let replied = false;
  await route({ id: { _serialized: 'm2' }, fromMe: true, from: 'me@lid', to: A, type: 'chat', body: '!bot send reading', timestamp: 1800000000,
    reply: async () => { replied = true; return { id: { _serialized: 'r2' } }; } });
  await route.idle();
  assert.equal(replied, false);
  assert.equal(paused, false);
  assert.match(errors[0], /\[NOT SENT\] could not read a hub file/);
});
