'use strict';

// How hard the AI thinks: the owner can raise (or lower) it for one chat for a while with "!bot effort high 2h", and
// for one question with "!bot ask+ <question>". Kept in memory only: a restart, a pause or the time running out all
// return the chat to summary.effort, so a higher setting can never stay on by accident.

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// The higher of two effort levels.
function higherEffort(a, b) {
  return EFFORTS.indexOf(a) >= EFFORTS.indexOf(b) ? a : b;
}

// "2", "2h", "1.5h", "30m", "30min" as hours; null for anything else.
function parseDuration(text) {
  const match = /^(\d{1,3}(?:\.\d{1,2})?)(h|hr|hrs|hours?|m|min|mins|minutes?)?$/i.exec(String(text ?? '').trim());
  if (!match) return null;
  const value = Number(match[1]);
  const hours = match[2] && /^m/i.test(match[2]) ? value / 60 : value;
  return hours * 60 >= 1 ? hours : null; // at least a minute
}

function createEffortBoosts({ clock = Date.now } = {}) {
  const boosts = new Map();
  return {
    // Until when (ms), rounded up to the whole minute, so the time the owner is shown is when it ends.
    set(chatId, effort, hours) {
      if (!EFFORTS.includes(effort)) throw new Error(`Unknown effort: ${effort}`);
      const until = Math.ceil((clock() + Math.round(hours * 3600000)) / 60000) * 60000;
      boosts.set(chatId, { effort, until });
      return until;
    },
    clear(chatId) {
      return boosts.delete(chatId);
    },
    // { effort, until } while it lasts, otherwise null.
    get(chatId) {
      const boost = boosts.get(chatId);
      if (!boost) return null;
      if (boost.until <= clock()) { boosts.delete(chatId); return null; }
      return boost;
    }
  };
}

module.exports = { EFFORTS, higherEffort, parseDuration, createEffortBoosts };
