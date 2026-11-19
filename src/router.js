'use strict';

// Routes every message the linked account sees (including your own, so you can call the bot from your phone)
// through the per-chat policy: archive if receive is on, moderate if spam handling is on, answer the buzzword
// if send is on. Nothing is sent to a chat whose policy says send: false.

const { resumeCommand } = require('./hints');
const { matchBuzzword, terminalText } = require('./chats');
const { createSendGuard } = require('./send-guard');
const { reservedDiscovery } = require('./discovery');
const { MAX_MESSAGE, MAX_AGE_SECONDS, repoQuestion, addressedText, issueUpdate, taskHint, createBurstQueue } = require('./chat-agent');

function createRouter({ getPolicies, getConfig, archive, moderate, commands, replyGate, admin = null, log = console.log,
  onError = console.error, startedAt = Date.now(), discover = null, sendGuard = createSendGuard(), loadMedia = null,
  burstTiming, clock = Date.now }) {
  const seen = new Map();
  const sent = new Map();
  const noticed = new Set();
  const calls = new Set();
  let queue = Promise.resolve();
  let agentClosed = false;
  const bursts = createBurstQueue((policy, events) => detach(() => answerBurst(policy, events), true), burstTiming);

  function recordSent(chatId, message) {
    const id = message?.id?._serialized;
    if (!id) return;
    sent.set(id, { chatId, time: clock() });
    if (sent.size > 1000) sent.delete(sent.keys().next().value);
  }

  function revoke(message) {
    const id = message?.id?._serialized;
    if (!id) return;
    seen.set(id, false);
    if (seen.size > 10000) seen.delete(seen.keys().next().value);
    sent.delete(id);
  }

  function canAct(policy, event) {
    const { message } = event;
    const age = clock() / 1000 - message.timestamp;
    return !agentClosed && age >= -5 && age <= MAX_AGE_SECONDS &&
      seen.get(message.id._serialized) === true && getPolicies().get(policy.id) === policy &&
      policy.receive && policy.send && sendGuard.canWarn(policy.id) &&
      (policy.callers === 'anyone' || message.fromMe === true);
  }

  function offerAgent(policy, message, text, addressed = false) {
    if (typeof commands.agent !== 'function' || (!policy.assistant && !policy.githubAutoIssues) ||
        !text || text.length > MAX_MESSAGE) return;
    const event = { message, text, addressed };
    if (!canAct(policy, event)) return;
    const canRead = Boolean(policy.githubRepo && (message.fromMe === true || policy.githubMembers === true));
    const reply = policy.assistant && (addressed || (canRead && repoQuestion(text)) ||
      (sent.size > 0 && message.hasQuotedMsg));
    const track = policy.githubAutoIssues && canRead &&
      ((message.fromMe === true && issueUpdate(text)) || (policy.ai && taskHint(text)));
    bursts.offer(policy, event, reply || track);
  }

  async function answerBurst(policy, events) {
    const allowed = event => canAct(policy, event) && replyGate.canReserve(policy.id, event.message.id._serialized);
    const active = events.filter(allowed);
    if (!active.length) return;
    let trigger = null;
    if (policy.assistant) {
      let checked = 0;
      for (const event of active.toReversed()) {
        const { message, addressed, text } = event;
        const canRead = Boolean(policy.githubRepo && (message.fromMe === true || policy.githubMembers === true));
        const repo = canRead ? repoQuestion(text) : null;
        let quotedId = null;
        if (!addressed && !repo && message.hasQuotedMsg && sent.size && checked++ < 3) {
          const quoted = await Promise.resolve().then(() => message.getQuotedMessage?.()).catch(() => null);
          const post = sent.get(quoted?.id?._serialized);
          if (quoted?.fromMe === true && post?.chatId === policy.id && clock() - post.time <= 86400000) quotedId = quoted.id._serialized;
        }
        if ((addressed || repo || quotedId) && allowed(event)) { trigger = { event, repo, quotedId }; break; }
      }
    }
    const stillAllowed = event => allowed(event) &&
      (trigger?.event !== event || !trigger.quotedId || sent.get(trigger.quotedId)?.chatId === policy.id);
    const result = await commands.agent(policy, { events: active, trigger, canAct: stillAllowed });
    if (result && stillAllowed(result.event)) await send(policy, result.event.message, result.text, true);
  }

  // reply: text, or { text, file } from a chat's own hub; the file goes out as a document with the text as caption.
  async function send(callPolicy, message, reply, automatic = false) {
    const { text, file = null } = typeof reply === 'string' ? { text: reply } : reply;
    const config = getConfig();
    const body = `${config.replyPrefix} ${text}`;
    // Settings may have been reloaded while a slow command ran; the current ones decide.
    const policy = getPolicies().get(callPolicy.id) || { ...callPolicy, receive: false, send: false };
    if (automatic && (!canAct(callPolicy, { message }) || [...body].length >= 1500)) return null;
    if (!policy.receive || !policy.send) {
      log(terminalText(`[NOT SENT] send is off for ${policy.label || policy.id}; reply would have been: ${text.split('\n').join(' | ')}`));
      return null;
    }
    if (!sendGuard.canReply(message, policy)) return null;
    // Read the file before anything is reserved or sent: a file that cannot be read here is this machine's
    // problem, not WhatsApp's, so it must not pause the bot's replies everywhere.
    let media = null;
    if (file) {
      try {
        if (!loadMedia) throw new Error('sending files is not available');
        media = await loadMedia(file);
      } catch (error) {
        onError(`[NOT SENT] could not read a hub file for ${policy.label || policy.id}: ${error.message}`);
        return null;
      }
    }
    if (!replyGate.reserve(policy.id, automatic ? message.id._serialized : undefined)) {
      if (!automatic) log(terminalText(`[NOT SENT] reply budget or pause in effect for ${policy.label || policy.id}; reply would have been: ${text.split('\n').join(' | ')}`));
      return null;
    }
    try {
      let reply;
      if (media) {
        reply = await message.reply(media, undefined, { caption: body, sendMediaAsDocument: true, sendSeen: false, ignoreQuoteErrors: true });
      } else {
        reply = await message.reply(body, undefined, { linkPreview: false, sendSeen: false, ignoreQuoteErrors: !automatic });
      }
      sendGuard.replied(message, policy);
      recordSent(policy.id, reply);
      if (automatic) log('[SENT] Chat assistant reply.');
      else log(terminalText(`[SENT] ${file ? 'file' : 'reply'} in ${policy.label || policy.id}: ${text.split('\n')[0]}`));
      return reply;
    } catch (error) {
      try { replyGate.pause('SEND_FAILURE'); }
      catch (pauseError) { onError(`Could not persist reply pause: ${pauseError.message}`); }
      onError(`Reply failed; further replies are paused. Check the phone app, then ${resumeCommand()}.${automatic ? '' : ` ${error.message}`}`);
      return null;
    }
  }

  // Owner commands: only from the owner's own account, whatever "callers" says, and they never post in the chat.
  //   spam / spam kick / kick / trust / untrust  -> as a reply to someone else's message in this chat
  //   lock [minutes] / unlock                    -> in a group
  // Runs inside the message queue up to the point where later messages depend on it (what was marked or trusted);
  // slow WhatsApp actions (waiting for a removal to be confirmed, locking) continue outside it.
  async function ownerCommand(command, policy, message) {
    const where = policy.label || policy.id;
    const [name, arg] = command.split(/\s+/);
    if (!message.fromMe) {
      log(terminalText(`[IGNORED] ${where}: only you can use "${policy.buzzword} ${name}"`));
      return;
    }
    if (name === 'lock' || name === 'unlock') {
      if (!admin) return log(terminalText(`[ADMIN] ${where}: admin actions are not available`));
      detach(() => admin.setLocked(policy, name === 'lock', Number(arg) || 0));
      return;
    }
    const quoted = message.hasQuotedMsg && typeof message.getQuotedMessage === 'function' ? await message.getQuotedMessage() : null;
    if (!quoted || quoted.fromMe) {
      log(terminalText(`[${name.toUpperCase()}] ${where}: reply to someone else's message with "${policy.buzzword} ${command}"`));
      return;
    }
    // A reply can quote a message from another chat ("Reply privately"); only this chat's messages count here.
    if (quoted.from !== policy.id) {
      log(terminalText(`[${name.toUpperCase()}] ${where}: the quoted message is from another chat; use the command in that chat instead`));
      return;
    }
    if (name === 'spam') {
      if (typeof moderate.markSpam !== 'function') return;
      revoke(quoted);
      // Queued now, ahead of the next message, so a copy arriving straight after is checked against what was learned.
      const marking = moderate.markSpam(quoted);
      detach(async () => {
        reportMarked(policy, quoted, await marking);
        if (arg === 'kick' && admin) await admin.kick(policy, quoted);
      });
      return;
    }
    if (!admin) return log(terminalText(`[ADMIN] ${where}: admin actions are not available`));
    if (name === 'kick') detach(() => admin.kick(policy, quoted));
    else if (name === 'trust') await admin.trust(policy, quoted);
    else if (name === 'untrust') await admin.untrust(policy, quoted);
  }

  // The owner marked the quoted message: it was learned and removal was attempted.
  function reportMarked(policy, quoted, outcome) {
    const where = policy.label || policy.id;
    try { archive.revoke(policy.id, quoted.id?.id || quoted.id?._serialized); } catch { /* best effort */ }
    const learned = outcome.learned || {};
    const learnt = [learned.text ? 'its text' : null, learned.links?.length ? `link(s) ${learned.links.join(', ')}` : null]
      .filter(Boolean).join(' and ') || 'nothing new (already known, or too short to learn safely)';
    const skipped = learned.skippedLinks?.length ? `; not learned (whole sites): ${learned.skippedLinks.join(', ')}` : '';
    log(terminalText(`[MARKED] ${where}: learned ${learnt}${skipped}; removal ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}`));
  }

  // A message the library could not read used to vanish without a word, which hid the July 2026 WhatsApp Web
  // ID rename. Say so once per run.
  let warnedUnreadable = false;
  function unreadable(what) {
    if (warnedUnreadable) return;
    warnedUnreadable = true;
    onError(`[WARNING] A WhatsApp message arrived without a readable ${what} and was ignored. If the bot never ` +
      'responds, WhatsApp Web has probably changed and the whatsapp-web.js library needs an update. Not repeated this run.');
  }

  async function handle(message) {
    if (!message || message.isStatus || message.broadcast) return;
    // Drop startup history and anything replayed after a reconnect, before judging whether a message is readable.
    if (!Number.isFinite(message.timestamp) || message.timestamp * 1000 < startedAt - 2000) return;
    if (!message.id?._serialized) return unreadable('ID');
    const chatId = message.fromMe ? message.to : message.from;
    if (chatId === 'status@broadcast') return;
    if (typeof chatId !== 'string') return unreadable('chat ID');
    const id = message.id._serialized;
    if (seen.has(id)) return;
    seen.set(id, true);
    if (seen.size > 10000) seen.delete(seen.keys().next().value);

    const config = getConfig();
    // Echoes and exact owner discovery are handled before the allowlist; other messages follow normal policy.
    if (message.fromMe && (sent.has(id) || String(message.body || '').startsWith(config.replyPrefix))) return;
    if (discover && await discover(message, chatId)) return;
    const policy = getPolicies().get(chatId);
    if (!policy || !policy.receive) {
      if (!policy && config.logOtherChats && !noticed.has(chatId)) {
        noticed.add(chatId);
        log(terminalText(`· activity in a chat that is not set up: ${chatId} (run CHOOSE-CHATS.cmd to choose what the bot may do there)`));
      }
      return;
    }

    const result = message.fromMe ? null : await moderate(message);
    // Flagged spam stays out of the archive, so it never reaches transcripts or summaries.
    if (config.archive.enabled && policy.archive && !result?.isSpam) {
      try { archive.append(message, chatId); }
      catch (error) { onError(`Archive write failed: ${error.message}`); }
    }
    if (result?.isSpam) return; // never take commands from a message that was just flagged
    // Reserved discovery phrases suppress only commands, after normal moderation and archiving.
    if (reservedDiscovery(message.body, config.discoveryPhrase)) return;

    // The bot's own replies come back as your messages; never treat them as calls.
    if (message.fromMe && (sent.has(id) || String(message.body || '').startsWith(config.replyPrefix))) return;
    if (message.type !== 'chat') return;
    const rest = matchBuzzword(message.body, policy.buzzword);
    if (rest === null) {
      const body = String(message.body || '').trim();
      const named = policy.assistant && body.length <= MAX_MESSAGE ? addressedText(body, policy.buzzword) : null;
      offerAgent(policy, message, named ?? body, named !== null);
      return;
    }
    // Owner commands must match exactly: with a word-like buzzword, "hey, spam again?" or "hey kick off at 3" is talk.
    const owner = /^(spam kick|spam|kick|trust|untrust|unlock|lock(?: \d{1,4})?)[.!]?$/i.exec(rest.replace(/\s+/g, ' '));
    if (owner) return ownerCommand(owner[1].toLowerCase(), policy, message);
    if (/^(spam|kick|trust|untrust|lock|unlock)\b/i.test(rest)) {
      // Close to an owner command ("kick him", "lock 30 min"): never answer it in the chat; tell the owner why.
      if (message.fromMe) log(terminalText(`[ADMIN] ${policy.label || policy.id}: not run; send exactly "${policy.buzzword} kick", "${policy.buzzword} lock 30" etc.`));
      return;
    }
    if (policy.callers === 'me' && !message.fromMe) {
      log(terminalText(`[IGNORED] ${policy.label || policy.id}: buzzword from someone else, but callers is "me"`));
      return;
    }
    if (!message.fromMe && !sendGuard.canReply(message, policy)) return;
    if (!policy.assistant) log(terminalText(`[CALL] ${policy.label || policy.id}: ${policy.buzzword} ${rest}`.trim()));
    detach(async () => {
      let reply;
      const onUnknown = policy.assistant ? () => offerAgent(policy, message, rest, true) : null;
      try { reply = await commands(policy, rest, { fromMe: Boolean(message.fromMe), message, onUnknown }); }
      catch (error) { reply = `Sorry, that failed: ${error.message}`; }
      if (reply) await send(policy, message, reply);
    });
  }

  function detach(work, automatic = false) {
    const call = Promise.resolve().then(work).catch(error => onError(automatic ? '[ASSISTANT] The burst failed.' : `Command failed: ${error.message}`));
    calls.add(call);
    void call.finally(() => calls.delete(call));
    return call;
  }

  function route(message) {
    const pending = queue.then(() => handle(message));
    queue = pending.catch(error => onError(`Message routing failed: ${error.message}`));
    return pending;
  }

  route.recordSent = recordSent;
  route.revoke = revoke;
  route.close = () => { agentClosed = true; bursts.close(); };
  route.policyFor = chatId => getPolicies().get(chatId);
  route.idle = async () => { await queue; await Promise.all([...calls]); };
  return route;
}

module.exports = { createRouter };
