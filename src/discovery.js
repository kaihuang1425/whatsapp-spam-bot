'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describeChat, terminalText } = require('./chats');

function reservedDiscovery(body, phrase) {
  const clean = text => String(text || '').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').trim().toLowerCase();
  const marker = clean(phrase), text = clean(body);
  return Boolean(marker && (text === marker || (text.startsWith(marker) && /^[\s,:.!?]/.test(text.slice(marker.length)))));
}

// Metadata stays on this machine. Discovery never edits config.json or enables a chat.
function createDiscovery({ filename, getConfig, getChat, log = console.log, clock = Date.now, timeoutMs = 5000 }) {
  let entries = [];
  if (fs.existsSync(filename)) {
    try {
      entries = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
      if (!Array.isArray(entries) || !entries.every(x => typeof x?.id === 'string' && typeof x.name === 'string' && typeof x.kind === 'string')) {
        throw new Error('invalid metadata');
      }
    } catch (error) {
      entries = [];
      const bad = `${filename}.bad-${clock()}-${process.pid}`;
      try {
        fs.renameSync(filename, bad);
        log(terminalText(`[WARNING] Discovery metadata could not load (${error.message}); set aside at ${bad}. Continuing.`));
      } catch (moveError) {
        log(terminalText(`[WARNING] Discovery metadata could not load or be set aside: ${moveError.message}. Continuing without metadata writes.`));
        // Do not overwrite an unreadable original if it could not be preserved.
        filename = null;
      }
    }
  }
  return async function discover(message, chatId) {
    const phrase = getConfig().discoveryPhrase;
    if (!reservedDiscovery(message.body, phrase)) return false;
    if (message.fromMe !== true) return false;
    if (message.type !== 'chat' || message.body !== phrase) {
      log(terminalText(`[DISCOVERY] Not run; type exactly "${phrase}" as a text message from your account.`));
      return false;
    }
    if (!/^[\w.-]+@(?:g\.us|c\.us|lid|newsletter)$/.test(chatId) || /[\r\n]/.test(chatId)) return true;
    let timer, chat;
    try {
      chat = await Promise.race([
        Promise.resolve().then(() => getChat(chatId)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Discovery getChat timed out')), timeoutMs); })
      ]);
      if (chat?.id?._serialized !== chatId) throw new Error('Discovery chat identity mismatch.');
    } catch (error) {
      log(terminalText(`[WARNING] ${error.message}; discovery skipped. Try the exact phrase again.`));
      return true;
    } finally { clearTimeout(timer); }
    if (!filename) return true;
    const { id, name, kind } = describeChat(chat);
    const entry = { id, name, kind, discoveredAt: new Date(clock()).toISOString() };
    const next = [...entries.filter(x => x.id !== id), entry].slice(-1000);
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filename);
    entries = next;
    log(terminalText(`[DISCOVERED] ${name} [${kind}] ID: ${id}; saved to data/discovered-chats.json; permissions unchanged.`));
    return true;
  };
}

module.exports = { createDiscovery, reservedDiscovery };
