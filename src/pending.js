'use strict';

// Changes that wait for the owner's go-ahead: deleting, closing, merging, editing what is already there, and anything
// an AI drafted. The command shows what will happen and a 4-digit code; "<buzzword> confirm <code>" in the same chat
// runs it, at most once, within ttlMs. Kept in memory only, so a restart or a pause forgets every waiting change: an old
// code can never run something later by surprise.

const crypto = require('node:crypto');

function createPending({ clock = Date.now, randomInt = crypto.randomInt, ttlMs = 120000, maxPerChat = 5 } = {}) {
  const byChat = new Map();

  function live(chatId) {
    const now = clock();
    const waiting = byChat.get(chatId) || new Map();
    for (const [code, entry] of waiting) if (entry.expires <= now) waiting.delete(code);
    if (waiting.size) byChat.set(chatId, waiting); else byChat.delete(chatId);
    return waiting;
  }

  return {
    // run: async () => reply text; blocked: () => why it cannot start right now (the code then stays valid), or null.
    // Returns the code. The oldest waiting change in the chat gives way past maxPerChat.
    add(chatId, { what, run, blocked = () => null }) {
      const waiting = live(chatId);
      while (waiting.size >= maxPerChat) waiting.delete(waiting.keys().next().value);
      let code;
      do { code = String(randomInt(1000, 10000)); } while (waiting.has(code));
      waiting.set(code, { what, run, blocked, expires: clock() + ttlMs });
      byChat.set(chatId, waiting);
      return code;
    },
    // The waiting change for this code, left in place; null if there is none (or it expired).
    peek(chatId, code) {
      return live(chatId).get(String(code)) || null;
    },
    // The waiting change for this code, removed so it runs once; null if there is none (or it expired).
    take(chatId, code) {
      const waiting = live(chatId);
      const entry = waiting.get(String(code)) || null;
      if (entry) waiting.delete(String(code));
      if (!waiting.size) byChat.delete(chatId);
      return entry;
    },
    // Forgets one code, or every waiting change in the chat. Returns how many were dropped.
    cancel(chatId, code = null) {
      const waiting = live(chatId);
      const count = code === null ? waiting.size : Number(waiting.delete(String(code)));
      if (code === null) waiting.clear();
      if (!waiting.size) byChat.delete(chatId);
      return count;
    },
    list(chatId) {
      return [...live(chatId)].map(([code, entry]) => ({ code, what: entry.what, expires: entry.expires }));
    },
    ttlMs
  };
}

module.exports = { createPending };
