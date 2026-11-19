'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lockDown, lockDownSummary } = require('../src/private-files');
const { tempDirectory } = require('./helpers');

const ROOT = path.join(path.sep, 'home', 'me', 'bot');

// A file system in memory: { path: { type: 'dir' | 'file' | 'link', mode, nlink?, dev? } }.
function fakeFs(entries, { failChmod = [] } = {}) {
  const calls = [];
  const fsApi = {
    lstatSync(p) {
      const entry = entries[p];
      if (!entry) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return { mode: entry.mode, nlink: entry.nlink ?? 1, dev: entry.dev ?? 1, isFile: () => entry.type === 'file',
        isDirectory: () => entry.type === 'dir', isSymbolicLink: () => entry.type === 'link' };
    },
    readdirSync(p) {
      return Object.keys(entries).filter(x => path.dirname(x) === p && x !== p).map(x => path.basename(x));
    },
    chmodSync(p, mode) {
      if (failChmod.includes(p)) throw new Error('EPERM: operation not permitted');
      calls.push([p, mode]);
      entries[p].mode = mode;
    }
  };
  return { fsApi, calls, entries };
}

const at = (...parts) => path.join(ROOT, ...parts);

test('private folders and files lose group and other access; code, links and missing files are left alone', () => {
  const f = fakeFs({
    [ROOT]: { type: 'dir', mode: 0o755 },
    [at('src')]: { type: 'dir', mode: 0o755 },
    [at('src', 'bot.js')]: { type: 'file', mode: 0o644 },
    [at('.wwebjs_auth')]: { type: 'dir', mode: 0o755 },
    [at('.wwebjs_auth', 'session')]: { type: 'dir', mode: 0o775 },
    [at('.wwebjs_auth', 'session', 'Cookies')]: { type: 'file', mode: 0o664 },
    [at('.wwebjs_auth', 'session', 'SingletonLock')]: { type: 'link', mode: 0o777 },
    [at('data')]: { type: 'dir', mode: 0o700 },
    [at('data', 'archive.jsonl')]: { type: 'file', mode: 0o600 },
    [at('logs')]: { type: 'dir', mode: 0o2755 },
    [at('hubs')]: { type: 'dir', mode: 0o755 },
    [at('hubs', 'class')]: { type: 'dir', mode: 0o755 },
    [at('hubs', 'class', 'slides.pdf')]: { type: 'file', mode: 0o644 },
    [at('hubs', 'class', 'hard-linked.pdf')]: { type: 'file', mode: 0o644, nlink: 2 },
    [at('data', 'mounted')]: { type: 'dir', mode: 0o755, dev: 2 },
    [at('config.json')]: { type: 'file', mode: 0o644 },
    [at('.env')]: { type: 'link', mode: 0o777 }
  });
  const result = lockDown(ROOT, { platform: 'linux', fsApi: f.fsApi });
  assert.deepEqual(Object.fromEntries(f.calls.map(([p, mode]) => [path.relative(ROOT, p) || '.', mode.toString(8)])), {
    '.': '700', '.wwebjs_auth': '700', [path.join('.wwebjs_auth', 'session')]: '700',
    [path.join('.wwebjs_auth', 'session', 'Cookies')]: '600', logs: '700', hubs: '700', [path.join('hubs', 'class')]: '700',
    [path.join('hubs', 'class', 'slides.pdf')]: '600', 'config.json': '600'
  });
  assert.equal(f.entries[at('src', 'bot.js')].mode, 0o644, 'code is not private and stays as it is');
  assert.equal(f.entries[at('.wwebjs_auth', 'session', 'SingletonLock')].mode, 0o777, 'links are never changed');
  assert.equal(f.entries[at('hubs', 'class', 'hard-linked.pdf')].mode, 0o644, 'a hard link may be a file elsewhere');
  assert.equal(f.entries[at('data', 'mounted')].mode, 0o755, 'another file system is left alone');
  assert.deepEqual(result.leftAlone.map(p => path.relative(ROOT, p)).sort(),
    ['.env', path.join('data', 'mounted'), path.join('hubs', 'class', 'hard-linked.pdf')].sort());
  assert.deepEqual(result.failed, []);
  const summary = lockDownSummary(ROOT, result);
  assert.match(summary, /\[NOTE\] Left as they are.*\.env/);
  assert.match(summary, /removed from 9 item\(s\)/);
  assert.match(summary, /\. 755->700/);
  assert.match(summary, /config\.json 644->600/);
  const again = lockDown(ROOT, { platform: 'linux', fsApi: f.fsApi });
  assert.deepEqual(again.changed, [], 'a second run changes nothing');
});

test('a file that cannot be changed is reported, and the rest are still locked', () => {
  const f = fakeFs({
    [ROOT]: { type: 'dir', mode: 0o700 },
    [at('config.json')]: { type: 'file', mode: 0o644 },
    [at('.env')]: { type: 'file', mode: 0o644 }
  }, { failChmod: [at('config.json')] });
  const result = lockDown(ROOT, { platform: 'linux', fsApi: f.fsApi });
  assert.equal(f.entries[at('.env')].mode, 0o600);
  assert.equal(result.failed.length, 1);
  assert.match(lockDownSummary(ROOT, result), /\[WARNING\] Could not make 1 private item\(s\) owner-only.*config\.json: EPERM/);
});

test('Windows is skipped: access there is set with ACLs', () => {
  const result = lockDown(ROOT, { platform: 'win32', fsApi: null });
  assert.equal(result.skipped, true);
  assert.equal(lockDownSummary(ROOT, result), null);
});

test('real files on Linux or macOS become owner-only, without following links out of the folder', { skip: process.platform === 'win32' && 'needs POSIX permissions' }, t => {
  const root = tempDirectory(t, 'spam-bot-private-');
  const outside = path.join(tempDirectory(t, 'spam-bot-outside-'), 'shared.txt');
  fs.writeFileSync(outside, 'not ours');
  fs.chmodSync(outside, 0o644);
  for (const dir of ['src', '.wwebjs_auth/session', 'data/archive', 'logs', '.runtime']) fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o755 });
  for (const [file, mode] of [['src/bot.js', 0o644], ['.wwebjs_auth/session/Cookies', 0o644], ['data/archive/a.jsonl', 0o644],
    ['logs/flags.jsonl', 0o664], ['.runtime/safety.json', 0o644], ['config.json', 0o644], ['.env', 0o644]]) {
    fs.writeFileSync(path.join(root, file), 'x');
    fs.chmodSync(path.join(root, file), mode);
  }
  for (const dir of ['.', 'src', '.wwebjs_auth', '.wwebjs_auth/session', 'data', 'data/archive', 'logs', '.runtime']) fs.chmodSync(path.join(root, dir), 0o755);
  fs.symlinkSync(outside, path.join(root, 'data', 'link-to-outside'));
  const hardOutside = path.join(path.dirname(outside), 'hard.txt');
  fs.writeFileSync(hardOutside, 'also not ours');
  fs.chmodSync(hardOutside, 0o644);
  fs.linkSync(hardOutside, path.join(root, 'data', 'hard.txt'));
  const result = lockDown(root);
  const mode = p => (fs.statSync(path.join(root, p)).mode & 0o777).toString(8);
  assert.deepEqual(result.failed, []);
  assert.equal((fs.statSync(hardOutside).mode & 0o777).toString(8), '644', 'the hard-linked file outside was not touched');
  assert.deepEqual(result.leftAlone, [path.join(root, 'data', 'hard.txt')]);
  assert.equal(mode('.'), '700');
  for (const dir of ['.wwebjs_auth', '.wwebjs_auth/session', 'data', 'data/archive', 'logs', '.runtime']) assert.equal(mode(dir), '700', dir);
  for (const file of ['.wwebjs_auth/session/Cookies', 'data/archive/a.jsonl', 'logs/flags.jsonl', '.runtime/safety.json', 'config.json', '.env']) assert.equal(mode(file), '600', file);
  assert.equal(mode('src/bot.js'), '644');
  assert.equal((fs.statSync(outside).mode & 0o777).toString(8), '644', 'the linked file outside was not touched');
});
