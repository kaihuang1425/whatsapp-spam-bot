'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { domainToASCII } = require('node:url');
const { validHubName } = require('./hubs');
const { validTimeZone, validClockTime } = require('./when');
const { EFFORTS } = require('./effort');
const { validRepo } = require('./github');
const { KINDS: GOOGLE_KINDS } = require('./google');

// A linked Google file's short name in a chat, and Google's file ID.
const GOOGLE_NAME = /^[a-z0-9][a-z0-9-]{0,29}$/;
const GOOGLE_ID = /^[A-Za-z0-9_-]{20,100}$/;

const ROOT = path.resolve(__dirname, '..');
const CHAT_ID = /^[\w.-]+@(?:g\.us|c\.us|lid)$/;
const SPAM_MODES = ['off', 'flag', 'delete'];

// Sections added after the first release. Older config files keep working: anything missing gets these values.
const DEFAULTS = {
  chats: [],
  managedGroupIds: [],
  logOtherChats: false,
  discoveryPhrase: '!bot discover',
  replyPrefix: '🤖',
  replies: { minIntervalSeconds: 3, chatCooldownSeconds: 5, maxPerHour: 30, maxPerDay: 200 },
  archive: { enabled: true, maxFileMiB: 20 },
  summary: { model: 'claude-opus-5-5', effort: 'low', hours: 24, maxMessages: 500, maxTranscriptChars: 60000, cooldownSeconds: 60, ownerOnly: true,
    minIntervalSeconds: 3, maxPerHour: 4, maxPerDay: 12,
    // "!bot ask+": one answer at this effort (or the chat's own, if higher); "!bot effort <level> [hours]": at most this long.
    boostEffort: 'high', maxBoostHours: 12,
    // "api": ANTHROPIC_API_KEY (API credits). "claude-code": your own subscription via the claude program, owner only.
    provider: 'api', claudeCommand: '', claudeTimeoutSeconds: 300, claudeMaxBudgetUsd: 0,
    // Condensing old messages into a chat's notes (chats[].keepDays): its own small budget, apart from requests.
    maxNotesChars: 6000, maxCondensePerDay: 4, condenseEveryHours: 6, condensedKeepDays: 30,
    // Condensing runs only in the three hours after this time (reminders.timeZone), not around the clock.
    condenseAt: '04:00' },
  hubs: { maxSendMiB: 25, maxListed: 30, maxSyncMiB: 200, maxSyncFiles: 5000 },
  // GitHub from chats (chats[].githubRepo), across all chats: issues opened and other changes an hour, how long to wait
  // for GitHub, and where file changes and reverts go: 'pull' (a new branch with a pull request) or 'direct' (the
  // default branch).
  github: { maxIssuesPerHour: 10, timeoutSeconds: 15, cooldownSeconds: 10, maxWritesPerHour: 30, changes: 'pull' },
  // Google Docs, Sheets and Slides linked to chats (chats[].googleFiles), through a service account whose key file is
  // named in .env (GOOGLE_SERVICE_ACCOUNT_FILE): changes an hour across all chats, how long to wait for Google, and
  // the wait between members' requests in a chat.
  google: { maxWritesPerHour: 30, timeoutSeconds: 15, cooldownSeconds: 10 },
  // WhatsApp Web must finish loading this long after the login, or the bot stops instead of letting Chrome use CPU.
  startup: { readyTimeoutSeconds: 300 },
  // Reminders and open items (remind/issue/issues/keep/drop/done), and requests the AI spots in chats with
  // chats[].detect: suggestions only, on their own small AI budget.
  reminders: { timeZone: 'Europe/London', defaultHour: 9, leadHours: 24, maxDaysAhead: 400, maxOpenPerChat: 50, maxTextChars: 200,
    lateGraceHours: 6, closeAfterDays: 3, keepClosedDays: 30, maxRemindersPerChatPerHour: 6,
    // Spotting runs in chats with detect on once in the hour after each of these times, and when the owner asks.
    detectTimes: ['20:00'],
    maxDetectPerDay: 24, detectEveryMinutes: 60, maxSuggestions: 5, maxSuggestedPerChat: 20, suggestionDays: 7,
    // Against floods of junk messages: at most this many spotting runs per chat a day, and at most this much
    // message text per run (the oldest new messages first; anything older than a day is skipped).
    maxDetectPerChatPerDay: 3, maxDetectChars: 20000 },
  strictRules: [],
  admin: { minIntervalSeconds: 3, maxPerHour: 20, maxPerDay: 60 },
  joinScreening: { approveContacts: true, rejectRemoved: true, rejectCountryCodes: [] }
};

function applyDefaults(config) {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (!Object.hasOwn(config, key)) config[key] = structuredClone(value);
    else if (value && typeof value === 'object' && !Array.isArray(value) && config[key] && typeof config[key] === 'object') {
      for (const [field, fallback] of Object.entries(value)) if (!Object.hasOwn(config[key], field)) config[key][field] = fallback;
    }
  }
  if (config.deletion && typeof config.deletion === 'object') {
    // Configs that predate deletion modes get "strict" too: score-based deletion removed ordinary messages, so it
    // now has to be chosen explicitly with "mode": "score".
    if (!Object.hasOwn(config.deletion, 'mode')) config.deletion.mode = 'strict';
    if (!Object.hasOwn(config.deletion, 'forMeFallback')) config.deletion.forMeFallback = false;
    if (!Object.hasOwn(config.deletion, 'keepDeletedText')) config.deletion.keepDeletedText = false;
  }
  // A pattern rule only flags unless the owner explicitly set "action": "delete" on it.
  if (Array.isArray(config.strictRules)) {
    config.strictRules = config.strictRules.map(rule => (rule && typeof rule === 'object' ? { action: 'flag', ...rule } : rule));
  }
  config.chats = Array.isArray(config.chats) ? config.chats.map(chat => (chat && typeof chat === 'object' ? {
    label: '', receive: true, send: false, buzzword: '', callers: 'anyone', spam: 'off', archive: true, pseudonymise: true,
    joinRequests: 'off', ai: false, hub: '', aiPerDay: 3, keepDays: 0, detect: false, githubRepo: '', githubMembers: false,
    googleFiles: [], googleMembers: false, assistant: false, githubAutoIssues: false, ...chat
  } : chat)) : config.chats;
  return config;
}

function validateConfig(config) {
  function requireValue(condition, message) {
    if (!condition) throw new Error(`Config: ${message}`);
  }
  function strings(value, label) {
    requireValue(Array.isArray(value) && value.every(x => typeof x === 'string' && x.trim()), `${label} must be an array of nonempty strings.`);
  }
  function number(value, label, min = 0) {
    requireValue(Number.isFinite(value) && value >= min, `${label} must be a number >= ${min}.`);
  }
  function integer(value, label, min = 1) {
    requireValue(Number.isSafeInteger(value) && value >= min, `${label} must be an integer >= ${min}.`);
  }
  function bool(value, label) {
    requireValue(typeof value === 'boolean', `${label} must be true or false.`);
  }
  // chats[].googleFiles: the Google files this chat may reach, by a short name of its own. Set with the console's
  // "google" command, which checks each one with Google first.
  function checkGoogleFiles(chat) {
    const label = `chat ${chat.id}: googleFiles`;
    requireValue(Array.isArray(chat.googleFiles) && chat.googleFiles.length <= 20, `${label} must be a list of at most 20 files.`);
    const names = new Set();
    for (const file of chat.googleFiles) {
      requireValue(file && typeof file === 'object' && GOOGLE_NAME.test(file.name ?? '') && GOOGLE_ID.test(file.id ?? '') &&
        GOOGLE_KINDS.includes(file.kind), `${label}: each needs a name (a-z, 0-9 and -, up to 30), an id and a kind (doc, sheet or slides).`);
      requireValue(!names.has(file.name), `${label}: the name "${file.name}" is used twice.`);
      names.add(file.name);
    }
  }
  function domains(value, label) {
    strings(value, label);
    for (const domain of value) {
      const ascii = domainToASCII(domain.toLowerCase());
      requireValue(ascii && !/[\s/:@?#]/.test(domain) && ascii.includes('.') && !ascii.startsWith('.') && !ascii.endsWith('.'), `${label}: use bare domains such as example.com.`);
    }
  }
  requireValue(config && typeof config === 'object' && !Array.isArray(config), 'expected an object.');
  applyDefaults(config);
  strings(config.groupIds, 'groupIds');
  requireValue(config.groupIds.every(id => /^\d+(?:-\d+)?@g\.us$/.test(id)), 'groupIds must contain WhatsApp group IDs ending in @g.us.');
  strings(config.managedGroupIds, 'managedGroupIds');
  requireValue(config.managedGroupIds.every(id => /^\d+(?:-\d+)?@g\.us$/.test(id)), 'managedGroupIds must contain group IDs.');
  strings(config.trustedSenderIds, 'trustedSenderIds');
  number(config.threshold, 'threshold', 1);
  bool(config.deletion?.enabled, 'deletion.enabled');
  number(config.deletion.threshold, 'deletion.threshold', config.threshold);
  number(config.deletion.minIntervalSeconds, 'deletion.minIntervalSeconds', 1);
  integer(config.deletion.maxPerHour, 'deletion.maxPerHour');
  integer(config.deletion.maxPerDay, 'deletion.maxPerDay', config.deletion.maxPerHour);
  requireValue(['strict', 'score'].includes(config.deletion.mode), 'deletion.mode must be "strict" or "score".');
  bool(config.deletion.forMeFallback, 'deletion.forMeFallback');
  bool(config.deletion.keepDeletedText, 'deletion.keepDeletedText');
  bool(config.warning?.enabled, 'warning.enabled');
  number(config.warning.cooldownSeconds, 'warning.cooldownSeconds', 10);
  number(config.warning.groupCooldownSeconds, 'warning.groupCooldownSeconds', 15);
  integer(config.warning.maxPerHour, 'warning.maxPerHour');
  integer(config.warning.maxPerDay, 'warning.maxPerDay', config.warning.maxPerHour);
  requireValue(Array.isArray(config.keywords), 'keywords must be an array.');
  for (const rule of config.keywords) {
    requireValue(typeof rule?.phrase === 'string' && rule.phrase.trim().length > 0, 'every keyword needs a nonempty phrase.');
    number(rule.score, `score for ${JSON.stringify(rule.phrase)}`, 1);
  }
  requireValue(config.links && typeof config.links === 'object', 'links is required.');
  for (const field of ['blockedDomains', 'trustedDomains', 'shortenerDomains']) domains(config.links[field], `links.${field}`);
  for (const field of ['linkScore', 'shortenerScore', 'blockedDomainScore', 'manyLinksScore']) {
    number(config.links[field], `links.${field}`);
  }
  integer(config.links.manyLinksLimit, 'links.manyLinksLimit', 2);
  requireValue(config.repetition && typeof config.repetition === 'object', 'repetition is required.');
  number(config.repetition.windowSeconds, 'repetition.windowSeconds', 1);
  integer(config.repetition.duplicateLimit, 'repetition.duplicateLimit', 2);
  integer(config.repetition.messageLimit, 'repetition.messageLimit', 2);
  number(config.repetition.score, 'repetition.score', 1);
  bool(config.logMessageText, 'logMessageText');

  requireValue(Array.isArray(config.strictRules), 'strictRules must be an array.');
  const ruleNames = new Set();
  for (const rule of config.strictRules) {
    requireValue(rule && typeof rule === 'object' && typeof rule.name === 'string' && rule.name.trim(), 'every strict rule needs a name.');
    requireValue(!ruleNames.has(rule.name), `strict rule names must be unique: ${rule.name}`);
    ruleNames.add(rule.name);
    requireValue(['flag', 'delete'].includes(rule.action), `strict rule "${rule.name}": action must be "flag" or "delete".`);
    for (const field of ['anyOf', 'alsoAnyOf']) if (Object.hasOwn(rule, field)) strings(rule[field], `strictRules "${rule.name}" ${field}`);
    if (Object.hasOwn(rule, 'linkDomains')) domains(rule.linkDomains, `strictRules "${rule.name}" linkDomains`);
    for (const field of ['needsLink', 'needsRepeat']) if (Object.hasOwn(rule, field)) bool(rule[field], `strictRules "${rule.name}" ${field}`);
    requireValue(Object.hasOwn(rule, 'anyOf') || Object.hasOwn(rule, 'linkDomains') || rule.needsRepeat,
      `strict rule "${rule.name}" needs anyOf, linkDomains or needsRepeat, so it cannot match every message.`);
    requireValue(!Object.hasOwn(rule, 'alsoAnyOf') || Object.hasOwn(rule, 'anyOf'), `strict rule "${rule.name}": alsoAnyOf needs anyOf.`);
  }

  requireValue(Array.isArray(config.chats), 'chats must be an array.');
  const chatIds = new Set();
  const hubOwners = new Map();
  for (const chat of config.chats) {
    requireValue(chat && typeof chat === 'object' && typeof chat.id === 'string' && CHAT_ID.test(chat.id),
      'every chat needs an id ending in @g.us (group), @c.us or @lid (direct chat).');
    requireValue(!chatIds.has(chat.id), `chat ${chat.id} is listed twice.`);
    chatIds.add(chat.id);
    requireValue(typeof chat.label === 'string', `chat ${chat.id}: label must be text.`);
    for (const field of ['receive', 'send', 'archive', 'pseudonymise', 'ai', 'detect', 'assistant', 'githubAutoIssues']) {
      bool(chat[field], `chat ${chat.id}: ${field}`);
    }
    requireValue(!chat.detect || chat.ai, `chat ${chat.id}: detect (spotting requests) needs ai: true.`);
    requireValue(typeof chat.buzzword === 'string' && chat.buzzword.trim() === chat.buzzword && chat.buzzword.length <= 30 &&
      (chat.buzzword === '' || chat.buzzword.length >= 2), `chat ${chat.id}: buzzword must be "" or 2-30 characters without leading/trailing spaces.`);
    requireValue(['anyone', 'me'].includes(chat.callers), `chat ${chat.id}: callers must be "anyone" or "me".`);
    requireValue(SPAM_MODES.includes(chat.spam), `chat ${chat.id}: spam must be "off", "flag" or "delete".`);
    requireValue(chat.receive || (chat.buzzword === '' && chat.spam === 'off'),
      `chat ${chat.id}: a buzzword or spam handling needs receive: true (the bot must read the chat).`);
    requireValue(['off', 'screen'].includes(chat.joinRequests), `chat ${chat.id}: joinRequests must be "off" or "screen".`);
    requireValue(chat.joinRequests === 'off' || chat.id.endsWith('@g.us'), `chat ${chat.id}: joinRequests "screen" only works in groups.`);
    requireValue(chat.hub === '' || validHubName(chat.hub), `chat ${chat.id}: hub must be "" or a folder name of letters, digits, ".", "_" and "-" (at most 64).`);
    requireValue(chat.hub === '' || (chat.receive && chat.send && chat.buzzword), `chat ${chat.id}: a file hub needs receive, send and a buzzword.`);
    // One hub, one chat: a folder shared by two chats would let each fetch the other's files.
    requireValue(chat.hub === '' || !hubOwners.has(chat.hub.toLowerCase()), `chat ${chat.id}: hub "${chat.hub}" is already used by ${hubOwners.get(chat.hub.toLowerCase())}.`);
    if (chat.hub) hubOwners.set(chat.hub.toLowerCase(), chat.id);
    requireValue(chat.githubRepo === '' || validRepo(chat.githubRepo), `chat ${chat.id}: githubRepo must be "" or OWNER/REPO.`);
    bool(chat.githubMembers, `chat ${chat.id}: githubMembers`);
    checkGoogleFiles(chat);
    bool(chat.googleMembers, `chat ${chat.id}: googleMembers`);
    requireValue(Number.isSafeInteger(chat.aiPerDay) && chat.aiPerDay >= 1 && chat.aiPerDay <= 100,
      `chat ${chat.id}: aiPerDay must be a whole number from 1 to 100.`);
    // At least 3 days: WhatsApp lets people delete for everyone for about two and a half days, and a deletion must
    // reach the archive before the message is folded into the notes.
    requireValue(Number.isSafeInteger(chat.keepDays) && (chat.keepDays === 0 || (chat.keepDays >= 3 && chat.keepDays <= 365)),
      `chat ${chat.id}: keepDays must be 0 (keep everything) or a whole number from 3 to 365.`);
  }

  bool(config.logOtherChats, 'logOtherChats');
  requireValue(typeof config.discoveryPhrase === 'string' && config.discoveryPhrase.length >= 4 && config.discoveryPhrase.length <= 100 &&
    config.discoveryPhrase.trim() === config.discoveryPhrase && !/[\x00-\x1f\x7f-\x9f]/.test(config.discoveryPhrase) &&
    !config.discoveryPhrase.startsWith(config.replyPrefix), 'discoveryPhrase must be 4-100 characters, without edge spaces, controls or the reply prefix.');
  requireValue(typeof config.replyPrefix === 'string' && config.replyPrefix.trim().length > 0, 'replyPrefix must be nonempty text.');
  number(config.replies?.minIntervalSeconds, 'replies.minIntervalSeconds', 1);
  number(config.replies.chatCooldownSeconds, 'replies.chatCooldownSeconds', 0);
  integer(config.replies.maxPerHour, 'replies.maxPerHour');
  integer(config.replies.maxPerDay, 'replies.maxPerDay', config.replies.maxPerHour);
  bool(config.archive?.enabled, 'archive.enabled');
  number(config.archive.maxFileMiB, 'archive.maxFileMiB', 1);
  requireValue(typeof config.summary?.model === 'string' && config.summary.model.trim(), 'summary.model must be a model name.');
  requireValue(EFFORTS.includes(config.summary.effort), 'summary.effort must be low, medium, high, xhigh or max.');
  requireValue(EFFORTS.includes(config.summary.boostEffort), 'summary.boostEffort must be low, medium, high, xhigh or max.');
  requireValue(Number.isFinite(config.summary.maxBoostHours) && config.summary.maxBoostHours > 0 && config.summary.maxBoostHours <= 48,
    'summary.maxBoostHours must be a number of hours above 0 and at most 48.');
  number(config.summary.hours, 'summary.hours', 1);
  integer(config.summary.maxMessages, 'summary.maxMessages', 10);
  integer(config.summary.maxTranscriptChars, 'summary.maxTranscriptChars');
  number(config.summary.cooldownSeconds, 'summary.cooldownSeconds', 0);
  bool(config.summary.ownerOnly, 'summary.ownerOnly');
  number(config.summary.minIntervalSeconds, 'summary.minIntervalSeconds', 1);
  integer(config.summary.maxPerHour, 'summary.maxPerHour');
  integer(config.summary.maxPerDay, 'summary.maxPerDay', config.summary.maxPerHour);
  requireValue(['api', 'claude-code'].includes(config.summary.provider), 'summary.provider must be "api" or "claude-code".');
  requireValue(typeof config.summary.claudeCommand === 'string' && !/[\r\n]/.test(config.summary.claudeCommand),
    'summary.claudeCommand must be "" (find claude) or the path to the claude program.');
  requireValue(Number.isFinite(config.summary.claudeTimeoutSeconds) && config.summary.claudeTimeoutSeconds >= 10 &&
    config.summary.claudeTimeoutSeconds <= 1800, 'summary.claudeTimeoutSeconds must be 10-1800.');
  number(config.summary.claudeMaxBudgetUsd, 'summary.claudeMaxBudgetUsd', 0);
  // 8000 characters fit the 16000-token answer the condensing request allows, even in scripts that use a token per character.
  requireValue(Number.isSafeInteger(config.summary.maxNotesChars) && config.summary.maxNotesChars >= 500 &&
    config.summary.maxNotesChars <= 8000, 'summary.maxNotesChars must be 500-8000.');
  requireValue(Number.isSafeInteger(config.summary.maxCondensePerDay) && config.summary.maxCondensePerDay >= 1 &&
    config.summary.maxCondensePerDay <= 48, 'summary.maxCondensePerDay must be 1-48.');
  // Attempts are kept for 24 hours, so a longer gap could not be enforced.
  requireValue(Number.isFinite(config.summary.condenseEveryHours) && config.summary.condenseEveryHours >= 1 &&
    config.summary.condenseEveryHours <= 24, 'summary.condenseEveryHours must be 1-24.');
  requireValue(Number.isSafeInteger(config.summary.condensedKeepDays) && config.summary.condensedKeepDays >= 0 &&
    config.summary.condensedKeepDays <= 365, 'summary.condensedKeepDays must be a whole number from 0 to 365.');
  requireValue(Number.isFinite(config.hubs?.maxSendMiB) && config.hubs.maxSendMiB >= 1 && config.hubs.maxSendMiB <= 100,
    'hubs.maxSendMiB must be 1-100.');
  requireValue(Number.isSafeInteger(config.hubs.maxListed) && config.hubs.maxListed >= 1 && config.hubs.maxListed <= 200,
    'hubs.maxListed must be 1-200.');
  requireValue(Number.isFinite(config.hubs.maxSyncMiB) && config.hubs.maxSyncMiB >= 1 && config.hubs.maxSyncMiB <= 5000,
    'hubs.maxSyncMiB must be 1-5000.');
  requireValue(Number.isSafeInteger(config.hubs.maxSyncFiles) && config.hubs.maxSyncFiles >= 1 && config.hubs.maxSyncFiles <= 100000,
    'hubs.maxSyncFiles must be a whole number from 1 to 100000.');
  requireValue(Number.isSafeInteger(config.github?.maxIssuesPerHour) && config.github.maxIssuesPerHour >= 1 && config.github.maxIssuesPerHour <= 100,
    'github.maxIssuesPerHour must be a whole number from 1 to 100.');
  requireValue(Number.isFinite(config.github.timeoutSeconds) && config.github.timeoutSeconds >= 3 && config.github.timeoutSeconds <= 120,
    'github.timeoutSeconds must be a number of seconds from 3 to 120.');
  requireValue(Number.isFinite(config.github.cooldownSeconds) && config.github.cooldownSeconds >= 0 && config.github.cooldownSeconds <= 600,
    'github.cooldownSeconds must be a number of seconds from 0 to 600.');
  requireValue(Number.isSafeInteger(config.github.maxWritesPerHour) && config.github.maxWritesPerHour >= 1 && config.github.maxWritesPerHour <= 500,
    'github.maxWritesPerHour must be a whole number from 1 to 500.');
  requireValue(['pull', 'direct'].includes(config.github.changes), 'github.changes must be "pull" (a new branch with a pull request) or "direct".');
  requireValue(Number.isSafeInteger(config.google?.maxWritesPerHour) && config.google.maxWritesPerHour >= 1 && config.google.maxWritesPerHour <= 500,
    'google.maxWritesPerHour must be a whole number from 1 to 500.');
  requireValue(Number.isFinite(config.google.timeoutSeconds) && config.google.timeoutSeconds >= 3 && config.google.timeoutSeconds <= 120,
    'google.timeoutSeconds must be a number of seconds from 3 to 120.');
  requireValue(Number.isFinite(config.google.cooldownSeconds) && config.google.cooldownSeconds >= 0 && config.google.cooldownSeconds <= 600,
    'google.cooldownSeconds must be a number of seconds from 0 to 600.');
  requireValue(Number.isSafeInteger(config.startup?.readyTimeoutSeconds) && config.startup.readyTimeoutSeconds >= 10 &&
    config.startup.readyTimeoutSeconds <= 3600, 'startup.readyTimeoutSeconds must be a whole number of seconds from 10 to 3600.');
  const r = config.reminders;
  requireValue(r && typeof r === 'object' && validTimeZone(r.timeZone), 'reminders.timeZone must be a time zone name such as "Europe/London".');
  const whole = (value, label, min, max) => requireValue(Number.isSafeInteger(value) && value >= min && value <= max,
    `reminders.${label} must be a whole number from ${min} to ${max}.`);
  whole(r.defaultHour, 'defaultHour', 0, 23);
  whole(r.leadHours, 'leadHours', 0, 168);
  whole(r.maxDaysAhead, 'maxDaysAhead', 1, 1000);
  whole(r.maxOpenPerChat, 'maxOpenPerChat', 1, 500);
  whole(r.maxTextChars, 'maxTextChars', 20, 1000);
  // At least 2 hours: every reminder is a little late (checked every 15 seconds), and one held back by the hourly
  // limits may wait up to an hour.
  whole(r.lateGraceHours, 'lateGraceHours', 2, 72);
  whole(r.closeAfterDays, 'closeAfterDays', 1, 365);
  whole(r.keepClosedDays, 'keepClosedDays', 0, 365);
  whole(r.maxRemindersPerChatPerHour, 'maxRemindersPerChatPerHour', 1, 30);
  whole(r.maxSuggestedPerChat, 'maxSuggestedPerChat', 1, 100);
  whole(r.suggestionDays, 'suggestionDays', 1, 60);
  whole(r.maxDetectPerDay, 'maxDetectPerDay', 1, 96);
  // Attempts are kept for 24 hours, so a longer gap could not be enforced.
  whole(r.detectEveryMinutes, 'detectEveryMinutes', 10, 1440);
  whole(r.maxSuggestions, 'maxSuggestions', 1, 20);
  whole(r.maxDetectPerChatPerDay, 'maxDetectPerChatPerDay', 1, 24);
  whole(r.maxDetectChars, 'maxDetectChars', 1000, 60000);
  requireValue(Array.isArray(r.detectTimes) && r.detectTimes.length <= 6 && r.detectTimes.every(validClockTime) &&
    new Set(r.detectTimes).size === r.detectTimes.length,
  'reminders.detectTimes must be a list of up to 6 different times such as ["20:00"] ([] = only when the owner asks).');
  requireValue(validClockTime(config.summary.condenseAt), 'summary.condenseAt must be a time such as "04:00".');
  number(config.admin?.minIntervalSeconds, 'admin.minIntervalSeconds', 1);
  integer(config.admin.maxPerHour, 'admin.maxPerHour');
  integer(config.admin.maxPerDay, 'admin.maxPerDay', config.admin.maxPerHour);
  bool(config.joinScreening?.approveContacts, 'joinScreening.approveContacts');
  bool(config.joinScreening.rejectRemoved, 'joinScreening.rejectRemoved');
  requireValue(Array.isArray(config.joinScreening.rejectCountryCodes) && config.joinScreening.rejectCountryCodes.every(x => /^\d{1,4}$/.test(x)),
    'joinScreening.rejectCountryCodes must be a list of country calling codes as text, such as "234" (no + sign).');
  return config;
}

function configPath() {
  return process.env.SPAM_BOT_CONFIG || path.join(ROOT, 'config.json');
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^﻿/, ''));
}

function loadConfig(filename = configPath()) {
  try {
    return validateConfig(readJson(filename));
  } catch (error) {
    throw new Error(`Cannot load ${filename}: ${error.message}`);
  }
}

// Save chat settings and their groupIds mirrors; preserve hand edits elsewhere in the config.
function saveChats(chats, filename = configPath()) {
  const raw = readJson(filename);
  raw.chats = chats;
  // groupIds lists the groups the bot works in. Keep it in step with chats: the hosted supervisor (shared-bot-task)
  // only starts the WhatsApp worker when groupIds is not empty. Entries in chats still decide what happens there.
  const managed = new Set([...(raw.managedGroupIds || []), ...(raw.chats || []).map(chat => chat.id), ...chats.map(chat => chat.id)]
    .filter(id => /^\d+(?:-\d+)?@g\.us$/.test(id)));
  const working = chats.filter(chat => /^\d+(?:-\d+)?@g\.us$/.test(chat.id) && (chat.receive || chat.joinRequests === 'screen'))
    .map(chat => chat.id);
  raw.groupIds = [...new Set([...(raw.groupIds || []).filter(id => !managed.has(id)), ...working])];
  raw.managedGroupIds = [...managed];
  validateConfig(structuredClone(raw));
  const temporary = `${filename}.${process.pid}.tmp`;
  // Chat IDs and trusted phone numbers live here: owner-only, like the rest of the bot's private files.
  fs.writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filename);
  return loadConfig(filename);
}

module.exports = { ROOT, CHAT_ID, loadConfig, validateConfig, saveChats, configPath };
