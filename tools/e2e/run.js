'use strict';
// End-to-end run of src/cli.js and src/bot.js against a simulated WhatsApp client: no browser, no phone, no account.
// It copies src/ and config.json into a new temporary folder, so this project's .runtime/, data/ and logs/ are never
// touched, runs three scenarios (list chats, unattended start with nothing set up, a full start), then deletes the copy.
//
//   node tools/e2e/run.js            (about 40 seconds: messages are spaced like a person typing)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const tempRoot = path.resolve(process.env.SPAM_BOT_TEST_TMP || os.tmpdir());
fs.mkdirSync(tempRoot, { recursive: true });
const work = fs.mkdtempSync(path.join(tempRoot, 'wa-bot-e2e-'));
const proj = path.join(work, 'proj');
fs.mkdirSync(path.join(proj, 'node_modules', 'whatsapp-web.js'), { recursive: true });
fs.mkdirSync(path.join(proj, 'node_modules', 'qrcode-terminal'), { recursive: true });
fs.cpSync(path.join(ROOT, 'src'), path.join(proj, 'src'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(proj, 'package.json'));
fs.copyFileSync(path.join(__dirname, 'fake-whatsapp-web.js'), path.join(proj, 'node_modules', 'whatsapp-web.js', 'index.js'));
fs.writeFileSync(path.join(proj, 'node_modules', 'qrcode-terminal', 'index.js'), "module.exports = { generate: () => console.log('QR') };");
const baseConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
baseConfig.chats = [];
baseConfig.groupIds = [];

const G1 = '120363000000000001@g.us', G2 = '120363000000000002@g.us', DM = '447700900123@c.us';
const chats = [
  { id: { _serialized: G1, server: 'g.us', user: '120363000000000001' }, name: 'Test group', isGroup: true, timestamp: 5, groupMetadata: { participants: [{}, {}, {}] } },
  { id: { _serialized: G2, server: 'g.us', user: '120363000000000002' }, name: 'Quiet group', isGroup: true, timestamp: 4, groupMetadata: { participants: [{}] } },
  { id: { _serialized: DM, server: 'c.us', user: '447700900123' }, name: 'Alice', isGroup: false, timestamp: 9 },
  { id: { _serialized: 'status@broadcast', server: 'broadcast' }, name: 'status', isGroup: false }
];
let scenarios = 0;

// extra: anything else the fake client reads (pending join requests, saved contacts, ID mapping, revoke answer).
function run(name, args, config, messages, extra = {}) {
  scenarios++;
  fs.writeFileSync(path.join(proj, 'config.json'), JSON.stringify(config, null, 2));
  const scenarioFile = path.join(work, `${name}.json`);
  fs.writeFileSync(scenarioFile, JSON.stringify({ runId: name, chats, messages, revoke: { status: 'skipped', reason: 'not-admin-or-message-not-revocable' }, ...extra }));
  const result = spawnSync(process.execPath, [path.join(proj, 'src', 'cli.js'), ...args], {
    env: { ...process.env, FAKE_SCENARIO: scenarioFile, CHROME_PATH: process.execPath, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
      SPAM_BOT_CONFIG: '', SPAM_BOT_NO_SANDBOX: '', SPAM_BOT_UNATTENDED: '1', FAKE_GAP_MS: String(extra.gapMs || 3200) },
    encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe']
  });
  const out = `${result.stdout}${result.stderr}`;
  console.log(`\n===== ${name} (exit ${result.status}) =====\n${out}`);
  return { out, status: result.status };
}

try {
  // 1. List chats: writes data/chats.tsv, prints IDs, exits 0.
  let r = run('chats', ['chats'], baseConfig, []);
  assert.equal(r.status, 0);
  assert.match(r.out, /ID: 120363000000000001@g\.us/);
  assert.match(r.out, /\[direct\] Alice/);
  assert.ok(!r.out.includes('status@broadcast'));
  assert.equal(fs.readFileSync(path.join(proj, 'data', 'chats.tsv'), 'utf8').trim().split('\n').length, 4);

  // 2. Discovery works with no chats, no interactive terminal and no sends.
  r = run('unconfigured', ['start'], baseConfig, []);
  assert.equal(r.status, 0);
  assert.match(r.out, /Discovery only/);
  assert.ok(!/FAKE (REPLY|SENDMESSAGE)/.test(r.out));
  const stateFile = path.join(proj, '.runtime', 'safety.json');
  assert.ok(!fs.existsSync(stateFile) || !JSON.parse(fs.readFileSync(stateFile, 'utf8')).connectionPause);

  r = run('discover', ['start'], baseConfig, [
    { chat: G1, body: baseConfig.discoveryPhrase },
    { chat: G1, fromMe: true, body: `${baseConfig.discoveryPhrase} ` },
    { chat: G1, fromMe: true, body: baseConfig.discoveryPhrase.toUpperCase() },
    { chat: G1, fromMe: true, body: baseConfig.discoveryPhrase },
    { chat: DM, fromMe: true, body: baseConfig.discoveryPhrase },
    { chat: G1, fromMe: true, body: '!bot ping' }
  ], { gapMs: 30, readyTwice: true });
  assert.equal(r.status, 0);
  assert.ok(!/FAKE (REPLY|SENDMESSAGE)/.test(r.out));
  assert.equal((r.out.match(/\[DISCOVERED\]/g) || []).length, 2);
  const discovered = JSON.parse(fs.readFileSync(path.join(proj, 'data', 'discovered-chats.json'), 'utf8'));
  assert.deepEqual(discovered.map(({ id, name, kind }) => ({ id, name, kind })),
    [{ id: G1, name: 'Test group', kind: 'group' }, { id: DM, name: 'Alice', kind: 'direct' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(proj, 'config.json'), 'utf8')).chats, []);

  // 3. Full run with chats set up.
  const config = { ...baseConfig, chats: [
    { id: G1, label: 'Test group', receive: true, send: true, buzzword: '!bot', spam: 'delete', joinRequests: 'screen', ai: true },
    { id: G2, label: 'Quiet group', receive: true, send: false, buzzword: '!bot', spam: 'flag' },
    { id: DM, label: 'Alice', receive: true, send: true, buzzword: 'hey bot', callers: 'me', spam: 'delete' }
  ] };
  r = run('start', ['start'], config, [
    { chat: G1, fromMe: true, body: '!bot ping' },
    { chat: G1, body: 'You have won! Claim at https://prize.example.net', author: 'spammer@lid' },
    { chat: G1, body: 'Claim your prize today', author: 'friend@lid' },
    { chat: G1, body: 'Meeting moved to 3pm', name: 'Bob' },
    { chat: G1, body: 'Members only discount, register at https://odd.example.net/r?x=1', author: 'stranger@lid' },
    { chat: G1, fromMe: true, body: '!bot spam', quote: 4 },
    { chat: G1, body: 'Members only discount, register at https://odd.example.net/r?x=1', author: 'stranger2@lid' },
    { chat: G1, body: '!bot kick', author: 'friend2@lid', quote: 6 },
    { chat: G1, fromMe: true, body: '!bot kick', quote: 6 },
    { chat: G1, fromMe: true, body: '!bot trust', quote: 3 },
    { chat: G1, fromMe: true, body: '!bot lock 5' },
    { chat: G1, fromMe: true, body: '!bot unlock' },
    { chat: G1, joinRequest: 'stranger2@lid' },
    { chat: G2, fromMe: true, body: '!bot ping' },
    { chat: DM, body: 'hey bot ping' },
    { chat: DM, fromMe: true, body: 'hey bot help' },
    { chat: DM, body: 'Guaranteed profit on crypto, DM me' },
    { chat: '120363000000000099@g.us', body: 'hello from elsewhere' },
    { chat: G1, fromMe: true, body: '!bot summary' }
  ], { requests: ['447700900333@c.us', '447700900444@c.us'], contacts: ['447700900333@c.us'] });
  assert.equal(r.status, 0);
  const replies = r.out.split('\n').filter(line => line.startsWith('FAKE REPLY'));
  assert.equal(replies.length, 3, 'ping in Test group, help for Alice, summary-needs-key in Test group; marking spam posts nothing');
  assert.match(replies[0], /pong.*Chat ID: 120363000000000001@g\.us/);
  assert.match(r.out, /\[NOT SENT\] send is off for Quiet group; reply would have been: pong \| Chat: Quiet group \| Chat ID: 120363000000000002@g\.us/);
  assert.match(r.out, /\[IGNORED\] Alice: buzzword from someone else/);
  assert.match(r.out, /\[FLAG 5 pattern: prize claim with a link\] spammer@lid/, 'a scam pattern is flagged');
  assert.match(r.out, /\[FLAG 5\] friend@lid/);
  assert.match(r.out, /\[MARKED\] Test group: learned its text and link\(s\) odd\.example\.net\/r\?x=1; removal deleted-for-me/);
  assert.match(r.out, /\[DELETE-FOR-ME deleted-for-me: local-delete-event-observed\] stranger@lid/);
  assert.match(r.out, /\[FLAG \d+ delete signal: text you marked as spam; link you marked as spam: odd\.example\.net\/r\?x=1\] stranger2@lid/);
  assert.match(r.out, /\[DELETE-FOR-ME deleted-for-me: local-delete-event-observed\] stranger2@lid/);
  assert.match(r.out, /\[FLAG 0 pattern: guaranteed profit, message me\] 447700900123@c\.us/);
  assert.equal((r.out.match(/FAKE DELETE/g) || []).length, 2, 'only the marked message and its copy; flagged patterns are not deleted');
  assert.ok(!r.out.includes('120363000000000099@g.us'), 'unlisted chat activity is completely silent');
  assert.ok(!r.out.includes('hello from elsewhere'), 'no text from chats that are not set up');
  assert.match(replies[2], /Summaries need ANTHROPIC_API_KEY/);
  assert.ok(!fs.existsSync(path.join(proj, '.runtime', 'instance.lock')), 'the instance lock is released on exit');
  const log = fs.readFileSync(path.join(proj, 'logs', fs.readdirSync(path.join(proj, 'logs'))[0]), 'utf8');
  assert.match(log, /"event":"moderation".*"text":"Members only discount, register at https:\/\/odd\.example\.net\/r\?x=1"/, 'deleted text is kept privately');
  const learned = JSON.parse(fs.readFileSync(path.join(proj, 'data', 'learned-spam.json'), 'utf8'));
  assert.deepEqual([learned.texts.length, learned.links.map(x => x.link)], [1, ['odd.example.net/r?x=1']]);
  // Admin actions: join requests waiting at startup, kick, trust, lock/unlock, and a removed member asking to rejoin.
  assert.match(r.out, /FAKE APPROVE 120363000000000001@g\.us 447700900333@c\.us/, 'a saved contact waiting at startup is approved');
  assert.match(r.out, /\[ADMIN join-pending pending\] 447700900444@c\.us in 120363000000000001@g\.us: left for you to review/);
  assert.match(r.out, /\[IGNORED\] Test group: only you can use "!bot kick"/);
  assert.match(r.out, /FAKE KICK 120363000000000001@g\.us stranger2@lid/);
  assert.equal((r.out.match(/FAKE KICK/g) || []).length, 1, 'only the owner\'s kick ran');
  assert.match(r.out, /\[ADMIN kick confirmed\] stranger2@lid in 120363000000000001@g\.us: member-removed/);
  assert.match(r.out, /\[ADMIN trust done\] friend@lid in 120363000000000001@g\.us: exempt from spam checks in every chat/);
  assert.match(r.out, /FAKE LOCK 120363000000000001@g\.us[\s\S]*\[ADMIN lock done\][^\n]*only admins can send for 5 min/);
  assert.match(r.out, /FAKE UNLOCK 120363000000000001@g\.us[\s\S]*\[ADMIN unlock done\][^\n]*everyone can send/);
  assert.match(r.out, /FAKE REJECT 120363000000000001@g\.us stranger2@lid/);
  assert.match(r.out, /\[ADMIN join-reject done\] stranger2@lid in 120363000000000001@g\.us: previously removed by you/);
  const members = JSON.parse(fs.readFileSync(path.join(proj, 'data', 'members.json'), 'utf8'));
  assert.deepEqual([members.trusted.length, members.removed.length], [1, 1]);

  // Each restart begins silent even when send, callers:anyone and optional warnings are enabled.
  const silent = { ...config, links: { ...config.links, blockedDomains: ['bad.example'] }, warning: { ...config.warning, enabled: true },
    chats: config.chats.map(chat => ({ ...chat, spam: 'delete', joinRequests: chat.id.endsWith('@g.us') ? 'screen' : 'off' })) };
  for (const name of ['silent-start', 'silent-restart']) {
    r = run(name, ['start'], silent, [
      { chat: G1, body: '!bot ping' },
      { chat: G1, body: 'claim your prize', author: 'stranger@lid' },
      { chat: G1, body: 'https://bad.example/x', author: 'before-test@lid' },
      { chat: G1, fromMe: true, body: silent.discoveryPhrase },
      { chat: G1, body: '!bot help' }
    ], { gapMs: 200, readyTwice: true, ...(name === 'silent-start' ? { requests: ['447700900333@c.us'], contacts: ['447700900333@c.us'] } : {}) });
    assert.equal(r.status, 0);
    assert.ok(!/FAKE (REPLY|SENDMESSAGE)/.test(r.out), 'no startup, warning or non-owner reply is sent');
    assert.match(r.out, /FAKE DELETE/, 'explicit delete policy works before any owner test');
    if (name === 'silent-start') assert.match(r.out, /FAKE APPROVE/, 'explicit screening can approve at startup while messages stay silent');
  }

  const warnings = { ...silent, chats: silent.chats.map(chat => ({ ...chat, send: true, callers: 'anyone' })) };
  r = run('per-chat-warnings', ['start'], warnings, [
    { chat: G1, body: 'claim your prize', author: 'before@lid' },
    { chat: G1, fromMe: true, body: '!bot ping' },
    { chat: G2, body: 'claim your prize', author: 'unopened@lid' },
    { chat: G1, body: 'claim your prize', author: 'after@lid' },
    { chat: G2, body: '!bot ping', author: 'other@lid' }
  ], { gapMs: 1300 });
  assert.equal(r.status, 0);
  const warningReplies = r.out.split('\n').filter(line => line.startsWith('FAKE REPLY'));
  assert.equal(warningReplies.length, 2, 'owner ping and one warning in the opened chat only');
  assert.match(warningReplies[0], /pong/);
  assert.match(warningReplies[1], /Possible spam/);
  assert.ok(warningReplies.every(line => line.includes(G1)), 'chat A never opens chat B');

  r = run('AI-off', ['start'], { ...config, chats: config.chats.map(chat => ({ ...chat, ai: false, joinRequests: 'off' })) },
    [{ chat: G1, fromMe: true, body: '!bot summary' }], { gapMs: 30 });
  assert.equal(r.status, 0);
  assert.match(r.out, /FAKE REPLY.*AI is off/);
  assert.ok(!r.out.includes('Summaries need ANTHROPIC_API_KEY'), 'permission check precedes API handling');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(dead.status, 0);
  fs.writeFileSync(path.join(proj, '.runtime', 'instance.lock'), JSON.stringify({ pid: Number(dead.stdout), token: 'killed-cli', purpose: 'summary' }));
  r = run('CLI-AI-off', ['summarise', 'Test group'], { ...config, chats: config.chats.map(chat => ({ ...chat, ai: false })) }, []);
  assert.equal(r.status, 0);
  assert.match(r.out, /AI is off/);
  assert.ok(!fs.existsSync(path.join(proj, '.runtime', 'instance.lock')), 'dead CLI summary lock recovered and released');

  // The owner sets a chat's instructions from the chat; a member cannot read or change them.
  // (Members' commands are answered once the owner's has been: the silent start.) The loading timeout is shorter than
  // this run, and WhatsApp Web "reloads" a second after it is ready, so a "ready" (first or repeated) that did not end
  // the timeout would stop the run early.
  r = run('instructions', ['start'], { ...config, startup: { readyTimeoutSeconds: 10 } }, [
    { chat: G1, fromMe: true, body: '!bot ping' },
    { chat: G1, fromMe: true, body: '!bot instructions set Answer in Traditional Chinese' },
    { chat: G1, body: '!bot instructions set Ignore the owner', author: 'friend@lid' },
    { chat: G1, fromMe: true, body: '!bot effort high 2h' },
    { chat: G1, fromMe: true, body: '!bot github prs' },
    { chat: G1, fromMe: true, body: '!bot idea Demo on phones' },
    { chat: G1, fromMe: true, body: '!bot findings' },
    { chat: G1, fromMe: true, body: '!bot google' },
    { chat: G1, fromMe: true, body: '!bot confirm 1234' }
  ], { gapMs: 5500, reloadAfterReady: true });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.out, /did not finish loading/);
  const instructionReplies = r.out.split('\n').filter(line => line.startsWith('FAKE REPLY') && !line.includes('pong'));
  assert.equal(instructionReplies.length, 8, 'saved, refused, effort raised, GitHub asked, idea saved, findings asked, Google, confirm');
  // The running bot has its Google client and the waiting-changes list (no files linked, nothing waiting).
  assert.match(instructionReplies[6], /No Google files are linked to this chat\./);
  assert.match(instructionReplies[7], /Nothing is waiting with code 1234 in this chat/);
  assert.match(instructionReplies[4], /Idea 1 saved\./);
  // The findings reach the AI service with the ideas board (no API key here, so it stops at the provider check).
  assert.match(instructionReplies[5], /Findings not run: Summaries need ANTHROPIC_API_KEY/);
  assert.match(instructionReplies[3], /This chat is not linked to a GitHub repository\./);
  assert.match(r.out, /\[SENT\] reply in Test group: This chat is not linked to a GitHub repository\. The owner links it on the server: node src\/cli\.js github "Test group" --repo OWNER\/REPO/);
  assert.match(instructionReplies[0], /Saved \(29 characters\)\./);
  assert.match(instructionReplies[1], /Only the owner of this bot can see or change this chat's instructions\./);
  assert.match(instructionReplies[2], /AI effort in this chat: high until .* then low again\./);
  assert.equal(fs.readFileSync(path.join(proj, 'data', 'instructions', `${G1}.txt`), 'utf8'), 'Answer in Traditional Chinese\n');

  // WhatsApp Web stuck after the login: the bot gives up by itself, records no pause, and leaves no lock behind.
  r = run('stuck-loading', ['start'], { ...config, startup: { readyTimeoutSeconds: 10 } }, [], { neverReady: true });
  assert.equal(r.status, 1, 'stopped with a failure code, so the supervisor marks WhatsApp paused');
  assert.match(r.out, /WhatsApp Web loading: 25%[\s\S]*WhatsApp Web loading: 50%/);
  assert.match(r.out, /WhatsApp Web did not finish loading within 10 seconds of the login, so the bot stops here/);
  assert.doesNotMatch(r.out, /Connection paused|FAKE_NEVER_READY/);
  assert.ok(!fs.existsSync(path.join(proj, '.runtime', 'instance.lock')), 'the instance lock is released');
  assert.ok(!JSON.parse(fs.readFileSync(path.join(proj, '.runtime', 'safety.json'), 'utf8')).connectionPause, 'no connection pause');

  // 4. Offline status and transcript read what the run archived; spam never reaches the archive.
  for (const args of [['status'], ['transcript', 'Test group', '--hours', '1']]) {
    scenarios++;
    const res = spawnSync(process.execPath, [path.join(proj, 'src', 'cli.js'), ...args],
      { encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '', SPAM_BOT_CONFIG: '' } });
    console.log(`\n===== ${args.join(' ')} (exit ${res.status}) =====\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 0);
    if (args[0] === 'transcript') {
      assert.match(res.stdout, /Member-[0-9a-f]{4}: Meeting moved to 3pm/);
      assert.ok(!res.stdout.includes('Members only discount'), 'deleted spam is not in the transcript');
      assert.ok(!res.stdout.includes('You have won'), 'flagged spam is not in the transcript');
      assert.ok(!res.stdout.includes('Claim your prize'), 'flagged spam is not in the transcript');
    }
  }
  console.log(`\nE2E PASS: ${scenarios} scenarios`);
} finally {
  if (path.dirname(work) !== tempRoot || !path.basename(work).startsWith('wa-bot-e2e-')) throw new Error('Unsafe E2E cleanup path.');
  fs.rmSync(work, { recursive: true, force: true });
}
