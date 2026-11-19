'use strict';

// Reminders and open items in a chat: the remind, issue, issues, keep, drop and done commands, and the timer that
// posts reminders when they are due. A reminder is the one thing the bot posts without a command at that moment.
// Each was set by a command in that chat (or kept there from a suggestion), it quotes that command when it is
// posted, and it goes through the same send setting, reply budget and pauses as replies do, plus its own limits:
// reminders.maxRemindersPerChatPerHour per chat, and at most half of replies.maxPerHour across all chats.

const { parseWhen, formatWhen, zoneLabel, DAY } = require('./when');
const { cleanText, hasLink } = require('./items');
const { resumeCommand } = require('./hints');
const { terminalText } = require('./chats');

const MAX_LISTED = 20;
const HOUR = 3600000;

function usage(word) {
  return `Usage: ${word} remind <when> <what>, for example ${word} remind Fri 17:00 submit report, ` +
    `${word} remind tomorrow 9am call mum, ${word} remind 20 Nov 14:30 dentist or ${word} remind in 2 hours check the oven.`;
}

function describe(item, config, now) {
  const at = ms => formatWhen(ms, config.reminders.timeZone, now);
  const parts = [];
  if (item.due) parts.push(`due ${at(item.due)}`);
  if (item.remindAt) {
    if (item.sendFailedAt) parts.push(`reminder ${at(item.remindAt)} may not have been posted: sending failed`);
    else if (item.firedAt) parts.push(`reminded ${at(item.remindAt)}`);
    else if (item.missedAt) parts.push(`reminder ${at(item.remindAt)} not posted: the bot was off, paused or out of budget too long`);
    else parts.push(`reminder ${at(item.remindAt)}`);
  }
  if (item.githubIssue) parts.push(`GitHub #${item.githubIssue}`);
  return `${item.n}. ${item.text}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

// The chat's open items and the AI's suggestions, as the "issues" command and the CLI show them. github: also
// point at "github issue N" for the suggestions (the chat has a repository and the asker may use it).
function listText(items, policy, config, now, { github = false } = {}) {
  const { open, suggested } = items.active(policy.id);
  const word = policy.buzzword || '<buzzword>';
  if (!open.length && !suggested.length) return `No open items. Add one with ${word} remind <when> <what> or ${word} issue <what>.`;
  const lines = [];
  const section = (title, list) => {
    lines.push(title, ...list.slice(0, MAX_LISTED).map(item => describe(item, config, now)));
    if (list.length > MAX_LISTED) lines.push(`...and ${list.length - MAX_LISTED} more`);
  };
  if (open.length) section(`Open (${open.length}):`, open);
  if (suggested.length) {
    section(`Spotted in messages by the AI, not kept yet (${suggested.length}). ${word} keep N [when]` +
      `${github ? `, ${word} github issue N` : ''} or ${word} drop N:`, suggested);
  }
  lines.push(`Close an item with ${word} done N. Times are ${zoneLabel(config.reminders.timeZone)}.`);
  return lines.join('\n');
}

// A kept suggestion with a deadline is reminded leadHours before it, or an hour before if that is too soon.
function defaultReminder(due, config, now) {
  if (!due) return null;
  for (const before of [config.reminders.leadHours * HOUR, HOUR]) if (due - before > now + 60000) return due - before;
  return null;
}

function createItemCommands({ items, getConfig, clock = Date.now }) {
  const zone = config => zoneLabel(config.reminders.timeZone);

  // A reminder time typed after "remind" or "keep N": in the future and within maxDaysAhead.
  function reminderTime(text, config, now) {
    const parsed = parseWhen(text, { now, timeZone: config.reminders.timeZone, defaultHour: config.reminders.defaultHour });
    if (parsed.error) return parsed;
    if (parsed.at <= now + 30000) return { error: `That time has already passed (${zone(config)}).` };
    if (parsed.at > now + config.reminders.maxDaysAhead * DAY) return { error: `Reminders can be at most ${config.reminders.maxDaysAhead} days ahead.` };
    return parsed;
  }

  function number(text) {
    const match = /^#?(\d{1,6})(?:\s+|$)/.exec(text);
    return match ? { n: Number(match[1]), rest: text.slice(match[0].length).trim() } : null;
  }

  return {
    remind(policy, text, fromMe, message) {
      const config = getConfig(), now = clock();
      // Without send, a reminder could never be posted here.
      if (!policy.send) return 'Send is off for this chat, so the bot cannot post reminders here.';
      if (!text) return usage(policy.buzzword);
      const parsed = reminderTime(text, config, now);
      if (parsed.error) return `${parsed.error}\n${usage(policy.buzzword)}`;
      const what = cleanText(parsed.text, config.reminders.maxTextChars);
      if (!what) return `Say what to remind about after the time.\n${usage(policy.buzzword)}`;
      // A reminder is posted later from the owner's account: no links from anyone else.
      if (!fromMe && hasLink(what)) return 'Links cannot go in reminders. Leave the link out, or post it in the chat.';
      const result = items.add(policy.id, { text: what, by: fromMe ? 'owner' : 'member', now, remindAt: parsed.at,
        source: message?.id?._serialized || null, settings: config.reminders });
      if (result.error) return result.error;
      return `Reminder ${result.item.n} set for ${formatWhen(parsed.at, config.reminders.timeZone, now)} (${zone(config)}): ${what}`;
    },

    issue(policy, text, fromMe) {
      const config = getConfig(), now = clock();
      const what = cleanText(text, config.reminders.maxTextChars);
      if (!what) return `Usage: ${policy.buzzword} issue <what needs doing>. For a time as well, use ${policy.buzzword} remind <when> <what>.`;
      const result = items.add(policy.id, { text: what, by: fromMe ? 'owner' : 'member', now, settings: config.reminders });
      if (result.error) return result.error;
      return `Added ${result.item.n}: ${what}. Close it with ${policy.buzzword} done ${result.item.n}.`;
    },

    // Tidied first, so a suggestion whose deadline has just passed is not listed any more.
    list(policy, { github = false } = {}) {
      const config = getConfig(), now = clock();
      items.purge(policy.id, now, config.reminders);
      return listText(items, policy, config, now, { github });
    },

    keep(policy, text, message) {
      const config = getConfig(), now = clock();
      const target = number(text);
      if (!target) return `Usage: ${policy.buzzword} keep N [when], with N from ${policy.buzzword} issues.`;
      const { open, suggested } = items.active(policy.id);
      const item = [...open, ...suggested].find(x => x.n === target.n);
      if (!item) return `There is no open or suggested item ${target.n}. ${policy.buzzword} issues lists them.`;
      let remindAt;
      if (target.rest) {
        const parsed = reminderTime(target.rest, config, now);
        if (parsed.error) return parsed.error;
        if (parsed.text) return `Only a time can follow the number, for example ${policy.buzzword} keep ${target.n} Fri 9am.`;
        remindAt = parsed.at;
      } else if (item.status === 'open') {
        return `Item ${item.n} is already open. To set a reminder: ${policy.buzzword} keep ${item.n} <when>.`;
      } else {
        remindAt = defaultReminder(item.due, config, now);
      }
      const result = items.keep(policy.id, target.n, { remindAt, source: message?.id?._serialized || null, now, settings: config.reminders });
      if (result.error) return result.error;
      const kept = result.item;
      const reminder = kept.remindAt ? `Reminder ${formatWhen(kept.remindAt, config.reminders.timeZone, now)} (${zone(config)}).`
        : `No reminder; set one with ${policy.buzzword} keep ${kept.n} <when>.`;
      return `Kept ${kept.n}: ${kept.text}. ${reminder}`;
    },

    close(policy, text, status) {
      const target = number(text);
      if (!target || target.rest) return `Usage: ${policy.buzzword} ${status === 'done' ? 'done' : 'drop'} N, with N from ${policy.buzzword} issues.`;
      const result = items.close(policy.id, target.n, status, clock());
      if (result.error) return result.error;
      return `${status === 'done' ? 'Done' : 'Dropped'}: ${result.item.n}. ${result.item.text}`;
    }
  };
}

// The timer is cleared as soon as the send settles. It is deliberately not unref'd: a send that never settles must
// still end in a timeout, even if nothing else is keeping the process busy.
function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`WhatsApp did not confirm the message within ${Math.round(ms / 1000)} seconds`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Posts due reminders. Called every few seconds by the bot; one call at a time, and a send that never settles is
// treated as a failed send after sendTimeoutMs. replyLimits: the reply budget's settings as the gate was made with
// (fixed at start, like the gate itself).
function createReminderRunner({ items, getPolicies, getConfig, replyGate, sendText, replyLimits = null, clock = Date.now,
  log = console.log, onError = console.error, sendTimeoutMs = 90000 }) {
  let running = false;
  let turn = 0;
  const said = new Set(); // waiting, unreadable and unwritable notices already logged this run
  const once = (key, line, write = log) => { if (!said.has(key)) { said.add(key); write(terminalText(line)); } };

  return async function tick() {
    if (running) return 0;
    running = true;
    let posted = 0;
    try {
      const config = getConfig();
      const settings = config.reminders;
      const now = clock();
      const at = ms => formatWhen(ms, settings.timeZone, now);
      const chats = [...getPolicies().values()];
      // Posts of the last hour, from the lists themselves, so a restart does not reset the limits.
      const postedIn = chatId => { try { return items.postedSince(chatId, now - HOUR); } catch { return 0; } };
      let postedThisHour = chats.reduce((sum, chat) => sum + postedIn(chat.id), 0);
      const share = Math.max(1, Math.floor((replyLimits || config.replies).maxPerHour / 2));
      // Each call starts with the next chat in turn, so a busy chat early in the list cannot hold the others up.
      const start = chats.length ? turn++ % chats.length : 0;
      for (const listed of [...chats.slice(start), ...chats.slice(0, start)]) {
        if (!listed.receive || !listed.send) continue;
        const where = listed.label || listed.id;
        let due;
        try { due = items.due(listed.id, now); }
        catch (error) { once(`unreadable:${listed.id}`, `Reminders for ${where} not read: ${error.message}`, onError); continue; }
        for (const item of due) {
          // After a long stop, pause or wait, an old reminder would only confuse: it stays on the list, unposted.
          if (now - item.remindAt > settings.lateGraceHours * HOUR) {
            if (items.claim(listed.id, item.n, item.remindAt, 'missedAt', now)) {
              log(terminalText(`[REMINDER] ${where}: reminder ${item.n} was due ${at(item.remindAt)}, more than ` +
                `${settings.lateGraceHours}h ago; not posted, still on the list.`));
            }
            continue;
          }
          // Settings may have been reloaded meanwhile; the current ones decide.
          const policy = getPolicies().get(listed.id);
          if (!policy?.receive || !policy.send) break;
          if (replyGate.paused) return posted;
          if (postedIn(policy.id) >= settings.maxRemindersPerChatPerHour) {
            once(`chat:${policy.id}:${item.n}`, `[REMINDER] ${where}: reminder ${item.n} waits; ${settings.maxRemindersPerChatPerHour} reminders an hour per chat.`);
            break;
          }
          // Half of the hourly reply budget stays for replies to commands.
          if (postedThisHour >= share) {
            once(`all:${policy.id}:${item.n}`, `[REMINDER] ${where}: reminder ${item.n} waits; reminders may use half of the hourly reply budget.`);
            return posted;
          }
          if (!replyGate.canReserve(policy.id)) break; // spacing or budget: the next call tries again
          // Claimed before the reply slot is taken and before sending: a crash can never post it twice, a drop, done
          // or new time that came in meanwhile wins, and a list that cannot be written uses up no budget.
          let claimed;
          try { claimed = items.claim(policy.id, item.n, item.remindAt, 'firedAt', now); }
          catch (error) { once(`unwritable:${policy.id}`, `Reminders for ${where} not posted: ${error.message}`, onError); break; }
          if (!claimed) continue;
          if (!replyGate.reserve(policy.id)) { items.unclaim(policy.id, claimed.n); break; }
          postedThisHour++;
          const deadline = claimed.due ? ` (due ${at(claimed.due)})` : '';
          const body = `${config.replyPrefix} Reminder ${claimed.n}: ${claimed.text}${deadline}. When it is finished: ${policy.buzzword} done ${claimed.n}`;
          try {
            await withTimeout(Promise.resolve().then(() => sendText(policy.id, body, { quotedMessageId: claimed.source || undefined })), sendTimeoutMs);
            posted++;
            log(terminalText(`[SENT] reminder ${claimed.n} in ${where}: ${claimed.text}`));
          } catch (error) {
            // Not retried (replies are paused now), and listed as possibly not posted.
            try { items.mark(policy.id, claimed.n, 'sendFailedAt', clock()); } catch { /* the error below says enough */ }
            try { replyGate.pause('SEND_FAILURE'); }
            catch (pauseError) { onError(`Could not persist reply pause: ${pauseError.message}`); }
            onError(terminalText(`Reminder ${claimed.n} in ${where} failed; further replies are paused. Check the phone app, then ` +
              `${resumeCommand()}. ${error.message}`));
            return posted;
          }
        }
      }
    } finally { running = false; }
    return posted;
  };
}

module.exports = { createItemCommands, createReminderRunner, listText, defaultReminder };
