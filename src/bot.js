'use strict';

const { resumeCommand } = require('./hints');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { ROOT, loadConfig, saveChats, configPath } = require('./config');
const { createModerator } = require('./moderator');
const { findBrowserExecutable, buildBrowserOptions } = require('./browser');
const { SafetyStore, createWarningGate, createDeletionGate, createReplyGate, createAdminGate, createAgentWriteGate } = require('./safety');
const { createAdmin } = require('./admin');
const { MemberLists } = require('./members');
const { removeSpamMessage } = require('./deletion');
const { handleQr } = require('./pairing');
const { buildPolicies, describeChat, sortChats, formatChatLine, chatsTsv, permissionText, terminalText } = require('./chats');
const { Archive, ColdStore } = require('./archive');
const { LearnedSpam } = require('./learned');
const { loadOrCreateSecret } = require('./transcript');
const { createCommands } = require('./commands');
const { createRouter } = require('./router');
const { chooseChats } = require('./setup');
const { createSummaryService, hasApiKey } = require('./summarise');
const { findClaude } = require('./claude-code');
const { Notes } = require('./notes');
const { createHubSync, createHubLock } = require('./sync');
const { Items } = require('./items');
const { Instructions } = require('./instructions');
const { createEffortBoosts } = require('./effort');
const { createGitHub, tokenFrom } = require('./github');
const { createGoogle } = require('./google');
const { keyFileFrom } = require('./google-commands');
const { Ideas } = require('./ideas');
const { createReminderRunner } = require('./reminders');
const { zoneLabel } = require('./when');
const { clearStaleProfileLock, isBrowserLaunchFailure } = require('./profile-lock');
const { createSpottingSchedule, condenseWindowOpen } = require('./schedule');

const HUBS = path.join(ROOT, 'hubs');
const CLAUDE_RUNS = path.join(ROOT, '.runtime', 'claude-runs');
const { createSendGuard } = require('./send-guard');
const { createDiscovery } = require('./discovery');

const STOP_STATES = new Set(['CONFLICT', 'TOS_BLOCK', 'SMB_TOS_BLOCK', 'PROXYBLOCK', 'DEPRECATED_VERSION']);
const DATA = path.join(ROOT, 'data');

function appendLog(record) {
  const directory = path.join(ROOT, 'logs');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `flags-${record.time.slice(0, 10)}.jsonl`);
  // Roll the current day's log at 5 MiB; keep one previous file for that day.
  if (fs.existsSync(filename) && fs.statSync(filename).size > 5 * 1024 * 1024) {
    const previous = filename.replace('.jsonl', '.previous.jsonl');
    if (fs.existsSync(previous)) fs.unlinkSync(previous);
    fs.renameSync(filename, previous);
  }
  fs.appendFileSync(filename, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function writeAdmin(record) {
  appendLog(record);
  const who = record.targetIds?.length ? ` ${record.targetIds[0]}` : '';
  console.log(terminalText(`[ADMIN ${record.action} ${record.status}]${who} in ${record.chatId}: ${record.reason}`));
}

function writeFlag(record) {
  appendLog(record);
  const signals = record.deleteSignals?.length ? ` delete signal: ${record.deleteSignals.join('; ')}` :
    record.strictRules?.length ? ` pattern: ${record.strictRules.join('; ')}` : '';
  const label = record.event === 'moderation' ? `${record.action === 'delete-for-me' ? 'DELETE-FOR-ME' : 'DELETE'} ${record.status}: ${record.reason}` : `FLAG ${record.score}${signals}`;
  const details = record.reasons.map(x => x.detail).join('; ') || 'strict rule only';
  console.log(terminalText(`[${label}] ${record.senderId} in ${record.chatId}: ${details}`));
}

async function listChats(client, policies) {
  const rows = sortChats((await client.getChats()).filter(chat => chat.id?._serialized !== 'status@broadcast').map(describeChat));
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(DATA, 'chats.tsv'), chatsTsv(rows, policies), { mode: 0o600 });
  return rows;
}

async function runChatSetup(client, config) {
  if (!process.stdin.isTTY) {
    throw new Error('Choosing chats needs an interactive terminal: open CHOOSE-CHATS.cmd, or add entries to "chats" in config.json.');
  }
  const rows = await listChats(client, buildPolicies(config));
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const { chats } = await chooseChats({
      rows, policies: buildPolicies(config), currentChats: config.chats, groupIds: config.groupIds, ask: question => input.question(question),
      forMeFallback: config.deletion.forMeFallback
    });
    const saved = saveChats(chats);
    // Each chosen hub gets its own owner-only folder; files are added on the server, never by the chat.
    for (const chat of saved.chats.filter(x => x.hub)) {
      fs.mkdirSync(path.join(HUBS, chat.hub), { recursive: true, mode: 0o700 });
      console.log(terminalText(`Files for ${chat.label || chat.id}: put them in hubs/${chat.hub}/`));
    }
    console.log(`\nSaved ${saved.chats.length} chat setting(s) to config.json.`);
    return { config: saved };
  } finally {
    input.close();
  }
}

async function startWhatsApp(config, { mode = 'start' } = {}) {
  const safety = new SafetyStore(path.join(ROOT, '.runtime'));
  safety.assertConnectionAllowed();
  process.env.PUPPETEER_CACHE_DIR ||= path.join(ROOT, '.browser-cache');
  let Client, LocalAuth, MessageMedia, qrcode;
  try {
    ({ Client, LocalAuth, MessageMedia } = require('whatsapp-web.js'));
    qrcode = require('qrcode-terminal');
  } catch (error) {
    throw new Error(`WhatsApp dependencies are unavailable. Run SETUP.cmd first. ${error.message}`);
  }
  console.log('Unofficial WhatsApp Web client: account blocking is possible.');
  console.log('Only chats you set up are read; the bot only sends where you allowed it. Keep this terminal open.');
  const executablePath = findBrowserExecutable();
  if (!executablePath) throw new Error('No browser found. Run SETUP.cmd, or install Google Chrome.');
  safety.acquire();
  const releaseLock = () => {
    try { safety.release(); } catch (error) { console.error(`Instance lock cleanup failed: ${terminalText(error.message)}`); }
  };
  process.once('exit', releaseLock);
  // A Chrome that was killed leaves its profile lock behind; with the instance lock held, no other copy of the bot
  // (and so no Chrome of its) is running anywhere, so a lock from an earlier run can go. See src/profile-lock.js.
  const profileLock = clearStaleProfileLock(path.join(ROOT, '.wwebjs_auth', 'session'), { holdsInstanceLock: true });
  if (profileLock.cleared) console.log(terminalText(`Cleared the browser profile lock an earlier run left behind (${profileLock.cleared}).`));
  if (profileLock.kept) {
    throw new Error(`The WhatsApp browser profile is locked (${profileLock.kept}): ${profileLock.reason}. ` +
      'No WhatsApp connection was made, so there is nothing to check on the phone and no pause was recorded.');
  }
  let client;
  try { client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(ROOT, '.wwebjs_auth') }),
    webVersionCache: { type: 'local', path: path.join(ROOT, '.wwebjs_cache') },
    puppeteer: buildBrowserOptions(executablePath),
    // The bundled library also waits this long for WhatsApp's connection to settle at startup; a slow shared host needs room.
    authTimeoutMs: 120000,
    qrMaxRetries: 5,
    takeoverOnConflict: false,
    deviceName: 'Spam detector'
  }); } catch (error) {
    releaseLock();
    process.removeListener('exit', releaseLock);
    throw error;
  }
  let stopping = false;
  let route;
  let archive;
  let admin;
  let reloadTimer, condenseTimer, condenseFirst, reminderTimer, detectTimer, detectFirst, readyTimer;
  const startedAt = Date.now();

  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    route?.close();
    clearTimeout(readyTimer);
    clearInterval(reloadTimer);
    clearInterval(condenseTimer);
    clearTimeout(condenseFirst);
    clearInterval(reminderTimer);
    clearInterval(detectTimer);
    clearTimeout(detectFirst);
    const timeout = setTimeout(() => process.exit(code), 5000);
    timeout.unref();
    try { await client.destroy(); } catch { /* Browser may already be closed. */ }
    clearTimeout(timeout);
    process.exit(code);
  }

  function pauseAndStop(reason) {
    if (stopping) return;
    try { safety.pauseConnection(reason); }
    catch (error) { console.error(`Could not save connection pause: ${terminalText(error.message)}`); }
    console.error(`Connection paused (${terminalText(reason)}). Check WhatsApp on your phone. Do not repeatedly reconnect or relink.`);
    console.error(`After resolving the cause: ${resumeCommand()}`);
    void stop(1);
  }

  async function begin() {
    let current = config;
    let policies = buildPolicies(current);
    if (mode === 'chats') {
      const rows = await listChats(client, policies);
      rows.forEach((row, i) => console.log(formatChatLine(row, i, policies)));
      console.log(`\n${rows.length} chats. Full list with IDs: data/chats.tsv. Choose what the bot may do with CHOOSE-CHATS.cmd.`);
      return stop();
    }
    if (mode === 'setup' || mode === 'choose') {
      ({ config: current } = await runChatSetup(client, current));
      policies = buildPolicies(current);
    }
    if (mode === 'choose') {
      console.log(`Saved ${policies.size} chat setting(s) and stopped. groupIds stays in step with chosen groups.`);
      return stop();
    }
    if (policies.size === 0) console.log('No chats enabled. Discovery only; no terminal input needed.');

    const startConfig = current;
    archive = new Archive(path.join(DATA, 'archive'), { maxFileMiB: current.archive.maxFileMiB });
    const learned = new LearnedSpam(path.join(DATA, 'learned-spam.json'));
    const members = new MemberLists(path.join(DATA, 'members.json'));
    // Admin limits and join-screening rules are fixed at start, like the spam settings.
    admin = createAdmin({
      client, members, getConfig: () => startConfig, onRecord: writeAdmin, onError: message => console.error(terminalText(message)),
      isActive: chatId => policies.has(chatId),
      gate: createAdminGate({ config: startConfig.admin, state: safety.state, save: () => safety.save() })
    });
    let secret;
    const getSecret = () => (secret ||= loadOrCreateSecret(path.join(DATA, 'pseudonym.secret')));
    const sendGuard = createSendGuard();
    const replyGate = createReplyGate({ config: current.replies, state: safety.state, save: () => safety.save() });
    const notes = new Notes(path.join(DATA, 'notes'));
    // Hub folders being synced or read by the AI: the two never overlap.
    const hubLock = createHubLock(path.join(DATA, 'hub-git'));
    const cold = new ColdStore(path.join(DATA, 'condensed'));
    const items = new Items(path.join(DATA, 'items'));
    const instructions = new Instructions(path.join(DATA, 'instructions'));
    const efforts = createEffortBoosts();
    const ideas = new Ideas(path.join(DATA, 'ideas'));
    const github = createGitHub({ getToken: () => tokenFrom(path.join(ROOT, '.env')), timeoutMs: current.github.timeoutSeconds * 1000 });
    // Google Docs, Sheets and Slides: the service account key file named in .env, read at each use.
    const google = createGoogle({ getKeyFile: () => keyFileFrom(path.join(ROOT, '.env'), ROOT), timeoutMs: current.google.timeoutSeconds * 1000 });
    const summaryService = createSummaryService({ getConfig: () => current, getPolicies: () => policies, archive, getSecret, safety, replyGate,
      hubsRoot: HUBS, runsDir: CLAUDE_RUNS, notes, cold, hubLock, items, instructions, efforts, ideas,
      log: line => console.error(terminalText(line)) });
    const discover = createDiscovery({ filename: path.join(DATA, 'discovered-chats.json'), getConfig: () => current,
      getChat: chatId => client.getChatById(chatId) });
    const moderate = createModerator({
      config: current,
      getPolicy: chatId => policies.get(chatId),
      learned,
      members,
      sendGuard,
      onFlag: writeFlag,
      onAction: writeFlag,
      onError: message => console.error(terminalText(message)),
      warningGate: createWarningGate({ config: current.warning, state: safety.state, save: () => safety.save() }),
      deletionGate: createDeletionGate({ config: current.deletion, state: safety.state, save: () => safety.save() }),
      // Deletion settings are fixed at start, like the other spam settings.
      deleteMessage: (message, { byOwner } = {}) => removeSpamMessage(client, message, { forMeFallback: startConfig.deletion.forMeFallback, byOwner })
    });
    route = createRouter({
      getPolicies: () => policies, getConfig: () => current, archive, moderate, replyGate, admin, startedAt,
      discover, sendGuard,
      commands: createCommands({ getConfig: () => current, summaryService, learned, hubsRoot: HUBS, notes, items, instructions, efforts, github, ideas, google,
        reserveAgentWrite: createAgentWriteGate({ state: safety.state, save: () => safety.save() }),
        log: line => console.log(terminalText(line)),
        syncHub: createHubSync({ hubsRoot: HUBS, gitRoot: path.join(DATA, 'hub-git'), hubLock, log: line => console.error(terminalText(line)),
          getLimits: () => ({ maxFileMiB: current.hubs.maxSendMiB, maxTotalMiB: current.hubs.maxSyncMiB, maxFiles: current.hubs.maxSyncFiles }) }) }),
      // A file with no or an unknown extension has no MIME type; send it as a plain binary document.
      loadMedia: file => {
        const media = MessageMedia.fromFilePath(file);
        media.mimetype ||= 'application/octet-stream';
        return media;
      },
      onError: message => console.error(terminalText(message))
    });

    // Picking up chat changes without a restart, as whatsapp-reader's allowlist did. A broken edit keeps the last good settings.
    const file = configPath();
    let stamp = fs.statSync(file).mtimeMs;
    reloadTimer = setInterval(() => {
      try {
        const next = fs.statSync(file).mtimeMs;
        if (next === stamp) return;
        stamp = next;
        current = loadConfig(file);
        policies = buildPolicies(current);
        console.log(`config.json reloaded: ${policies.size} chat(s) set up. (Spam rules and limits apply after a restart.)`);
      } catch (error) {
        console.error(terminalText(`config.json not reloaded, keeping previous chat settings: ${error.message}`));
      }
    }, 3000);
    reloadTimer.unref();

    // Condensing: chats with keepDays set fold their older messages into their notes, but only in the three hours
    // after summary.condenseAt (04:00 by default, reminders.timeZone), checked every 10 minutes: one chat at a time,
    // within the condensing budget and its per-chat gap. Nothing is sent to any chat. Each pass starts with the next
    // chat in turn. Expired cold copies are removed every hour, whatever the time.
    let condensing = false;
    let turn = 0;
    let purgedAt = -Infinity;
    const condenseAll = async () => {
      if (condensing || stopping) return;
      condensing = true;
      try {
        // Copies of condensed messages expire on time for every chat, also ones whose condensing was turned off.
        if (Date.now() - purgedAt >= 60 * 60 * 1000) {
          purgedAt = Date.now();
          try { cold.purgeAll(current.summary.condensedKeepDays); } catch (error) { console.error(terminalText(`Old condensed copies not removed: ${error.message}`)); }
        }
        if (!condenseWindowOpen(current, Date.now())) return;
        const due = [...policies.values()].filter(p => p.ai === true && p.keepDays > 0);
        const start = due.length ? turn++ % due.length : 0;
        for (const policy of [...due.slice(start), ...due.slice(0, start)]) {
          if (stopping) break;
          try {
            const result = await summaryService.condense({ chatId: policy.id, source: 'timer' });
            // Say why a chat with old messages waits (no key, budget...), so a growing backlog is visible.
            if (result.done || !/^nothing older than|condensed less than/.test(result.text)) {
              console.log(terminalText(`Notes for ${policy.label || policy.id}: ${result.done ? '' : 'waiting: '}${result.text}`));
            }
          } catch (error) {
            console.error(terminalText(`Condensing ${policy.label || policy.id} failed; its messages stay archived: ${error.message}`));
          }
        }
      } finally { condensing = false; }
    };
    const condenseTick = () => { void condenseAll().catch(error => console.error(terminalText(`Condensing check failed: ${error.message}`))); };
    condenseFirst = setTimeout(condenseTick, 60 * 1000);
    condenseFirst.unref();
    condenseTimer = setInterval(condenseTick, 10 * 60 * 1000);
    condenseTimer.unref();

    // Reminders: checked every 15 seconds and posted through the reply budget, in chats where send is on.
    const remindDue = createReminderRunner({ items, getPolicies: () => policies, getConfig: () => current, replyGate, replyLimits: current.replies,
      log: line => console.log(line), onError: line => console.error(line),
      // Quotes the command that set the reminder, so the chat sees who asked for it; without the quote if that
      // message is gone (the library's ignoreQuoteErrors).
      sendText: async (chatId, body, { quotedMessageId } = {}) => {
        const posted = await client.sendMessage(chatId, body, { linkPreview: false, sendSeen: false, quotedMessageId, ignoreQuoteErrors: true });
        route.recordSent(chatId, posted);
      } });
    reminderTimer = setInterval(() => {
      if (!stopping) void remindDue().catch(error => console.error(terminalText(`Reminder check failed: ${error.message}`)));
    }, 15 * 1000);
    reminderTimer.unref();

    // Spotting requests: only in the hour after each of reminders.detectTimes (20:00 by default, reminders.timeZone)
    // for chats with detect on, checked every minute, and when the owner sends "<buzzword> spot". Suggestions are
    // only listed; nothing is sent. Every chat's list is tidied every 10 minutes. See src/schedule.js.
    const spotScheduled = createSpottingSchedule({ getPolicies: () => policies, getConfig: () => current,
      detect: options => summaryService.detect(options), purge: (chatId, now, settings) => items.purge(chatId, now, settings),
      log: line => console.log(line), onError: line => console.error(line) });
    const spotTick = () => { if (!stopping) void spotScheduled().catch(error => console.error(terminalText(`Spotting check failed: ${error.message}`))); };
    detectFirst = setTimeout(spotTick, 30 * 1000);
    detectFirst.unref();
    detectTimer = setInterval(spotTick, 60 * 1000);
    detectTimer.unref();

    console.log(`\nWorking in ${policies.size} chat(s):`);
    for (const policy of policies.values()) console.log(terminalText(`  - ${policy.label || policy.id} [${policy.id}]: ${permissionText(policy)}`));
    const known = learned.size;
    console.log(current.deletion.enabled ? `Spam deletion: ${current.deletion.mode === 'strict'
      ? `only your patterns (${current.links.blockedDomains.length} blocked domain(s), ${known.texts} marked text(s), ${known.links} marked link(s), ` +
        `${current.strictRules.filter(rule => rule.action === 'delete').length} rule(s) set to delete)`
      : `score >= ${current.deletion.threshold}`}; ` +
      `for everyone where you are group admin${current.deletion.forMeFallback ? ', otherwise from your phone only' : ''}. Messages from group admins are never deleted.` : 'Spam deletion disabled: flag for review only.');
    if (safety.state.deletionPause) console.log('Saved deletion pause is active: detection continues; removals require manual review and resume.');
    if (safety.state.replyPause) console.log(`Saved reply pause is active: the bot will not send until ${resumeCommand()}.`);
    if (safety.state.adminPause) console.log(`Saved admin pause is active: no kicks, locks or join decisions until ${resumeCommand()}.`);
    const screened = [...policies.values()].filter(policy => policy.joinRequests === 'screen');
    console.log(`Admin commands (you only, need group admin): kick, trust/untrust, lock/unlock. ${members.size.trusted} trusted, ` +
      `${members.size.removed} removed. Join screening: ${screened.length ? screened.map(p => p.label || p.id).join(', ') : 'off'}.`);
    // Answer join requests that arrived while the bot was off.
    for (const policy of screened) await admin.screenJoinRequests(policy).catch(error => console.error(terminalText(`Join screening failed: ${error.message}`)));
    console.log(current.warning.enabled ? 'Spam warning replies enabled in chats where send is on.' : 'No spam warning replies.');
    if (current.summary.provider === 'claude-code') {
      const claude = findClaude({ configured: current.summary.claudeCommand });
      console.log(`AI: your own Claude subscription through Claude Code (${claude ? 'found' : 'NOT FOUND: install it or set summary.claudeCommand'}; ` +
        `token ${process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'set' : 'MISSING: CLAUDE_CODE_OAUTH_TOKEN in .env'}). You only; each run is sealed off. Chats also need AI on.`);
    } else {
      console.log(hasApiKey() ? `Summary API key available (${current.summary.model}); each chat also needs AI on.` : 'Summaries: off (no ANTHROPIC_API_KEY); everything else works without AI.');
    }
    const condensed = [...policies.values()].filter(policy => policy.ai === true && policy.keepDays > 0);
    if (condensed.length) {
      console.log(terminalText(`Notes: ${condensed.map(p => `${p.label || p.id} keeps ${p.keepDays} days`).join(', ')}; ` +
        `older messages are folded into each chat's notes from ${current.summary.condenseAt} (${zoneLabel(current.reminders.timeZone)}), ` +
        `at most ${current.summary.maxCondensePerDay} runs a day.`));
    }
    const hubbed = [...policies.values()].filter(policy => policy.hub);
    if (hubbed.length) console.log(terminalText(`File hubs: ${hubbed.map(p => `${p.label || p.id} -> hubs/${p.hub}/`).join(', ')}.`));
    console.log(`Discover a chat silently: type exactly "${current.discoveryPhrase}" from your account. Results stay in data/discovered-chats.json.`);
    const spotting = [...policies.values()].filter(policy => policy.ai === true && policy.detect === true);
    const times = current.reminders.detectTimes.length ? `at ${current.reminders.detectTimes.join(', ')}` : 'on no schedule';
    console.log(terminalText(`Reminders: ${zoneLabel(current.reminders.timeZone)}, posted where send is on. Spotting requests: ` +
      `${spotting.length ? `${spotting.map(p => p.label || p.id).join(', ')} ${times}` : 'on no schedule'}; ` +
      'in any chat with AI on when you send "<buzzword> spot".'));
    console.log('Silent start: each chat stays silent until an owner command has been answered there. Reminders set earlier are the exception: they post when due.');
    console.log('Test: type "<buzzword> ping" in a chat you set up. Mark spam: reply "<buzzword> spam" to it.');
    console.log('Press Ctrl+C to stop. Chat changes in config.json apply within seconds.');
  }

  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  client.on('qr', code => {
    handleQr(code, {
      unattended: process.env.SPAM_BOT_UNATTENDED === '1',
      onLinkRequired: () => pauseAndStop('LINK_REQUIRED'),
      display: value => {
        console.log('\nPhone: WhatsApp > Linked devices > Link a device. Scan below.');
        qrcode.generate(value, { small: true });
      }
    });
  });
  // WhatsApp Web can hang after the login (seen on the server: 10 minutes of Chrome at full CPU, which used up the day's
  // budget). Give up after startup.readyTimeoutSeconds instead. Nothing is wrong with the account, so no pause is saved.
  let shownProgress = -1;
  client.on('authenticated', () => {
    console.log('Account linked. Loading chats...');
    clearTimeout(readyTimer);
    const limit = config.startup.readyTimeoutSeconds;
    readyTimer = setTimeout(() => {
      if (stopping) return; // "ready" clears this timer
      console.error(`WhatsApp Web did not finish loading within ${limit} seconds of the login, so the bot stops here ` +
        'instead of letting Chrome use CPU. Nothing was recorded against the account. Check CPU Usage on the ' +
        'PythonAnywhere Dashboard, then start or arm again.');
      void stop(1);
    }, limit * 1000);
  });
  client.on('loading_screen', percent => {
    const step = Math.floor(Number(percent) / 25) * 25;
    if (Number.isFinite(step) && step > shownProgress) {
      shownProgress = step;
      console.log(`WhatsApp Web loading: ${step}%`);
    }
  });
  client.on('auth_failure', () => {
    pauseAndStop('AUTH_FAILURE');
  });
  client.on('disconnected', reason => {
    pauseAndStop(`DISCONNECTED:${String(reason).slice(0, 80)}`);
  });
  client.on('change_state', state => {
    if (STOP_STATES.has(state)) pauseAndStop(state);
  });
  let begun = false;
  client.on('ready', () => {
    // Every "ready" ends the loading timeout: a WhatsApp Web page reload repeats "authenticated" and "ready" while the
    // bot is already running, and that second "ready" must not leave a timer that stops a healthy bot.
    clearTimeout(readyTimer);
    if (stopping || begun) return;
    begun = true;
    begin().catch(error => {
      console.error(terminalText(error.message));
      void stop(1);
    });
  });
  // message_create includes your own messages, so you can call the bot from your phone.
  client.on('message_create', message => {
    if (stopping || !route) return;
    void route(message).catch(() => {}); // the router already reports errors.
  });
  client.on('message_edit', message => route?.revoke(message));
  // Deleted messages leave the archive too, whether deleted for everyone or just for you.
  const forget = (message, before) => {
    if (!archive) return;
    const original = before || message;
    route?.revoke(original);
    const chatId = original.fromMe ? original.to : original.from;
    try { archive.revoke(chatId, original.id?.id || message.id?.id); } catch { /* best effort */ }
  };
  client.on('message_revoke_everyone', forget);
  client.on('group_membership_request', notification => {
    const policy = route && route.policyFor(notification?.chatId);
    if (stopping || !admin || policy?.joinRequests !== 'screen') return;
    void admin.screenJoinRequests(policy, { requesterId: notification.author })
      .catch(error => console.error(terminalText(`Join screening failed: ${error.message}`)));
  });
  client.on('message_revoke_me', message => forget(message));
  try {
    await client.initialize();
  } catch (error) {
    console.error(`WhatsApp startup failed: ${terminalText(error.message)}`);
    // Chrome itself did not start: nothing reached WhatsApp, so there is no account to check and no pause to clear.
    if (isBrowserLaunchFailure(error)) {
      console.error('Chrome could not start, so no WhatsApp connection was made. Nothing to check on the phone and no pause was recorded; ' +
        'fix the cause above and start again.');
      void stop(1);
      return;
    }
    pauseAndStop('STARTUP_FAILURE');
  }
}

module.exports = { startWhatsApp, terminalText };
