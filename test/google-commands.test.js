'use strict';

// Google files from a chat: only the files linked to that chat, read by the owner (and members where allowed),
// changed by the owner only, with a confirm code before anything is replaced, overwritten, cleared or deleted.
// A fake Google client stands in for the real one; nothing reaches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, validateConfig } = require('../src/config');
const { buildPolicies, matchBuzzword, permissionText } = require('../src/chats');
const { createCommands } = require('../src/commands');
const { createPending } = require('../src/pending');
const { GoogleError } = require('../src/google');
const { keyFileFrom, rangeFor, parseGrid, columnName } = require('../src/google-commands');
const { tempDirectory } = require('./helpers');

const A = '111@g.us', B = '222@g.us';
const DOC = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', SHEET = '1SheetIdSheetIdSheetIdSheetIdSheetId00', DECK = '1DeckIdDeckIdDeckIdDeckIdDeckIdDeckId00';
const START = Date.UTC(2027, 6, 1, 12, 0);

function fakeGoogle() {
  const calls = [];
  const state = {
    doc: { title: 'Hackathon plan', revisionId: 'rev1', text: 'Goal: ship the demo\nTeam: Kai, Ann\nGoal: win' },
    values: [['Item', 'Cost'], ['Pizza', '40']],
    deck: { title: 'Pitch', revisionId: 'rev9', slides: [{ n: 1, objectId: 'p1abc', text: 'Our idea / Help teams' }, { n: 2, objectId: 'p2abc', text: 'Demo' }] },
    fail: null
  };
  const record = (name, ...args) => {
    calls.push([name, ...args]);
    if (state.fail) throw new GoogleError(state.fail);
  };
  return {
    calls, state,
    async readDoc(id) { record('readDoc', id); return { ...state.doc }; },
    async appendDoc(id, text, options) { record('appendDoc', id, text, options); return { revisionId: 'rev2' }; },
    async replaceInDoc(id, find, replace, options) { record('replaceInDoc', id, find, replace, options); return { changed: 2 }; },
    async readRange(id, range) { record('readRange', id, range); return { range, values: state.values }; },
    async writeRange(id, range, values) { record('writeRange', id, range, values); return { updatedCells: 1 }; },
    async appendRow(id, range, row) { record('appendRow', id, range, row); return {}; },
    async clearRange(id, range) { record('clearRange', id, range); return {}; },
    async readSlides(id) { record('readSlides', id); return structuredClone(state.deck); },
    async addSlide(id, fields) { record('addSlide', id, fields); return { objectId: 'wa1' }; },
    async deleteSlide(id, objectId, options) { record('deleteSlide', id, objectId, options); return {}; },
    async replaceInSlides(id, find, replace, options) { record('replaceInSlides', id, find, replace, options); return { changed: 1 }; }
  };
}

function fixture({ members = false, maxWritesPerHour = 30 } = {}) {
  const config = loadConfig();
  config.google.maxWritesPerHour = maxWritesPerHour;
  config.chats = [
    { id: A, label: 'Hackathon', receive: true, send: true, buzzword: '!bot', googleMembers: members, googleFiles: [
      { name: 'plan', id: DOC, kind: 'doc' }, { name: 'budget', id: SHEET, kind: 'sheet' }, { name: 'pitch', id: DECK, kind: 'slides' }] },
    { id: B, label: 'Family', receive: true, send: true, buzzword: '!bot' }
  ];
  validateConfig(config);
  const policies = buildPolicies(config);
  let now = START, code = 5000;
  const clock = () => now;
  const google = fakeGoogle();
  const logs = [];
  const commands = createCommands({ getConfig: () => config, google, pending: createPending({ clock, randomInt: () => code++ }), clock,
    log: line => logs.push(line) });
  const run = (text, { fromMe = true, chat = A } = {}) => {
    const policy = policies.get(chat);
    const body = `${policy.buzzword} ${text}`;
    return commands(policy, matchBuzzword(body, policy.buzzword), { fromMe, message: { fromMe, body, id: { _serialized: 'm' } } });
  };
  const changes = () => google.calls.filter(([name]) => !name.startsWith('read'));
  return { config, policies, run, google, changes, logs, advance: ms => { now += ms; } };
}

const link = (kind, id) => `https://docs.google.com/${kind}/d/${id}/edit`;

test('reading a linked doc, sheet and deck; members only where the owner allowed it; other chats see none', async () => {
  const f = fixture({ members: true });
  assert.equal(await f.run('google'), 'Google files for this chat:\nplan - Google Doc\nbudget - Google Sheet\npitch - Google Slides\n' +
    'Read one with !bot doc <name>, !bot sheet <name> [range] or !bot slides <name>.');
  assert.equal(await f.run('doc plan', { fromMe: false }), `Hackathon plan (plan):\nGoal: ship the demo\nTeam: Kai, Ann\nGoal: win\n${link('document', DOC)}`);
  assert.equal(await f.run('sheet budget'), `budget, A1:J20:\n1: Item | Cost\n2: Pizza | 40\n${link('spreadsheets', SHEET)}`);
  assert.equal(await f.run("sheet budget 'Tab 2'!B5:C9"), `budget, 'Tab 2'!B5:C9:\n5: Item | Cost\n6: Pizza | 40\n${link('spreadsheets', SHEET)}`);
  assert.equal(await f.run('slides pitch'), `Pitch (pitch, 2 slides):\n1. Our idea / Help teams\n2. Demo\n${link('presentation', DECK)}`);
  assert.equal(await f.run('doc pitch'), 'pitch is a Google Slides: use !bot slides pitch');
  assert.match(await f.run('doc nope'), /^No Google Doc called "nope" is linked here\.\nGoogle files for this chat:/);
  assert.match(await f.run('docs'), /^Google files for this chat:/);
  assert.match(await f.run('google', { chat: B }), /^No Google files are linked to this chat\. The owner links one on the server: node src\/cli\.js google "Family" --add/);
  const closed = fixture();
  assert.equal(await closed.run('doc plan', { fromMe: false }), 'Only the owner of this bot can use Google files from this chat.');
  assert.equal(closed.google.calls.length, 0);
  assert.match(permissionText(f.policies.get(A)), /Google plan \(doc\), budget \(sheet\), pitch \(slides\) \(members can read\)$/);
});

test('adding happens at once and only for the owner; text is kept as typed', async () => {
  const f = fixture({ members: true });
  for (const text of ['doc plan append hi', 'sheet budget add a | b', 'slides pitch add T', 'doc plan replace a => b', 'sheet budget set B2 x',
    'sheet budget clear A1:B2', 'slides pitch delete 1']) {
    assert.equal(await f.run(text, { fromMe: false }), 'Only the owner of this bot can change Google files from the chat.', text);
  }
  assert.equal(f.google.calls.length, 0);
  assert.equal(await f.run('doc plan append 明天：測試\nThen demo'), `Added 15 characters at the end of plan.\n${link('document', DOC)}`);
  assert.deepEqual(f.changes()[0], ['appendDoc', DOC, '明天：測試\nThen demo', undefined]);
  assert.equal(await f.run('sheet budget add Drinks | 20 | Ann'), `Added a row to budget: Drinks | 20 | Ann\n${link('spreadsheets', SHEET)}`);
  assert.deepEqual(f.changes()[1], ['appendRow', SHEET, 'A1', ['Drinks', '20', 'Ann']]);
  assert.equal(await f.run('slides pitch add Results | We built it\nIt works'), `Added a slide "Results" at the end of pitch.\n${link('presentation', DECK)}`);
  assert.deepEqual(f.changes()[2], ['addSlide', DECK, { title: 'Results', body: 'We built it\nIt works' }]);
  assert.deepEqual(f.logs, ['[GOOGLE] Hackathon: added text at the end in plan', '[GOOGLE] Hackathon: added a row in budget',
    '[GOOGLE] Hackathon: added a slide in pitch']);
  assert.match(await f.run('doc plan append'), /^Usage: !bot doc plan append <text>/);
  assert.match(await f.run('doc plan help'), /^plan \(Google Doc\):\n!bot doc plan - read it/);
});

test('replacing, overwriting, clearing and deleting wait for the code, and docs and slides keep their revision', async () => {
  const f = fixture();
  assert.equal(await f.run('doc plan replace Goal => Aim'), 'Replace "Goal" with "Aim" everywhere in plan? It is in 2 places of the main text; ' +
    'other tabs, headers and footers change too if they have it. Only if nobody changes the document first.\n' +
    'To do it, send !bot confirm 5000 within 2 minutes (or !bot cancel 5000).');
  assert.equal(f.changes().length, 0);
  assert.equal(await f.run('confirm 5000'), `Replaced 2 places in plan.\n${link('document', DOC)}`);
  assert.deepEqual(f.changes()[0], ['replaceInDoc', DOC, 'Goal', 'Aim', { revisionId: 'rev1' }]);
  assert.equal(await f.run('doc plan replace Nothing => x'), '"Nothing" is not in plan (it must match exactly, capitals too).');

  assert.equal(await f.run('sheet budget set B2\n45 | paid\n12 | open'), 'Write 2 rows × 2 cells in budget, B2:C3?\nnow:\n2: Item | Cost\n3: Pizza | 40\n' +
    'new:\n2: 45 | paid\n3: 12 | open\nTo do it, send !bot confirm 5001 within 2 minutes (or !bot cancel 5001).');
  assert.match(await f.run('confirm 5001'), /^Wrote B2:C3 in budget\./);
  assert.deepEqual(f.changes()[1], ['writeRange', SHEET, 'B2:C3', [['45', 'paid'], ['12', 'open']]]);
  assert.match(await f.run('sheet budget set D4 Done'), /^Write one cell in budget, D4:D4\?/);
  assert.match(await f.run('sheet budget clear A1:B2'), /^Clear 4 cells in budget, A1:B2\?\n1: Item \| Cost\n2: Pizza \| 40\nTo do it, send !bot confirm 5003/);
  assert.equal(await f.run('confirm 5003'), `Cleared A1:B2 in budget.\n${link('spreadsheets', SHEET)}`);
  assert.match(await f.run('sheet budget clear A1'), /^Clear 4 cells in budget, A1\?/);
  assert.match(await f.run('sheet budget clear'), /^Usage: !bot sheet budget clear <range>/);

  assert.equal(await f.run('slides pitch delete 2'), 'Delete slide 2 of pitch: "Demo"? Only if nobody changes the presentation first.\n' +
    'To do it, send !bot confirm 5005 within 2 minutes (or !bot cancel 5005).');
  assert.equal(await f.run('confirm 5005'), `Deleted slide 2 of pitch.\n${link('presentation', DECK)}`);
  assert.deepEqual(f.changes().at(-1), ['deleteSlide', DECK, 'p2abc', { revisionId: 'rev9' }]);
  assert.equal(await f.run('slides pitch delete 7'), 'pitch has 2 slides; there is no slide 7.');
  assert.match(await f.run('slides pitch replace Demo => Live demo'), /^Replace "Demo" with "Live demo" everywhere in pitch \(about 1 place\)\?/);
});

test('Google\'s refusals become plain replies, one request per chat at a time, and an hourly limit', async () => {
  const f = fixture({ maxWritesPerHour: 1 });
  f.google.state.fail = 'it was not found, or it is not shared with bot@x.iam.gserviceaccount.com.';
  assert.equal(await f.run('doc plan').catch(error => `threw: ${error.message}`), 'Google: it was not found, or it is not shared with bot@x.iam.gserviceaccount.com.');
  f.google.state.fail = null;
  assert.match(await f.run('doc plan append one'), /^Added 3 characters/);
  assert.equal(await f.run('doc plan append two'), 'Google: at most 1 changes an hour can be made from chats; try again later.');
  f.advance(3600001);
  assert.match(await f.run('doc plan append three'), /^Added 5 characters/);
  // A confirmed change that Google refuses is a reply too.
  f.advance(3600001);
  assert.match(await f.run('slides pitch delete 1'), /confirm 5000 /);
  f.google.state.fail = 'the file changed since it was read; read it again and retry.';
  assert.equal(await f.run('confirm 5000').catch(error => `threw: ${error.message}`), 'Google: the file changed since it was read; read it again and retry.');
});

test('the key file path comes from .env, relative to the bot folder; sheet ranges and grids', t => {
  const dir = tempDirectory(t, 'spam-bot-google-env-');
  const env = path.join(dir, '.env');
  assert.equal(keyFileFrom(env, dir, {}), '');
  fs.writeFileSync(env, 'GOOGLE_SERVICE_ACCOUNT_FILE=keys/google.json\n');
  assert.equal(keyFileFrom(env, dir, {}), path.join(dir, 'keys', 'google.json'));
  assert.equal(keyFileFrom(path.join(dir, 'missing'), dir, { GOOGLE_SERVICE_ACCOUNT_FILE: path.join(dir, 'k.json') }), path.join(dir, 'k.json'));
  assert.equal(rangeFor('B2', 2, 3), 'B2:D3');
  assert.equal(rangeFor("'Tab 2'!Z9", 1, 2), "'Tab 2'!Z9:AA9");
  assert.equal(rangeFor('A1:C3', 9, 9), 'A1:C3');
  assert.equal(columnName(703), 'AAA');
  assert.deepEqual(parseGrid(' a | b \n\n c '), [['a', 'b'], ['c']]);
});

test('google files in the config are checked', () => {
  const config = loadConfig();
  const withFiles = googleFiles => ({ ...structuredClone(config), chats: [{ id: A, receive: true, send: true, buzzword: '!bot', googleFiles }] });
  assert.doesNotThrow(() => validateConfig(withFiles([{ name: 'plan', id: DOC, kind: 'doc' }])));
  assert.throws(() => validateConfig(withFiles([{ name: 'Plan!', id: DOC, kind: 'doc' }])), /googleFiles: each needs a name/);
  assert.throws(() => validateConfig(withFiles([{ name: 'plan', id: 'short', kind: 'doc' }])), /googleFiles: each needs/);
  assert.throws(() => validateConfig(withFiles([{ name: 'plan', id: DOC, kind: 'pdf' }])), /googleFiles: each needs/);
  assert.throws(() => validateConfig(withFiles([{ name: 'plan', id: DOC, kind: 'doc' }, { name: 'plan', id: SHEET, kind: 'sheet' }])), /used twice/);
  assert.throws(() => validateConfig({ ...structuredClone(config), google: { maxWritesPerHour: 0, timeoutSeconds: 15 } }), /google\.maxWritesPerHour/);
});

test('links and long numbers in a file are not posted; members wait between reads; a capped count says "at least"; no revision, no change', async () => {
  const f = fixture({ members: true });
  f.google.state.doc.text = 'Demo at https://phish.example/login\nCall 07700900123';
  assert.equal(await f.run('doc plan', { fromMe: false }), `Hackathon plan (plan):\nDemo at [link]\nCall [number]\n${link('document', DOC)}`);
  // Members' reads come google.cooldownSeconds apart; the owner never waits.
  assert.equal(await f.run('sheet budget', { fromMe: false }), 'Please wait 10s between Google commands in this chat.');
  assert.match(await f.run('sheet budget'), /^budget, A1:J20:/);
  f.advance(10000);
  assert.match(await f.run('slides pitch', { fromMe: false }), /^Pitch \(pitch, 2 slides\):/);
  // A range bigger than one read shows "at least".
  f.google.state.values = Array.from({ length: 200 }, () => ['x']);
  assert.match(await f.run('sheet budget clear A1:A5000'), /^Clear at least 200 cells in budget, A1:A5000\?/);
  // Without a revision from Google, nothing is offered.
  f.google.state.doc.revisionId = '';
  assert.equal(await f.run('doc plan replace Demo => Show'), 'Google did not say which version of plan it read, so it is not changed from the chat; change it in Google.');
  f.google.state.deck.revisionId = undefined;
  assert.match(await f.run('slides pitch delete 1'), /^Google did not say which version of pitch it read/);
  assert.equal(f.changes().length, 0);
});
