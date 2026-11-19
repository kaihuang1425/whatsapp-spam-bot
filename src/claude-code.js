'use strict';

// Your own Claude subscription through the official, unmodified Claude Code program (claude -p), for requests you
// make yourself. Anthropic's terms allow signing in to Claude Code with your own plan; they do not allow routing other
// people's requests through it, so the summary service only lets the owner start these runs.
//
// Every run is sealed off from the others and from the rest of this machine:
// - its own empty folder, deleted afterwards, or the chat's file hub when the owner's question may read files;
// - no tools at all, or only Read, Grep and Glob confined to that folder (--restricted, --tools);
// - no Bash, web, MCP servers, CLAUDE.md files, auto memory, settings or saved sessions;
// - a fresh HOME and Claude config folder, so nothing of yours (or of another chat's run) is loaded;
// - an environment that holds only PATH, locale and the subscription token: no API keys, nothing else of the bot's;
// - "@" in the prompt is neutralised, so a chat message cannot name a file for Claude Code to attach.
// A run still going when the bot stops is killed, and leftover run folders are removed at the next start.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_STDOUT = 4 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const active = new Set(); // process group ids (or pids on Windows) of runs in progress

let exitHookInstalled = false;
function killActive() {
  for (const pid of active) {
    try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  active.clear();
}
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', killActive);
}

// Run folders left by a bot that stopped mid-run. Only this bot's own run-* folders, never anything else.
function removeStaleRuns(runsDir) {
  let names;
  try { names = fs.readdirSync(runsDir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!/^run-[\w-]+$/.test(name)) continue;
    const dir = path.join(runsDir, name);
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch { /* best effort */ }
  }
  return removed;
}

function executable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// The configured path, else `claude` on PATH, else the native installer's ~/.local/bin/claude.
function findClaude({ configured = '', env = process.env, platform = process.platform, exists = executable } = {}) {
  if (configured) return exists(configured) ? configured : null;
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  const dirs = String(env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const home = env.HOME || env.USERPROFILE;
  if (home) dirs.push(path.join(home, '.local', 'bin'));
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function sandboxEnv({ env, home, tmp, token, platform }) {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'TZ', ...(platform === 'win32' ? ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT'] : [])];
  const out = {};
  for (const key of keep) if (env[key]) out[key] = env[key];
  Object.assign(out, {
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    TMPDIR: tmp,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1'
  });
  if (platform === 'win32') Object.assign(out, { USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TMP: tmp, TEMP: tmp });
  return out;
}

// No allow rules: in dontAsk mode reads inside the working folder need none, and a bare "Read" rule would allow any path.
function claudeArgs({ model, effort, system, readFiles, maxBudgetUsd }) {
  return [
    '-p', '--output-format', 'json', '--model', model, ...(effort ? ['--effort', effort] : []),
    '--restricted', '--tools', readFiles ? READ_TOOLS.join(',') : '', '--disallowedTools', 'mcp__*', '--strict-mcp-config',
    '--permission-mode', 'dontAsk', '--no-session-persistence',
    ...(maxBudgetUsd > 0 ? ['--max-budget-usd', String(maxBudgetUsd)] : []),
    '--system-prompt', system
  ];
}

// "@path" in a prompt asks Claude Code to attach that file; a zero-width space after every "@" keeps it as text.
function neutralise(prompt) {
  return String(prompt).replace(/@/g, '@​');
}

class RunError extends Error {
  constructor(message, details = '') {
    super(message);
    this.details = details;
  }
}

// One sealed run. Resolves with the answer text; rejects with a short message that is safe to show in a chat
// (no paths or output); `details` on the error carries the rest for the bot's own log.
async function runClaudeCode({ command, token, model, effort = '', system, prompt, workdir = null, runsDir,
  timeoutMs = 300000, maxBudgetUsd = 0, env = process.env, platform = process.platform, spawnFn = spawn }) {
  if (!command) throw new RunError('Claude Code is not installed on this machine.');
  if (!token) throw new RunError('CLAUDE_CODE_OAUTH_TOKEN is not set.');
  let run = null;
  try {
    fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    run = fs.mkdtempSync(path.join(runsDir, 'run-'));
    if (path.dirname(run) !== path.resolve(runsDir)) throw new Error(`unexpected run folder ${run}`);
    const home = path.join(run, 'home');
    const tmp = path.join(run, 'tmp');
    const empty = path.join(run, 'work');
    for (const dir of [home, tmp, empty]) fs.mkdirSync(dir, { mode: 0o700 });
    const readFiles = Boolean(workdir);
    const args = claudeArgs({ model, effort, system, readFiles, maxBudgetUsd });
    installExitHook();
    const { code, stdout, stderr, timedOut } = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnFn(command, args, { cwd: readFiles ? workdir : empty, env: sandboxEnv({ env, home, tmp, token, platform }),
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: platform !== 'win32' });
      } catch (error) { reject(error); return; }
      if (child.pid) active.add(child.pid);
      let out = '', err = '', timedOut = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { if (out.length < MAX_STDOUT) out += chunk; });
      child.stderr.on('data', chunk => { if (err.length < MAX_STDERR) err += chunk; });
      const timer = setTimeout(() => {
        timedOut = true;
        try { if (platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
      }, timeoutMs);
      const done = () => { clearTimeout(timer); active.delete(child.pid); };
      child.on('error', error => { done(); reject(error); });
      child.on('close', code => { done(); resolve({ code, stdout: out, stderr: err, timedOut }); });
      child.stdin.on('error', () => { /* the process may exit before reading everything */ });
      child.stdin.end(neutralise(prompt));
    });
    if (timedOut) throw new RunError(`Claude Code did not finish within ${Math.round(timeoutMs / 1000)}s.`, stderr);
    let result = null;
    try { result = JSON.parse(stdout); } catch { /* reported below */ }
    if (code !== 0 || !result || result.is_error === true || (result.subtype && result.subtype !== 'success')) {
      const reason = result?.subtype && result.subtype !== 'success' ? ` (${result.subtype})` : '';
      throw new RunError(`Claude Code failed${reason}, exit ${code}. Details are in the bot's log.`,
        `${result?.result || ''}\n${stderr}`.trim().slice(-2000));
    }
    // As written, '' if empty: the caller decides what an empty answer means (condensing treats it as a failure).
    return { text: String(result.result || '').trim(), costUsd: result.total_cost_usd };
  } catch (error) {
    // Anything unexpected (disk full, permissions, a program that will not start) keeps its paths out of the chat.
    if (error instanceof RunError) throw error;
    throw new RunError('Claude Code could not be run on this machine. Details are in the bot\'s log.', String(error?.stack || error));
  } finally {
    if (run) { try { fs.rmSync(run, { recursive: true, force: true }); } catch { /* removed at the next start */ } }
  }
}

module.exports = { findClaude, runClaudeCode, claudeArgs, sandboxEnv, neutralise, removeStaleRuns, READ_TOOLS };
