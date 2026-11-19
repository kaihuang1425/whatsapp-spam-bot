'use strict';

// When the bot's own AI jobs run. No chat gets an AI run on a timer except at times the owner set:
// - spotting requests: chats with detect on, once in the hour after each of reminders.detectTimes (London time
//   by default). Otherwise only when the owner sends "<buzzword> spot".
// - condensing (chats with keepDays): only in the three hours after summary.condenseAt.
// The bot calls these ticks every minute; each decides for itself whether it is time.

const { scheduledSlot } = require('./when');
const { terminalText } = require('./chats');

const MINUTE = 60000;
// Skips that should be tried again within the same window: the AI is busy for a moment, or the chat was checked
// (asked with "spot") less than detectEveryMinutes ago and that gap may end inside the window. Anything else is
// final for this slot. A retry costs nothing: these skips happen before any AI run is reserved.
const TRANSIENT = /another AI request is running|minimum interval|checked less than/;
// The AI ran, whatever came of it.
const RAN = /deleted meanwhile/;

function createSpottingSchedule({ getPolicies, getConfig, detect, purge, clock = Date.now, log = console.log, onError = console.error }) {
  let running = false;
  let turn = 0;
  let tidiedAt = -Infinity;
  const done = new Map(); // chat -> the slot it has had its run for

  return async function tick() {
    if (running) return 0;
    running = true;
    let runs = 0;
    try {
      const config = getConfig();
      const settings = config.reminders;
      const now = clock();
      const chats = [...getPolicies().values()];
      // Every chat's list is tidied every 10 minutes (expired suggestions, reminders posted days ago, old closed items).
      if (now - tidiedAt >= 10 * MINUTE) {
        tidiedAt = now;
        for (const policy of chats) {
          try { purge(policy.id, now, settings); }
          catch (error) { onError(terminalText(`The list of ${policy.label || policy.id} was not tidied: ${error.message}`)); }
        }
      }
      const slot = scheduledSlot(now, settings.timeZone, settings.detectTimes, 60);
      if (!slot) return 0;
      const start = chats.length ? turn++ % chats.length : 0;
      for (const policy of [...chats.slice(start), ...chats.slice(0, start)]) {
        if (policy.ai !== true || policy.detect !== true || done.get(policy.id) === slot) continue;
        const where = policy.label || policy.id;
        let result;
        try { result = await detect({ chatId: policy.id, source: 'timer' }); }
        catch (error) {
          done.set(policy.id, slot);
          runs++;
          onError(terminalText(`Spotting requests in ${where} failed: ${error.message}`));
          if (config.summary.provider === 'claude-code') break;
          continue;
        }
        if (!TRANSIENT.test(result.text)) done.set(policy.id, slot);
        if (result.done ? result.added.length : /limit|key|token|not found|deleted/i.test(result.text)) {
          log(terminalText(`Requests in ${where}: ${result.done ? '' : 'waiting: '}${result.text}`));
        }
        const ran = result.done || RAN.test(result.text);
        if (ran) runs++;
        // With the subscription, one run a minute at most, so the owner's own questions are not kept waiting.
        if (ran && config.summary.provider === 'claude-code') break;
      }
    } finally { running = false; }
    return runs;
  };
}

// True while condensing may run: the three hours after summary.condenseAt.
function condenseWindowOpen(config, now) {
  return scheduledSlot(now, config.reminders.timeZone, [config.summary.condenseAt], 180) !== null;
}

module.exports = { createSpottingSchedule, condenseWindowOpen };
