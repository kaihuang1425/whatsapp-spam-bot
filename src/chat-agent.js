'use strict';

const { performance } = require('node:perf_hooks');
const { normalizeCall } = require('./chats');
const { cleanText, stripLinksAndNumbers } = require('./items');

const MAX_MESSAGE = 1200;
const MAX_EVENTS = 20;
const MAX_CHATS = 32;
const MAX_AGE_SECONDS = 120;

function agentText(text, max) {
  return cleanText(stripLinksAndNumbers(String(text ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b(?:github_pat_|gh[pousr]_|sk-ant-|sk-proj-|AIza)[\w-]{12,}\b/g, '[secret]')
    .replace(/@\S+/g, '[mention]')), max);
}

function repoQuestion(text) {
  const question = normalizeCall(text).toLowerCase().replace(/’/g, "'").replace(/[?!.,]+$/, '').trim();
  const list = /^(?:what(?:'s| is| are)|which|list|show(?: me)?) (?:the )?(?:open (?:github )?|github(?:'s)? open )(issues|pull requests|prs)(?: (?:in|on) (?:the )?(?:repo|repository|github))?$/.exec(question);
  const open = /^(?:what|which) (?:github )?(issues|pull requests|prs) are (?:still )?open$/.exec(question);
  if (list || open) return { kind: (list || open)[1] === 'issues' ? 'issues' : 'pulls' };
  if (/^what(?:'s| is) open on github$/.test(question)) return { kind: 'issues' };
  if (/^what(?:'s| is) open for me(?: on github)?$/.test(question)) return { kind: 'assigned' };
  const status = /^(?:what(?:'s| is) (?:the )?(?:status (?:of|on) )?|is |show(?: me)? )(?:github )?(issue|pull request|pr) #?([1-9]\d{0,6})(?: (?:still )?open| closed| merged)?$/.exec(question);
  return status ? { kind: status[1] === 'issue' ? 'issue' : 'pull', number: Number(status[2]) } : null;
}

function addressedText(text, buzzword) {
  const alias = normalizeCall(buzzword).replace(/^[!@]/, '');
  if (!alias) return null;
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mention = new RegExp(`(^|[\\s,(])@${escaped}(?=$|[\\s),:!?]|\\.(?:$|\\s))`, 'iu');
  const body = normalizeCall(text);
  if (!mention.test(body)) return null;
  return body.replace(mention, '$1').replace(/^[\s,:.!?]+/, '').trim();
}

function issueUpdate(text) {
  const line = normalizeCall(text);
  const match = /^(?:issue\s+)?#([1-9]\d{0,6})\s*:?\s*(?:(?:is )?(done|fixed|completed|reopen(?:ed)?)\.?|progress:\s+(.+))$/i.exec(line);
  if (!match) return null;
  const number = Number(match[1]);
  if (match[3]) {
    const body = agentText(match[3], 500);
    return body ? { action: 'comment', number, body } : null;
  }
  return { action: /^reopen/i.test(match[2]) ? 'reopen' : 'close', number };
}

function taskHint(text) {
  return !/^\[(?:claude|codex|bot)\]/i.test(text) && !issueUpdate(text) &&
    /\b(?:i(?:['’]ll| will)|we (?:need to|must|decided to|will)|please|blocked by)\b|\b(?:bug|blocker|deadline):|需要|我會|截止/u.test(text.toLowerCase());
}

// Retain only fresh text from active chats. A busy chat does not queue a second network run.
function createBurstQueue(run, { quietMs = 2000, maxMs = 10000, clock = () => performance.now() } = {}) {
  const pending = new Map();
  const busy = new Set();
  let closed = false;

  function offer(policy, event, interested) {
    if (closed || busy.has(policy.id)) return;
    let batch = pending.get(policy.id);
    if (batch?.policy !== policy) {
      if (batch) clearTimeout(batch.timer);
      pending.delete(policy.id);
      batch = null;
    }
    if (!batch) {
      if (pending.size + busy.size >= MAX_CHATS) return;
      batch = { policy, end: clock() + maxMs, events: [], interested: false };
      pending.set(policy.id, batch);
    }
    batch.events.push(event);
    batch.interested ||= interested;
    if (batch.events.length > MAX_EVENTS) batch.events.shift();
    clearTimeout(batch.timer);
    batch.timer = setTimeout(async () => {
      pending.delete(policy.id);
      if (!batch.interested) return;
      busy.add(policy.id);
      try { await run(policy, batch.events); } finally { busy.delete(policy.id); }
    }, Math.max(0, Math.min(quietMs, batch.end - clock())));
    batch.timer.unref();
  }

  function close() {
    closed = true;
    for (const batch of pending.values()) clearTimeout(batch.timer);
    pending.clear();
  }

  return { offer, close };
}

module.exports = { MAX_MESSAGE, MAX_AGE_SECONDS, agentText, repoQuestion, addressedText, issueUpdate, taskHint, createBurstQueue };
