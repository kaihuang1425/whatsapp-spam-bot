'use strict';

// Keeping a chat's hub folder in step with a git repository (for example a private GitHub repo reached with that
// repo's own read-only deploy key). "!bot sync" (owner only) and the CLI pull; the CLI also sets a folder up.
//
// - The repository's git data lives in data/hub-git/<hub>.git, never inside hubs/: the chat's files are the only
//   thing in the folder, so the AI cannot read the remote URL or key path, and git never searches parent folders.
// - The clone is partial and single-branch: files over hubs.maxSendMiB are never downloaded (memory and disk stay
//   small inside the WhatsApp worker). Before anything changes, the new version is checked: no file left behind on
//   the server, none over the limit, at most hubs.maxSyncFiles files and hubs.maxSyncMiB in all, and the git data
//   itself under twice that. Pulls are fast-forward only.
// - Hooks, symlinks (checked out as plain files), submodules, fsmonitor, background maintenance and filter drivers
//   from the machine's or the user's git settings are all off: nothing a pushed commit contains runs a program.
// - git gets PATH, HOME (for ~/.ssh) and locale only, never the bot's API keys or tokens, and no terminal: it cannot
//   stop to ask for a password or host key. A stuck run is stopped after 60 seconds.
// - One action per folder at a time, across processes (a lock file next to the git data), and never while the AI
//   is reading the folder: the AI takes the same lock.
// - The chat sees a short summary, never git's own output (which names the repository); details go to the log.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { hubFolder, listHub, hubIsPlain, validHubName } = require('./hubs');

const KEEP_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ'];
const KEEP_ENV_WIN32 = ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA',
  'LOCALAPPDATA', 'TEMP', 'TMP', 'ProgramData', 'ProgramFiles'];
const MAX_OUTPUT = 256 * 1024;
const MAX_CHECK_OUTPUT = 32 * 1024 * 1024;
const MiB = 1024 * 1024;
const active = new Set();
let exitHookInstalled = false;

// A lock per hub folder in data/hub-git/<hub>.lock, shared by the worker, the CLI (perhaps on another machine of the
// same host) and the AI. A lock is stale when its process is gone (same machine) or it is older than staleMs.
function createHubLock(gitRoot, { staleMs = 20 * 60 * 1000, host = os.hostname() } = {}) {
  const file = hub => path.join(gitRoot, `${hub.toLowerCase()}.lock`);
  function stale(hub) {
    let text, mtime;
    try { text = fs.readFileSync(file(hub), 'utf8'); mtime = fs.statSync(file(hub)).mtimeMs; } catch { return true; }
    if (Date.now() - mtime > staleMs) return true;
    let info;
    try { info = JSON.parse(text); } catch { return Date.now() - mtime > 60000; } // still being written
    if (info.host === host && Number.isSafeInteger(info.pid) && info.pid > 0) {
      try { process.kill(info.pid, 0); } catch (error) { return error.code === 'ESRCH'; }
    }
    return false;
  }
  return {
    held: hub => fs.existsSync(file(hub)) && !stale(hub),
    // Returns a release function, or null when someone else holds the folder.
    acquire(hub) {
      fs.mkdirSync(gitRoot, { recursive: true, mode: 0o700 });
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = randomUUID();
        try {
          fs.writeFileSync(file(hub), JSON.stringify({ pid: process.pid, host, time: Date.now(), token }), { flag: 'wx', mode: 0o600 });
          return () => {
            try { if (JSON.parse(fs.readFileSync(file(hub), 'utf8')).token === token) fs.unlinkSync(file(hub)); } catch { /* gone */ }
          };
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (!stale(hub)) return null;
          try { fs.unlinkSync(file(hub)); } catch { /* someone else cleared it */ }
        }
      }
      return null;
    }
  };
}

function killTree(child, platform, signal = 'SIGKILL') {
  try {
    if (platform === 'win32') spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, signal);
  } catch { try { child.kill(signal); } catch { /* gone */ } }
}

function gitEnv(env, platform) {
  const out = {};
  for (const key of [...KEEP_ENV, ...(platform === 'win32' ? KEEP_ENV_WIN32 : [])]) if (env[key]) out[key] = env[key];
  Object.assign(out, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1' });
  return out;
}

function safetyArgs(platform) {
  return ['-c', `core.hooksPath=${platform === 'win32' ? 'NUL' : '/dev/null'}`, '-c', 'submodule.recurse=false',
    '-c', 'core.fsmonitor=false', '-c', 'core.symlinks=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
    '-c', 'pack.threads=1', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false'];
}

// git's partial-clone filter for the per-file limit, in KiB so fractional MiB settings work.
const blobFilter = maxFileMiB => `blob:limit=${Math.max(1, Math.floor(maxFileMiB * 1024))}k`;

// What a failed git step most likely means, in words for the chat. Unknown errors get a pointer to the log.
function explain(stderr) {
  const text = String(stderr);
  if (/Not possible to fast-forward|have diverged|divergent branches/i.test(text)) {
    return 'the copy on the server has its own commits, so it was not changed.';
  }
  if (/would be overwritten by (merge|checkout)|untracked working tree files would be/i.test(text)) {
    return 'files changed on the server would be overwritten, so nothing was changed. Move them out of the folder first.';
  }
  if (/index\.lock|Unable to create .*\.lock/i.test(text)) return 'a lock file from an interrupted run is in the way. If no sync is running, remove the .lock file named in the bot\'s log.';
  if (/Permission denied \(publickey|Repository not found|Authentication failed|could not read Username/i.test(text)) {
    return 'GitHub refused the key. Check the repo\'s deploy key.';
  }
  if (/Host key verification failed/i.test(text)) return 'the server does not trust github.com yet. Run ssh -T git@github.com once in a console and confirm the fingerprint.';
  if (/Could not resolve host|Connection timed out|Network is unreachable|Connection refused/i.test(text)) return 'the repository could not be reached (network).';
  return 'git reported an error. Details are in the bot\'s log.';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function dirSize(dir) {
  let total = 0;
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) { try { total += fs.statSync(full).size; } catch { /* gone */ } }
    }
  };
  walk(dir);
  return total;
}

function createHubSync({ hubsRoot, gitRoot, gitCommand = 'git', timeoutMs = 60000, cooldownMs = 30000, env = process.env,
  platform = process.platform, log = console.error, spawnFn = spawn, clock = Date.now, hubLock = createHubLock(gitRoot),
  getLimits = () => ({ maxFileMiB: 25, maxTotalMiB: 200, maxFiles: 5000 }) }) {
  const busy = new Set();
  const last = new Map();
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => { for (const { child, platform: p } of active) killTree(child, p); });
  }

  // Resolves once git has exited (or, after a timeout and a kill, 6 seconds later at most). truncated: output cut.
  function run(args, { gitDir = null, workTree = null, cwd, maxOutput = MAX_OUTPUT }) {
    return new Promise(resolve => {
      let out = '', err = '', settled = false, timedOut = false, truncated = false, child;
      const finish = code => {
        if (settled) return;
        settled = true;
        resolve({ code, stdout: out, stderr: err, timedOut, truncated });
      };
      const where = [...(gitDir ? [`--git-dir=${gitDir}`] : []), ...(workTree ? [`--work-tree=${workTree}`] : [])];
      try {
        child = spawnFn(gitCommand, [...safetyArgs(platform), ...where, ...args], { cwd, env: gitEnv(env, platform),
          stdio: ['ignore', 'pipe', 'pipe'], detached: platform !== 'win32', windowsHide: true });
      } catch (error) { err = String(error.message); finish(-1); return; }
      const entry = { child, platform };
      active.add(entry);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { if (out.length < maxOutput) out += chunk; else truncated = true; });
      child.stderr.on('data', chunk => { if (err.length < MAX_OUTPUT) err += chunk; });
      // Ask politely first, so git can remove its lock files; then make sure, including anything it started.
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child, platform, 'SIGTERM');
        setTimeout(() => killTree(child, platform), 3000).unref();
        setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); active.delete(entry); finish(-1); }, 6000).unref();
      }, timeoutMs);
      const done = () => { clearTimeout(timer); active.delete(entry); };
      child.on('error', error => { done(); err += `\n${error.message}`; finish(-1); });
      // After a timeout, grandchildren may keep the pipes open: the process itself ending is enough.
      child.on('exit', code => { if (timedOut) { done(); finish(code ?? -1); } });
      child.on('close', code => { done(); finish(timedOut ? -1 : code); });
    });
  }

  const gitDirFor = hub => path.join(gitRoot, `${hub.toLowerCase()}.git`);

  function realDir(file) {
    try { return fs.lstatSync(file).isDirectory(); } catch { return false; }
  }

  // Everything the target commit's files would bring, checked before the folder changes: nothing left on the
  // server (over the download limit), every file sized and within the limit, and not too many or too much in all.
  // Output that does not fit is a refusal, never a pass.
  async function checkTree(where, target, limits, label) {
    const tooMany = { refuse: `${label} has more than ${limits.maxFiles} files (hubs.maxSyncFiles), so nothing was changed.` };
    const listing = await run(['rev-list', '--objects', '--no-object-names', '--missing=print', '--no-walk', target],
      { ...where, maxOutput: MAX_CHECK_OUTPUT });
    if (listing.code !== 0 || listing.timedOut) return { error: listing };
    if (listing.truncated) return tooMany;
    if (listing.stdout.split('\n').some(line => line.startsWith('?'))) {
      return { refuse: `${label} has a file over ${limits.maxFileMiB} MB, so it was not downloaded and nothing was changed. ` +
        'Remove it from the repo (or keep it elsewhere) and push again.' };
    }
    const tree = await run(['ls-tree', '-r', '-l', '-z', target], { ...where, maxOutput: MAX_CHECK_OUTPUT });
    if (tree.code !== 0 || tree.timedOut) return { error: tree };
    if (tree.truncated) return tooMany;
    const entries = tree.stdout.split('\0').filter(Boolean);
    if (entries.length > limits.maxFiles) return tooMany;
    let total = 0;
    for (const entry of entries) {
      const [, type, , size] = entry.split('\t')[0].trim().split(/\s+/);
      if (type === 'commit') continue; // a submodule entry: never checked out (submodule.recurse=false)
      const bytes = Number(size);
      if (type !== 'blob' || !Number.isSafeInteger(bytes)) return { refuse: `${label} could not be checked completely, so nothing was changed.` };
      total += bytes;
      if (bytes > limits.maxFileMiB * MiB) return { refuse: `${label} has a file over ${limits.maxFileMiB} MB, so nothing was changed.` };
    }
    if (total > limits.maxTotalMiB * MiB) {
      return { refuse: `${label} would be ${Math.ceil(total / MiB)} MB, over hubs.maxSyncMiB (${limits.maxTotalMiB}), so nothing was changed.` };
    }
    return { total };
  }

  function failed(what, policy, result) {
    log(`Sync of hubs/${policy.hub} for ${policy.label || policy.id}: ${what} failed${result.timedOut ? ' (timed out)' : ` (git exit ${result.code})`}:\n${result.stderr}`.trim());
    return result.timedOut ? `Sync stopped after ${Math.round(timeoutMs / 1000)}s: the repository did not answer. Details are in the bot's log.`
      : `Sync failed: ${explain(result.stderr)}`;
  }

  function report(dir) {
    const listed = listHub(dir).files.length;
    return { listed, note: hubIsPlain(dir) ? '' : ' The folder holds links or is too large to check, so the AI will not read it.' };
  }

  // Guards shared by every action: the chat's own folder, one action per folder at a time (in this process and across
  // processes), and not while the AI reads it.
  async function guarded(policy, action) {
    if (!policy.hub || !validHubName(policy.hub)) return 'No shared files are set up for this chat.';
    const dir = hubFolder(hubsRoot, policy.hub);
    if (!dir) return 'This chat\'s file folder is missing or is not a plain folder.';
    const key = policy.hub.toLowerCase();
    if (busy.has(key)) return 'A sync for this folder is already running.';
    const release = hubLock.acquire(policy.hub);
    if (!release) return 'This folder is busy (the AI is reading it, or another sync is running); try again in a minute.';
    busy.add(key);
    try { return await action(dir, gitDirFor(policy.hub)); } finally { busy.delete(key); release(); }
  }

  // Bring the folder up to date (chat command and CLI).
  async function syncHub(policy) {
    if (policy.hub && last.has(policy.hub.toLowerCase())) {
      const wait = cooldownMs - (clock() - last.get(policy.hub.toLowerCase()));
      if (wait > 0) return `Please wait ${Math.ceil(wait / 1000)}s before syncing again.`;
    }
    return guarded(policy, async (dir, gitDir) => {
      if (fs.existsSync(path.join(dir, '.git'))) {
        return `hubs/${policy.hub}/ still has its own .git, which the AI could read. On the server, run: sync "${policy.label || policy.id}" --adopt`;
      }
      if (!realDir(gitDir)) {
        return `hubs/${policy.hub}/ is not set up for sync. On the server, run: sync "${policy.label || policy.id}" --clone <repo address> --key <deploy key>`;
      }
      last.set(policy.hub.toLowerCase(), clock());
      const limits = getLimits();
      const where = { gitDir, workTree: dir, cwd: gitDir };
      // Keep the download limit in step with hubs.maxSendMiB, if it changed since the clone.
      const promisor = await run(['config', '--get', 'remote.origin.promisor'], where);
      if (promisor.stdout.trim() === 'true') await run(['config', 'remote.origin.partialclonefilter', blobFilter(limits.maxFileMiB)], where);
      const before = await run(['rev-parse', 'HEAD'], where);
      const fetch = await run(['fetch', '--quiet', '--no-tags'], where);
      if (fetch.code !== 0 || fetch.timedOut) return failed('fetch', policy, fetch);
      if (dirSize(path.join(gitDir, 'objects')) > 2 * limits.maxTotalMiB * MiB) {
        return `Sync refused: the repository's history on the server is over ${2 * limits.maxTotalMiB} MB (twice hubs.maxSyncMiB). ` +
          `Nothing was changed. To start over, delete ${gitDir} and clone again.`;
      }
      const upstream = await run(['rev-parse', '--verify', '@{u}'], where);
      if (upstream.code !== 0) return failed('finding the branch to follow', policy, upstream);
      const from = before.stdout.trim(), to = upstream.stdout.trim();
      if (from === to) {
        const { listed, note } = report(dir);
        return `Already up to date (${plural(listed, 'file')}).${note}`;
      }
      if (from) {
        const ancestor = await run(['merge-base', '--is-ancestor', from, to], where);
        if (ancestor.code === 1) return 'Sync failed: the copy on the server has its own commits, so it was not changed.';
        if (ancestor.code !== 0) return failed('comparing commits', policy, ancestor);
      }
      const check = await checkTree(where, to, limits, 'The new version');
      if (check.error) return failed('checking sizes', policy, check.error);
      if (check.refuse) return `Sync refused: ${check.refuse}`;
      const merge = await run(['merge', '--ff-only', '--quiet', to], where);
      if (merge.code !== 0 || merge.timedOut) return failed('updating files', policy, merge);
      const diff = from ? await run(['diff', '--shortstat', from, to], where) : { stdout: '' };
      const { listed, note } = report(dir);
      return `Folder updated from ${from ? from.slice(0, 7) : 'nothing'} to ${to.slice(0, 7)}: ${diff.stdout.trim() || 'updated'}. ` +
        `${plural(listed, 'file')} now.${note}`;
    });
  }

  // Undo a clone that did not finish: no git data, and the folder empty again (it was empty before).
  function undoClone(dir, gitDir) {
    try { fs.rmSync(gitDir, { recursive: true, force: true }); } catch (error) { log(`Could not remove ${gitDir}: ${error.message}`); }
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }

  // CLI only: clone a repository for a chat's empty folder, with its git data kept outside the folder.
  async function cloneHub(policy, { url, key = '' }) {
    if (!/^(?:git@[\w.-]+:[\w./-]+|ssh:\/\/[^\s'"\\]+|https:\/\/[^\s'"\\]+|file:\/\/[^\s'"\\]+)$/.test(String(url))) {
      return 'Give the repository as git@github.com:OWNER/REPO.git (or an ssh://, https:// or file:// address).';
    }
    if (key && !/^[\w.~/-]+$/.test(key)) return 'The key path may only contain letters, digits and . _ ~ / -';
    return guarded(policy, async (dir, gitDir) => {
      if (fs.existsSync(gitDir)) return `hubs/${policy.hub}/ is already set up for sync (${gitDir}).`;
      if (fs.readdirSync(dir).length) return `hubs/${policy.hub}/ must be empty before cloning. Move its files into the repository first.`;
      fs.mkdirSync(gitRoot, { recursive: true, mode: 0o700 });
      const scratch = fs.mkdtempSync(path.join(gitRoot, '.clone-'));
      const limits = getLimits();
      const ssh = key ? ['-c', `core.sshCommand=ssh -i ${key} -o IdentitiesOnly=yes -o BatchMode=yes`] : [];
      const clone = await run(['clone', '--quiet', '--no-checkout', '--single-branch', '--no-tags', `--filter=${blobFilter(limits.maxFileMiB)}`,
        `--separate-git-dir=${gitDir}`, '-c', 'core.symlinks=false', ...ssh, '--', url, path.join(scratch, 'w')], { cwd: gitRoot });
      fs.rmSync(scratch, { recursive: true, force: true }); // only the .git pointer file was written there
      if (clone.code !== 0 || clone.timedOut) {
        undoClone(dir, gitDir);
        return failed('clone', policy, clone);
      }
      const where = { gitDir, workTree: dir, cwd: gitDir };
      // A repository with no commits clones fine but has nothing to check out: say so, instead of a git error.
      const head = await run(['rev-parse', '--verify', '--quiet', 'HEAD'], where);
      if (head.timedOut || (head.code !== 0 && head.code !== 1)) {
        undoClone(dir, gitDir);
        return failed('checking the clone', policy, head);
      }
      if (head.code !== 0) {
        undoClone(dir, gitDir);
        return 'Not cloned: the repository is empty. Add a file to it on GitHub first, then run this again.';
      }
      const check = await checkTree(where, 'HEAD', limits, 'The repository');
      if (check.error || check.refuse) {
        undoClone(dir, gitDir);
        return check.error ? failed('checking sizes', policy, check.error) : `Not cloned: ${check.refuse}`;
      }
      const checkout = await run(['checkout', '-f', '--quiet'], where);
      if (checkout.code !== 0 || checkout.timedOut) {
        undoClone(dir, gitDir);
        return failed('checkout', policy, checkout);
      }
      const { listed, note } = report(dir);
      return `Cloned into hubs/${policy.hub}/: ${plural(listed, 'file')}. Git data is in ${gitDir}. Use "sync" from now on.${note}`;
    });
  }

  // CLI only: move the .git folder of an earlier clone out of the hub folder, and make later fetches partial.
  async function adoptHub(policy) {
    return guarded(policy, async (dir, gitDir) => {
      const inside = path.join(dir, '.git');
      if (!realDir(inside)) return `hubs/${policy.hub}/ has no .git folder to move.`;
      if (fs.existsSync(gitDir)) return `${gitDir} already exists; nothing was moved.`;
      const remotes = await run(['remote'], { gitDir: inside, cwd: dir });
      if (!remotes.stdout.split('\n').map(x => x.trim()).includes('origin')) {
        return 'This clone has no remote called "origin"; clone again with --clone instead.';
      }
      fs.mkdirSync(gitRoot, { recursive: true, mode: 0o700 });
      fs.renameSync(inside, gitDir);
      for (const [name, value] of [['core.symlinks', 'false'], ['remote.origin.promisor', 'true'],
        ['remote.origin.partialclonefilter', blobFilter(getLimits().maxFileMiB)]]) {
        const set = await run(['config', name, value], { gitDir, cwd: gitDir });
        if (set.code !== 0) return failed(`setting ${name}`, policy, set);
      }
      const { listed, note } = report(dir);
      return `Moved the git data of hubs/${policy.hub}/ to ${gitDir} (${plural(listed, 'file')}). Use "sync" from now on.${note}`;
    });
  }

  syncHub.clone = cloneHub;
  syncHub.adopt = adoptHub;
  return syncHub;
}

module.exports = { createHubSync, createHubLock, gitEnv, safetyArgs, explain, blobFilter };
