'use strict';

// Interactive chat chooser: pick chats from the linked account, then for each decide receive / send / buzzword /
// who may call it / spam handling / AI. Returns settings only; setup never sends a message.

const { CHAT_ID } = require('./config');
const { formatChatLine, permissionText, terminalText } = require('./chats');
const { validHubName } = require('./hubs');

const MAX_DIRECT_SHOWN = 25;

function visibleChats(rows, policies) {
  const direct = rows.filter(row => row.kind === 'direct');
  const shownDirect = new Set(direct.slice(0, MAX_DIRECT_SHOWN).map(row => row.id));
  return rows.filter(row => row.kind !== 'direct' || shownDirect.has(row.id) || policies.has(row.id));
}

async function askYesNo(ask, question, fallback) {
  for (let i = 0; i < 3; i++) {
    const answer = (await ask(`${question} [${fallback ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase();
    if (!answer) return fallback;
    if (['y', 'yes'].includes(answer)) return true;
    if (['n', 'no'].includes(answer)) return false;
  }
  return fallback;
}

async function askChoice(ask, question, options, fallback) {
  for (let i = 0; i < 3; i++) {
    const answer = (await ask(`${question} (Enter keeps ${fallback}) `)).trim().toLowerCase();
    if (!answer) return fallback;
    // Only the full word or its first letter: "disable" must not count as "delete".
    const match = options.find(option => option === answer || (answer.length === 1 && option[0] === answer));
    if (match) return match;
  }
  return fallback;
}

async function askBuzzword(ask, current, print) {
  for (let i = 0; i < 3; i++) {
    const answer = (await ask(`Buzzword that calls the bot in this chat, e.g. !bot (Enter keeps "${current || 'none'}", "-" for none): `)).trim();
    if (!answer) return current;
    if (answer === '-') return '';
    if (answer.length >= 2 && answer.length <= 30) return answer;
    print('Use 2 to 30 characters.');
  }
  return current;
}

async function askNumber(ask, question, current, min, max, print, { orZero = false } = {}) {
  for (let i = 0; i < 3; i++) {
    const answer = (await ask(`${question} (Enter keeps ${current}) `)).trim();
    if (!answer) return current;
    const value = Number(answer);
    if (Number.isSafeInteger(value) && ((orZero && value === 0) || (value >= min && value <= max))) return value;
    print(`Use ${orZero ? '0 or ' : ''}a whole number from ${min} to ${max}.`);
  }
  return current;
}

// A folder of shared files for this chat alone, under hubs/. used: hub names other chats already have.
async function askHub(ask, current, used, print) {
  for (let i = 0; i < 3; i++) {
    const answer = (await ask(`Folder for this chat's shared files, under hubs/ (Enter keeps "${current || 'none'}", "-" for none): `)).trim();
    if (!answer) return current;
    if (answer === '-') return '';
    if (!validHubName(answer)) { print('Use letters, digits, ".", "_" and "-" (at most 64), starting with a letter or digit.'); continue; }
    if (used.has(answer.toLowerCase())) { print('Another chat already uses that folder; each chat needs its own.'); continue; }
    return answer;
  }
  return current;
}

async function configureChat({ row, existing, ask, print, forMeFallback, usedHubs = new Set() }) {
  const isGroup = row.id.endsWith('@g.us');
  print(`\n${terminalText(row.name || row.id)} [${row.kind}]\n  ID: ${row.id}\n  Now: ${terminalText(permissionText(existing))}`);
  const base = existing || { id: row.id, label: row.name || '', receive: true, send: false, buzzword: '', callers: 'anyone',
    spam: 'off', archive: true, pseudonymise: true, joinRequests: 'off', ai: false, hub: '', aiPerDay: 3, keepDays: 0, detect: false };
  const receive = await askYesNo(ask, 'Receive (read) messages from this chat?', base.receive);
  const send = await askYesNo(ask, 'Allow the bot to send replies in this chat?', base.send);
  if (!receive && !send) {
    // A group can still be kept for join screening alone: that needs admin rights, not reading or sending.
    if (isGroup && await askYesNo(ask, 'Keep screening join requests for this group (approve contacts and trusted people, reject people you removed)?',
      base.joinRequests === 'screen')) {
      print('  Join screening only: the bot will not read or send here.');
      return { chat: { ...base, receive: false, send: false, buzzword: '', callers: 'anyone', spam: 'off', ai: false, detect: false, hub: '', joinRequests: 'screen' } };
    }
    print('  Removed: the bot will ignore this chat.');
    return { chat: null };
  }
  let buzzword = '';
  let callers = 'anyone';
  let spam = 'off';
  if (receive) {
    buzzword = await askBuzzword(ask, base.buzzword || (existing ? '' : '!bot'), print);
    if (buzzword) callers = await askChoice(ask, 'Who can call it: [a]nyone in the chat or [m]e only?', ['anyone', 'me'], base.callers);
    const deleteNote = isGroup ? 'delete = for everyone if you are admin' : 'delete = from your phone only';
    // New chats start at "flag": watch what the rules catch before letting them delete.
    spam = await askChoice(ask, `Spam handling: [o]ff, [f]lag in the terminal, or [d]elete (${deleteNote}${!isGroup && !forMeFallback ? '; needs deletion.forMeFallback' : ''})?`,
      ['off', 'flag', 'delete'], existing ? base.spam : 'flag');
  }
  // Join screening needs no reading of messages, only admin rights in the group.
  const joinRequests = isGroup && await askYesNo(ask,
    'Screen join requests (approve your contacts and people you trust, reject people you removed; needs admin)?',
    base.joinRequests === 'screen') ? 'screen' : 'off';
  const ai = receive && send && Boolean(buzzword) && await askYesNo(ask, 'Allow explicitly requested AI summaries for this chat?', base.ai === true);
  let aiPerDay = base.aiPerDay ?? 3;
  let keepDays = base.keepDays ?? 0;
  let detect = false;
  if (ai) {
    aiPerDay = await askNumber(ask, 'Most AI requests (summary or ask) a day for this chat, 1-100?', aiPerDay, 1, 100, print);
    keepDays = await askNumber(ask, 'Days to keep messages before older ones are folded into this chat\'s notes and deleted (0 keeps all, else 3-365)?',
      keepDays, 3, 365, print, { orZero: true });
    detect = await askYesNo(ask, 'Spot requests and deadlines in new messages on a schedule? (the AI looks at the times in ' +
      'reminders.detectTimes, 20:00 London time by default; you can also ask any time with "<buzzword> spot"; what it finds ' +
      'is listed as spotted in "issues", not posted, until someone keeps it)', base.detect === true);
  }
  const hub = receive && send && buzzword ? await askHub(ask, base.hub || '', usedHubs, print) : '';
  return { chat: { ...base, receive, send, buzzword, callers, spam, joinRequests, ai: Boolean(ai), aiPerDay, keepDays, detect, hub } };
}

async function chooseChats({ rows, policies, currentChats, groupIds = [], ask, print = console.log, forMeFallback = false }) {
  const chats = currentChats.map(chat => ({ ...chat }));
  const visible = visibleChats(rows, policies);
  print('\nChats on this WhatsApp account (all of them are in data/chats.tsv):');
  visible.forEach((row, i) => print(formatChatLine(row, i, policies)));
  const hidden = rows.length - visible.length;
  if (hidden > 0) print(`  ...and ${hidden} older direct chats not shown. Paste an ID from data/chats.tsv to set one up.`);
  for (;;) {
    const answer = (await ask('\nChat number(s) or ID(s) to set up, separated by commas (Enter when done): ')).trim();
    if (!answer) break;
    for (const item of answer.split(',').map(x => x.trim()).filter(Boolean)) {
      const row = /^\d+$/.test(item) ? visible[Number(item) - 1] : rows.find(r => r.id === item) || (CHAT_ID.test(item) ? { id: item, name: '', kind: item.endsWith('@g.us') ? 'group' : 'direct' } : null);
      if (!row) { print(`  "${item}" is not a number from the list or a chat ID.`); continue; }
      if (row.kind === 'channel' || !CHAT_ID.test(row.id)) {
        print('  Channels and broadcasts cannot be enabled: message receipt is unverified. Choose a group or direct chat; previous answers are kept.');
        continue;
      }
      const index = chats.findIndex(chat => chat.id === row.id);
      const usedHubs = new Set(chats.filter(chat => chat.id !== row.id && chat.hub).map(chat => chat.hub.toLowerCase()));
      const { chat } = await configureChat({ row, existing: index >= 0 ? chats[index] : null, ask, print, forMeFallback, usedHubs });
      if (!chat) {
        if (index >= 0) chats.splice(index, 1);
        // A group still listed in groupIds would stay moderated; an explicit "ignore" entry overrides it.
        if (groupIds.includes(row.id)) chats.push({ id: row.id, label: row.name || '', receive: false, send: false, buzzword: '',
          callers: 'anyone', spam: 'off', archive: false, pseudonymise: true });
        continue;
      }
      if (index >= 0) chats[index] = chat; else chats.push(chat);
    }
  }
  return { chats };
}

module.exports = { chooseChats, visibleChats };
