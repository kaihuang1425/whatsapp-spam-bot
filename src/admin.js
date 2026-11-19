'use strict';

// Group admin actions, run only when the owner asks ("<buzzword> kick", "trust", "lock") or for join requests in
// chats set to "screen". Every action checks that this account is a group admin, never touches other admins, goes
// through the admin budget (src/safety.js), and is written to logs/. Nothing here posts in a chat.

const { resumeCommand } = require('./hints');
const { serialized, equivalentIds, findParticipant, phoneDigits } = require('./ids');
const { chatKind } = require('./chats');

const RETRY_UNLOCK_MS = 60000;
const UNLOCK_ATTEMPTS = 3;
const MAX_EXAMINED = 100; // requests looked at per pass; only answers count towards maxPerScan
const RECHECK_ONE_FORM_MS = 10 * 60000;

function recipients(notification) {
  return (notification?.recipientIds || []).map(serialized);
}

function createAdmin({ client, gate, members, getConfig, onRecord = () => {}, onError = console.error, clock = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  isActive = () => true, confirmMs = 10000, maxPerScan = 10 }) {
  const unlockTimers = new Map();
  const lockedByBot = new Set(); // groups this run locked itself; only those may be unlocked by a timer
  const notAdminNoted = new Set();
  const scans = new Map(); // chat id -> { again: boolean } while a join-request scan runs
  const idCache = new Map(); // id -> { ids, time }: join screening asks WhatsApp about each requester rarely
  const contactCache = new Map();
  let lastAction = -Infinity;

  async function group(chatId) {
    const chat = await client.getChatById(chatId);
    if (!chat?.isGroup || serialized(chat.id) !== chatId) throw new Error('Group identity mismatch.');
    return chat;
  }

  async function iAmAdmin(chat) {
    const me = await findParticipant(client, chat.participants, client.info?.wid);
    return Boolean(me?.isAdmin || me?.isSuperAdmin);
  }

  // Community parent and announcement groups behave differently (removal can affect the whole community).
  function unsupported(chat) {
    return ['community', 'announcements'].includes(chatKind(chat));
  }

  function record(entry) {
    const full = { event: 'admin', time: new Date(clock()).toISOString(), ...entry };
    try { onRecord(full); } catch (error) { onError(`Could not write admin log: ${error.message}`); }
    return full;
  }

  function pause(reason) {
    try { gate.pause(reason); } catch (error) { onError(`Could not persist admin pause: ${error.message}`); }
  }

  // Wait out the budget's minimum interval instead of failing on it, so an unlock right after a lock, or the next
  // group's join answers at startup, still go through. Hourly and daily caps and pauses still apply.
  async function reserve(chatId, action) {
    const wait = lastAction + getConfig().admin.minIntervalSeconds * 1000 + 250 - clock();
    if (wait > 0) await sleep(wait);
    if (!gate.reserve(chatId, action)) return false;
    lastAction = clock();
    return true;
  }

  async function idsOf(id) {
    const key = serialized(id);
    const cached = idCache.get(key);
    // An ID known in only one form is looked up again later: WhatsApp may reveal the other form by then.
    if (cached && (cached.ids.size > 1 || clock() - cached.time < RECHECK_ONE_FORM_MS)) return cached.ids;
    const ids = await equivalentIds(client, key);
    if (idCache.size >= 2000) idCache.delete(idCache.keys().next().value);
    idCache.set(key, { ids, time: clock() });
    return ids;
  }

  // Wait for WhatsApp's own "member removed" notice; the library reports success even when nobody was removed.
  function waitForRemoval(chatId, targetIds) {
    let resolve;
    let timer;
    const done = new Promise(r => { resolve = r; });
    const listener = notification => {
      if (notification?.chatId === chatId && recipients(notification).some(id => targetIds.has(id))) resolve(true);
    };
    client.on('group_leave', listener);
    return {
      start() { timer = setTimer(() => resolve(false), confirmMs); },
      result: done,
      stop() { clearTimer(timer); client.removeListener('group_leave', listener); }
    };
  }

  async function kick(policy, quoted) {
    const base = { action: 'kick', chatId: policy.id };
    if (!policy.id.endsWith('@g.us')) return record({ ...base, status: 'skipped', reason: 'not-a-group' });
    if (!quoted?.author || quoted.fromMe) return record({ ...base, status: 'skipped', reason: 'no-sender' });
    const chat = await group(policy.id);
    if (unsupported(chat)) return record({ ...base, status: 'skipped', reason: 'community-or-announcement-group' });
    if (!(await iAmAdmin(chat))) return record({ ...base, status: 'skipped', reason: 'you-are-not-admin' });
    const target = await findParticipant(client, chat.participants, quoted.author);
    if (!target) return record({ ...base, status: 'skipped', reason: 'not-a-current-member' });
    if (target.isAdmin || target.isSuperAdmin) return record({ ...base, status: 'skipped', reason: 'target-is-admin' });
    const myIds = await equivalentIds(client, client.info?.wid);
    if (myIds.has(serialized(target.id))) return record({ ...base, status: 'skipped', reason: 'cannot-remove-yourself' });
    const targetIds = new Set([...(await equivalentIds(client, serialized(target.id))), ...(await equivalentIds(client, quoted.author))]);
    const entry = { ...base, targetIds: [...targetIds] };
    if (!(await reserve(policy.id, 'kick'))) return record({ ...entry, status: 'skipped', reason: 'admin-paused-or-budget-exhausted' });

    const watch = waitForRemoval(policy.id, targetIds);
    let confirmed = false;
    try {
      await chat.removeParticipants([serialized(target.id)]);
      watch.start();
      confirmed = await watch.result;
    } catch (error) {
      watch.stop();
      pause('KICK_FAILURE');
      onError(`Removing a member failed; admin actions are paused until ${resumeCommand()}. ${error.message}`);
      return record({ ...entry, status: 'failed', reason: 'remove-error' });
    }
    watch.stop();
    if (!confirmed) {
      // No notice in time: check the member list itself. If even that fails, the removal stays unconfirmed.
      try {
        const after = await group(policy.id);
        confirmed = !(await findParticipant(client, after.participants, serialized(target.id)));
      } catch (error) {
        onError(`Could not re-check the member list after a removal: ${error.message}`);
      }
    }
    // The removal request went through: remember them either way, so a later join request can be rejected.
    try { members.add('removed', [...targetIds], { chat: policy.id }); }
    catch (error) { onError(`Could not save the removed member to data/members.json: ${error.message}`); }
    if (!confirmed) {
      pause('KICK_UNCONFIRMED');
      return record({ ...entry, status: 'unconfirmed', reason: 'still-listed-as-member; admin actions paused' });
    }
    return record({ ...entry, status: 'confirmed', reason: 'member-removed' });
  }

  async function trust(policy, quoted, add = true) {
    const action = add ? 'trust' : 'untrust';
    // In a group the sender is the author; only in a direct chat is it the chat itself.
    const sender = String(quoted?.from || '').endsWith('@g.us') ? quoted?.author : quoted?.from;
    if (!sender || quoted.fromMe) return record({ action, chatId: policy.id, status: 'skipped', reason: 'no-sender' });
    const ids = await equivalentIds(client, sender);
    const changed = add ? members.add('trusted', [...ids]) : members.remove('trusted', [...ids]);
    const oneForm = add && ids.size === 1 ? ' (only one form of their ID was known)' : '';
    return record({ action, chatId: policy.id, targetIds: [...ids], status: changed ? 'done' : 'unchanged',
      reason: add ? (changed ? `exempt from spam checks in every chat${oneForm}` : 'already trusted') : (changed ? 'no longer exempt' : 'was not trusted') });
  }

  function cancelUnlock(chatId) {
    clearTimer(unlockTimers.get(chatId));
    unlockTimers.delete(chatId);
  }

  function scheduleUnlock(policy, ms, attempt) {
    cancelUnlock(policy.id);
    const timer = setTimer(() => {
      unlockTimers.delete(policy.id);
      if (!isActive(policy.id)) {
        record({ action: 'unlock', chatId: policy.id, status: 'cancelled', reason: 'chat is no longer set up; unlock it yourself in WhatsApp' });
        return;
      }
      void setLocked(policy, false, 0, { automatic: true, attempt }).catch(error => {
        // A passing page error must not leave the group locked without a word: retry, then hand over to the owner.
        onError(`Automatic unlock failed: ${error.message}`);
        if (attempt < UNLOCK_ATTEMPTS) {
          scheduleUnlock(policy, RETRY_UNLOCK_MS, attempt + 1);
          record({ action: 'unlock', chatId: policy.id, status: 'failed', reason: 'error; trying again in 1 min' });
        } else {
          record({ action: 'unlock', chatId: policy.id, status: 'failed', reason: 'error; unlock it yourself in WhatsApp' });
        }
      });
    }, ms);
    timer?.unref?.();
    unlockTimers.set(policy.id, timer);
  }

  // automatic: the timed unlock after "<buzzword> lock N". It restores normal sending, so it is not held back by the
  // admin budget or a pause, and it is retried a few times if it fails.
  async function setLocked(policy, locked, minutes = 0, { automatic = false, attempt = 1 } = {}) {
    const action = locked ? 'lock' : 'unlock';
    const base = { action, chatId: policy.id };
    if (!policy.id.endsWith('@g.us')) return record({ ...base, status: 'skipped', reason: 'not-a-group' });
    const chat = await group(policy.id);
    if (unsupported(chat)) return record({ ...base, status: 'skipped', reason: 'community-or-announcement-group' });
    if (!(await iAmAdmin(chat))) return record({ ...base, status: 'skipped', reason: 'you-are-not-admin' });
    if (Boolean(chat.groupMetadata?.announce) === locked) {
      if (!locked) {
        cancelUnlock(policy.id);
        lockedByBot.delete(policy.id);
        return record({ ...base, status: 'unchanged', reason: 'already open' });
      }
      // Already admins-only. If this run locked it, a new lock replaces the timer: "lock" keeps it locked,
      // "lock 120" moves the unlock. A group someone else closed is never given a timer, so the bot never opens it.
      if (!lockedByBot.has(policy.id)) return record({ ...base, status: 'unchanged', reason: 'already admins-only; no timed unlock set' });
      cancelUnlock(policy.id);
      if (minutes > 0) scheduleUnlock(policy, minutes * 60000, 1);
      return record({ ...base, status: 'unchanged', reason: minutes > 0 ? `already admins-only; unlock moved to ${minutes} min from now` : 'already admins-only; timed unlock cancelled' });
    }
    if (!automatic && !(await reserve(policy.id, action))) return record({ ...base, status: 'skipped', reason: 'admin-paused-or-budget-exhausted' });
    let ok = false;
    let failure = 'whatsapp-refused';
    try {
      ok = await chat.setMessagesAdminsOnly(locked);
    } catch (error) {
      failure = 'whatsapp-error';
      if (!automatic) {
        pause(`${action.toUpperCase()}_FAILURE`);
        onError(`Changing who can send failed; admin actions are paused until ${resumeCommand()}. ${error.message}`);
      }
    }
    if (!ok) {
      if (automatic && attempt < UNLOCK_ATTEMPTS) {
        scheduleUnlock(policy, RETRY_UNLOCK_MS, attempt + 1);
        return record({ ...base, status: 'failed', reason: `${failure}; trying again in 1 min` });
      }
      return record({ ...base, status: 'failed', reason: automatic ? `${failure}; unlock it yourself in WhatsApp` : failure });
    }
    cancelUnlock(policy.id);
    if (locked) lockedByBot.add(policy.id);
    else lockedByBot.delete(policy.id);
    if (locked && minutes > 0) scheduleUnlock(policy, minutes * 60000, 1);
    return record({ ...base, status: 'done', reason: locked ? `only admins can send${minutes > 0 ? ` for ${minutes} min` : ''}` : 'everyone can send' });
  }

  async function isSavedContact(ids) {
    for (const id of ids) {
      if (contactCache.has(id)) { if (contactCache.get(id)) return true; continue; }
      let mine = false;
      try { mine = Boolean((await client.getContactById(id))?.isMyContact); } catch { /* try the next form */ }
      if (contactCache.size >= 2000) contactCache.delete(contactCache.keys().next().value);
      contactCache.set(id, mine);
      if (mine) return true;
    }
    return false;
  }

  async function decide(ids) {
    const rules = getConfig().joinScreening;
    if (rules.rejectRemoved && members.wasRemoved(ids)) return ['reject', 'previously removed by you'];
    // People known only by privacy ID have no phone number to check, so the country-code rule cannot apply.
    const phone = phoneDigits(ids);
    const code = phone && rules.rejectCountryCodes.find(prefix => phone.startsWith(prefix));
    if (code) return ['reject', `country code +${code}`];
    if (members.isTrusted(ids)) return ['approve', 'trusted by you'];
    if (rules.approveContacts && await isSavedContact(ids)) return ['approve', 'saved contact'];
    return ['pending', 'left for you to review in WhatsApp'];
  }

  async function scan(policy, requesterId) {
    const chat = await group(policy.id);
    if (unsupported(chat)) return [];
    if (!(await iAmAdmin(chat))) {
      if (!notAdminNoted.has(policy.id)) {
        notAdminNoted.add(policy.id);
        record({ action: 'join-screening', chatId: policy.id, status: 'skipped', reason: 'you-are-not-admin' });
      }
      return [];
    }
    const wanted = requesterId ? await idsOf(requesterId) : null;
    const requests = ((await client.getGroupMembershipRequests(policy.id)) || [])
      .map(request => serialized(request.id)).filter(id => id && (!wanted || wanted.has(id)));
    const outcomes = [];
    let answers = 0;
    // Undecided requests are only logged, so they never crowd out ones the rules can answer.
    for (const [index, id] of requests.entries()) {
      if (index >= MAX_EXAMINED || answers >= maxPerScan) {
        outcomes.push(record({ action: 'join-screening', chatId: policy.id, status: 'deferred',
          reason: `${requests.length - index} more request(s) wait for the next join request or restart` }));
        break;
      }
      const ids = await idsOf(id);
      const [decision, why] = await decide(ids);
      const base = { action: `join-${decision}`, chatId: policy.id, targetIds: [...ids] };
      if (decision === 'pending') { outcomes.push(record({ ...base, status: 'pending', reason: why })); continue; }
      if (!(await reserve(policy.id, base.action))) { outcomes.push(record({ ...base, status: 'skipped', reason: 'admin-paused-or-budget-exhausted' })); break; }
      answers++;
      let result;
      try {
        const call = decision === 'approve' ? 'approveGroupMembershipRequests' : 'rejectGroupMembershipRequests';
        [result] = (await client[call](policy.id, { requesterIds: [id], sleep: null })) || [];
      } catch (error) {
        onError(`Answering a join request failed: ${error.message}`);
      }
      if (result && !result.error && result.message === `${decision === 'approve' ? 'Approved' : 'Rejected'} successfully`) {
        outcomes.push(record({ ...base, status: 'done', reason: why }));
      } else if (Number.isFinite(result?.error)) {
        // WhatsApp answered about this one request (for example it was withdrawn or already answered on the phone).
        outcomes.push(record({ ...base, status: 'failed', reason: `whatsapp error ${result.error}: ${result.message || ''}`.trim() }));
      } else {
        // No answer, or a refusal without a code: the library swallowed an error. Stop and ask for a review.
        pause('JOIN_ACTION_FAILURE');
        onError(`A join request was not answered as expected; admin actions are paused until ${resumeCommand()}.`);
        outcomes.push(record({ ...base, status: 'failed', reason: result?.message || 'no answer from WhatsApp' }));
        break;
      }
    }
    return outcomes;
  }

  // Join requests arrive as events that outsiders control. One scan per chat at a time; events during a scan are
  // folded into a single follow-up scan of all waiting requests.
  async function screenJoinRequests(policy, { requesterId = null } = {}) {
    if (policy.joinRequests !== 'screen') return [];
    const running = scans.get(policy.id);
    if (running) { running.again = true; return []; }
    const state = { again: false };
    scans.set(policy.id, state);
    try {
      const outcomes = await scan(policy, requesterId);
      while (state.again) {
        state.again = false;
        outcomes.push(...await scan(policy, null));
      }
      return outcomes;
    } finally {
      scans.delete(policy.id);
    }
  }

  return { kick, trust: (policy, quoted) => trust(policy, quoted, true), untrust: (policy, quoted) => trust(policy, quoted, false),
    setLocked: (policy, locked, minutes) => setLocked(policy, locked, minutes), screenJoinRequests, cancelUnlock };
}

module.exports = { createAdmin };
