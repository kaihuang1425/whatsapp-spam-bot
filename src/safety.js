'use strict';

const { resumeCommand } = require('./hints');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function emptyState() {
  return { connectionPause: null, warningPause: null, warningAttempts: [], deletionPause: null, deletionAttempts: [],
    replyPause: null, replyAttempts: [], adminPause: null, adminAttempts: [],
    aiAttempts: [], aiStats: { allowed: 0, blocked: 0, reasons: {} }, agentWrites: [] };
}

function validateState(state) {
  if (!state || !Array.isArray(state.warningAttempts) ||
      ![state.connectionPause, state.warningPause].every(x => x === null || (typeof x?.reason === 'string' && Number.isFinite(x.time))) ||
      !state.warningAttempts.every(x => Number.isFinite(x.time) && typeof x.group === 'string' && typeof x.sender === 'string')) {
    throw new Error('Safety state is invalid. Inspect .runtime/safety.json before reconnecting; do not delete it to bypass a warning.');
  }
  // Add the new fields to older valid state without resetting existing budgets.
  if (!Object.hasOwn(state, 'deletionPause')) state.deletionPause = null;
  if (!Object.hasOwn(state, 'deletionAttempts')) state.deletionAttempts = [];
  if (!(state.deletionPause === null || (typeof state.deletionPause?.reason === 'string' && Number.isFinite(state.deletionPause.time))) ||
      !Array.isArray(state.deletionAttempts) || !state.deletionAttempts.every(x =>
        Number.isFinite(x.time) && typeof x.group === 'string' && typeof x.message === 'string')) {
    throw new Error('Safety state is invalid. Inspect deletion state before restarting.');
  }
  if (!Object.hasOwn(state, 'replyPause')) state.replyPause = null;
  if (!Object.hasOwn(state, 'replyAttempts')) state.replyAttempts = [];
  if (!(state.replyPause === null || (typeof state.replyPause?.reason === 'string' && Number.isFinite(state.replyPause.time))) ||
      !Array.isArray(state.replyAttempts) || !state.replyAttempts.every(x => Number.isFinite(x.time) && typeof x.chat === 'string' &&
        (x.message === undefined || (typeof x.message === 'string' && /^[a-f0-9]{64}$/.test(x.message))))) {
    throw new Error('Safety state is invalid. Inspect reply state before restarting.');
  }
  if (!Object.hasOwn(state, 'adminPause')) state.adminPause = null;
  if (!Object.hasOwn(state, 'adminAttempts')) state.adminAttempts = [];
  if (!(state.adminPause === null || (typeof state.adminPause?.reason === 'string' && Number.isFinite(state.adminPause.time))) ||
      !Array.isArray(state.adminAttempts) || !state.adminAttempts.every(x => Number.isFinite(x.time) && typeof x.chat === 'string' && typeof x.action === 'string')) {
    throw new Error('Safety state is invalid. Inspect admin-action state before restarting.');
  }
  if (!Object.hasOwn(state, 'aiAttempts')) state.aiAttempts = [];
  if (!Object.hasOwn(state, 'aiStats')) state.aiStats = { allowed: 0, blocked: 0, reasons: {} };
  const count = x => Number.isSafeInteger(x) && x >= 0;
  if (!Array.isArray(state.aiAttempts) || !state.aiAttempts.every(x => Number.isFinite(x.time) && typeof x.chat === 'string') ||
      !count(state.aiStats?.allowed) || !count(state.aiStats?.blocked) || !state.aiStats.reasons ||
      typeof state.aiStats.reasons !== 'object' || Array.isArray(state.aiStats.reasons) || !Object.values(state.aiStats.reasons).every(count)) {
    throw new Error('Safety state is invalid. Inspect AI budget and counters before restarting.');
  }
  if (!Object.hasOwn(state, 'agentWrites')) state.agentWrites = [];
  if (!Array.isArray(state.agentWrites) || !state.agentWrites.every(entry =>
    Number.isFinite(entry?.time) && /^[a-f0-9]{64}$/.test(entry?.key))) {
    throw new Error('Safety state is invalid. Inspect chat assistant writes before restarting.');
  }
  return state;
}

// Reserve before the request. An ambiguous GitHub result must never be retried automatically.
function createAgentWriteGate({ state, save, clock = Date.now }) {
  return (repo, chatId, messageId, title) => {
    const now = clock();
    const hash = fields => createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    const keys = [hash([repo.toLowerCase(), chatId, messageId])];
    if (title) keys.push(hash([repo.toLowerCase(), title.toLowerCase()]));
    const recent = state.agentWrites.filter(entry => entry.time > now - 86400000);
    if (recent.length + keys.length > 2048 || recent.some(entry => entry.time > now || keys.includes(entry.key))) return false;
    state.agentWrites = [...recent, ...keys.map(key => ({ key, time: now }))];
    save();
    return true;
  };
}

// The instance lock (.runtime/instance.lock) says which process on which machine holds the bot, and the holder
// refreshes its "beat" every minute. The worker and the consoles can run on different machines that share this disk
// (PythonAnywhere), and a process id means nothing on another machine: a lock from another machine counts as left
// over only once its beat is older than LOCK_STALE_MS. Locks from versions before the beat are judged by their
// process id, as they always were.
const LOCK_BEAT_MS = 60 * 1000;
const LOCK_STALE_MS = 3 * 60 * 1000;

class SafetyStore {
  constructor(directory, { clock = Date.now, pid = process.pid, isAlive = processExists, hostname = os.hostname(),
    heartbeatMs = LOCK_BEAT_MS } = {}) {
    this.directory = directory;
    this.clock = clock;
    this.pid = pid;
    this.isAlive = isAlive;
    this.hostname = hostname;
    this.heartbeatMs = heartbeatMs;
    this.timer = null;
    this.stateFile = path.join(directory, 'safety.json');
    this.lockFile = path.join(directory, 'instance.lock');
    this.token = null;
    try { this.state = validateState(JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') this.state = emptyState();
      else throw error;
    }
  }

  save() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${this.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.stateFile);
  }

  assertConnectionAllowed() {
    if (this.state.connectionPause) {
      throw new Error(`Connection paused after ${this.state.connectionPause.reason}. Check WhatsApp on your phone, then run ${resumeCommand()} before starting again.`);
    }
  }

  // Whether an existing lock was left behind: on this machine (or from an older version) when its process is gone,
  // from another machine when its beat is older than LOCK_STALE_MS.
  lockIsStale(lock) {
    if (lock.host && lock.host !== this.hostname) return !(Number.isFinite(lock.beat) && this.clock() - lock.beat <= LOCK_STALE_MS);
    return !this.isAlive(lock.pid);
  }

  describeLock(lock) {
    if (!lock.host) return `process ${lock.pid}`;
    const ago = Number.isFinite(lock.beat) ? `, last sign of life ${Math.max(0, Math.round((this.clock() - lock.beat) / 1000))}s ago` : '';
    return `process ${lock.pid} on ${lock.host}${ago}`;
  }

  acquire({ purpose = 'worker' } = {}) {
    this.assertConnectionAllowed();
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    let fd;
    try { fd = fs.openSync(this.lockFile, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lock = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
      if (lock.purpose === 'summary' && Number.isSafeInteger(lock.pid) && lock.pid > 0 &&
          typeof lock.token === 'string' && this.lockIsStale(lock)) {
        fs.unlinkSync(this.lockFile);
        return this.acquire({ purpose });
      }
      throw new Error(`A bot instance lock already exists (${this.describeLock(lock)}). Close the running bot. After a crash, check the phone app and ` +
        `run ${resumeCommand()} to clear a stale lock.`);
    }
    try {
      fs.writeFileSync(fd, JSON.stringify(this.lockRecord(token, purpose)));
      this.token = token;
      this.purpose = purpose;
    } finally { fs.closeSync(fd); }
    // The holder's sign of life for other machines; it never keeps a process running by itself.
    if (this.heartbeatMs > 0) {
      this.timer = setInterval(() => { try { this.beat(); } catch { /* the next beat tries again */ } }, this.heartbeatMs);
      this.timer.unref?.();
    }
  }

  lockRecord(token, purpose) {
    return { pid: this.pid, token, purpose, host: this.hostname, beat: this.clock() };
  }

  // Refreshes this process's lock, if it still holds it.
  beat() {
    if (!this.token) return;
    const lock = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
    if (lock.token !== this.token) return;
    const temporary = `${this.lockFile}.${this.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.lockRecord(this.token, this.purpose)), { mode: 0o600 });
    fs.renameSync(temporary, this.lockFile);
  }

  release() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.token) return;
    try {
      const lock = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
      if (lock.token === this.token) fs.unlinkSync(this.lockFile);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.token = null;
  }

  pauseConnection(reason) {
    this.state.connectionPause = { time: this.clock(), reason: String(reason).slice(0, 120) };
    this.save();
  }

  resume({ reviewed = false } = {}) {
    if (!reviewed) throw new Error(`Check the official phone app for restrictions first. Then run ${resumeCommand()}. This clears only the local pause; it cannot remove a WhatsApp restriction.`);
    try {
      const lock = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
      if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.token !== 'string') throw new Error('Invalid instance lock. Inspect .runtime/instance.lock manually.');
      if (!this.lockIsStale(lock)) {
        throw new Error(`The bot is still running (${this.describeLock(lock)}). Stop it before clearing the pause; on PythonAnywhere, ` +
          'check "python3 -B supervisor.py status". A lock from another machine counts as left over 3 minutes after its last sign of life.');
      }
      fs.unlinkSync(this.lockFile);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.state.connectionPause = null;
    this.state.warningPause = null;
    this.state.deletionPause = null;
    this.state.replyPause = null;
    this.state.adminPause = null;
    // Keep all reservations so restarting/resuming does not replenish the budget.
    this.save();
  }
}

function createWarningGate({ config, clock = Date.now, state = emptyState(), save = () => {} }) {
  validateState(state);
  function hash(value) { return createHash('sha256').update(value).digest('hex'); }

  return {
    reserve(groupId, senderId) {
      if (state.warningPause) return false;
      const now = clock();
      const group = hash(groupId);
      const sender = hash(JSON.stringify([groupId, senderId]));
      // Future timestamps are retained and block sending if the system clock moved back.
      const recent = state.warningAttempts.filter(x => x.time > now - 86400000);
      if (recent.some(x => x.time > now) || recent.length >= config.maxPerDay ||
          recent.filter(x => x.time > now - 3600000).length >= config.maxPerHour ||
          recent.some(x => now - x.time < 15000) ||
          recent.some(x => x.group === group && now - x.time < config.groupCooldownSeconds * 1000) ||
          recent.some(x => x.sender === sender && now - x.time < config.cooldownSeconds * 1000)) return false;
      state.warningAttempts = [...recent, { time: now, group, sender }];
      // Persist the reservation before network I/O, even if delivery later fails.
      save();
      return true;
    },
    pause(reason) {
      state.warningPause = { time: clock(), reason: String(reason).slice(0, 120) };
      save();
    },
    get paused() { return Boolean(state.warningPause); }
  };
}

function createDeletionGate({ config, clock = Date.now, state = emptyState(), save = () => {} }) {
  validateState(state);
  const hash = value => createHash('sha256').update(value).digest('hex');
  return {
    reserve(groupId, messageId) {
      if (state.connectionPause || state.deletionPause) return false;
      const now = clock();
      const message = hash(JSON.stringify([groupId, messageId]));
      const recent = state.deletionAttempts.filter(x => x.time > now - 86400000);
      if (recent.some(x => x.time > now || x.message === message || now - x.time < config.minIntervalSeconds * 1000) ||
          recent.length >= config.maxPerDay || recent.filter(x => x.time > now - 3600000).length >= config.maxPerHour) return false;
      state.deletionAttempts = [...recent, { time: now, group: hash(groupId), message }];
      save();
      return true;
    },
    pause(reason) {
      state.deletionPause = { time: clock(), reason: String(reason).slice(0, 120) };
      save();
    },
    get paused() { return Boolean(state.deletionPause || state.connectionPause); }
  };
}

// Budget for every message the bot sends on request (buzzword replies).
function createReplyGate({ config, clock = Date.now, state = emptyState(), save = () => {} }) {
  validateState(state);
  const hash = value => createHash('sha256').update(value).digest('hex');
  function canReserve(chatId, messageId) {
      if (state.connectionPause || state.replyPause) return false;
      const now = clock();
      const chat = hash(chatId);
      const message = messageId && hash(messageId);
      const recent = state.replyAttempts.filter(x => x.time > now - 86400000);
      if (recent.some(x => x.time > now || now - x.time < config.minIntervalSeconds * 1000) ||
          recent.some(x => x.chat === chat && ((message && x.message === message) || now - x.time < config.chatCooldownSeconds * 1000)) ||
          recent.length >= config.maxPerDay || recent.filter(x => x.time > now - 3600000).length >= config.maxPerHour) return false;
      return true;
  }
  return {
    canReserve,
    reserve(chatId, messageId) {
      if (!canReserve(chatId, messageId)) return false;
      const now = clock();
      const attempt = { time: now, chat: hash(chatId) };
      if (messageId) attempt.message = hash(messageId);
      state.replyAttempts = [...state.replyAttempts.filter(x => x.time > now - 86400000), attempt];
      save();
      return true;
    },
    pause(reason) {
      state.replyPause = { time: clock(), reason: String(reason).slice(0, 120) };
      save();
    },
    get paused() { return Boolean(state.replyPause || state.connectionPause); }
  };
}

// Budget for group admin actions (removing members, locking a group, deciding join requests). One shared budget,
// so a burst of join requests cannot hide an unusual number of removals.
function createAdminGate({ config, clock = Date.now, state = emptyState(), save = () => {} }) {
  validateState(state);
  const hash = value => createHash('sha256').update(value).digest('hex');
  return {
    reserve(chatId, action) {
      if (state.connectionPause || state.adminPause) return false;
      const now = clock();
      const recent = state.adminAttempts.filter(x => x.time > now - 86400000);
      if (recent.some(x => x.time > now || now - x.time < config.minIntervalSeconds * 1000) ||
          recent.length >= config.maxPerDay || recent.filter(x => x.time > now - 3600000).length >= config.maxPerHour) return false;
      state.adminAttempts = [...recent, { time: now, chat: hash(chatId), action: String(action) }];
      save();
      return true;
    },
    pause(reason) {
      state.adminPause = { time: clock(), reason: String(reason).slice(0, 120) };
      save();
    },
    get paused() { return Boolean(state.adminPause || state.connectionPause); }
  };
}

module.exports = { SafetyStore, createWarningGate, createDeletionGate, createReplyGate, createAdminGate, createAgentWriteGate, emptyState, LOCK_STALE_MS };
