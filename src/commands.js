'use strict';

// What the bot answers after its buzzword, e.g. "!bot ping". Everything except "summary" and "ask" works without AI.
// A command may return text, or { text, file } to send one file from this chat's own hub with the text as caption.

const { SpamDetector } = require('./detector');
const { permissionText, normalizeCall } = require('./chats');
const { hubFolder, listHub, findHubFile, hubFilePath, formatSize } = require('./hubs');
const { createItemCommands, defaultReminder } = require('./reminders');
const { zoneLabel, formatWhen } = require('./when');
const { cleanInstructions } = require('./instructions');
const { EFFORTS, parseDuration } = require('./effort');
const { GitHubError, issuesText, pullsText, pullText, validPath } = require('./github');
const { createGitHubChanges, typedAfter, phrase } = require('./github-changes');
const { GoogleError } = require('./google');
const { ACTIONS, parseDraft, checkDraft } = require('./drafts');
const { createPending } = require('./pending');
const { createGoogleCommands } = require('./google-commands');
const { cleanText, hasLink, onlyKnownLinks } = require('./items');
const { agentText, issueUpdate, taskHint } = require('./chat-agent');

function createCommands({ getConfig, summaryService = null, learned = null, hubsRoot = null, notes = null, syncHub = null,
  items = null, instructions = null, efforts = null, github = null, ideas = null, google = null, pending = null,
  clock = Date.now, log = console.log, reserveAgentWrite = () => false }) {
  // GitHub issues opened from chats in the last hour, across all chats (github.maxIssuesPerHour). In memory: a restart
  // starts the count again.
  let issuesOpened = [];
  // One GitHub request per chat at a time, and github.cooldownSeconds between them: a burst of messages becomes one
  // request, not many at once on the owner's token, and the same item cannot become two issues.
  const githubBusy = new Set();
  const githubLast = new Map();
  async function oneGitHubCall(policy, call, fromMe = false) {
    const wait = getConfig().github.cooldownSeconds * 1000 - (clock() - (githubLast.get(policy.id) ?? -Infinity));
    if (githubBusy.has(policy.id)) return 'A GitHub request for this chat is still running; try again in a moment.';
    // The owner is never kept waiting by a member's request; only one request still runs at a time.
    if (wait > 0 && !fromMe) return `Please wait ${Math.ceil(wait / 1000)}s between GitHub commands in this chat.`;
    githubBusy.add(policy.id);
    githubLast.set(policy.id, clock());
    try { return await call(); } finally { githubBusy.delete(policy.id); }
  }
  // Reminders and open items: anyone the chat lets call the bot may use them (the chat's "callers" setting).
  const itemCommands = items ? createItemCommands({ items, getConfig, clock }) : null;
  // Changes waiting for the owner's "confirm <code>" (GitHub and Google), and the GitHub changes themselves.
  const waiting = pending || createPending({ clock });
  const githubChanges = github ? createGitHubChanges({ getConfig, github, pending: waiting, oneGitHubCall,
    isBusy: chatId => githubBusy.has(chatId), clock, log }) : null;
  const googleCommands = google ? createGoogleCommands({ getConfig, google, pending: waiting, clock, log }) : null;

  // The owner's go-ahead for a waiting change, or dropping one (or all of them) in this chat.
  async function confirmCommand(policy, args, fromMe) {
    const word = policy.buzzword;
    if (!fromMe) return 'Only the owner of this bot can confirm changes.';
    if (args.length !== 1 || !/^\d{4}$/.test(args[0])) {
      const list = waiting.list(policy.id);
      return list.length ? ['Waiting for your confirm code:', ...list.map(entry => `${entry.code}: ${entry.what}`)].join('\n')
        : `Usage: ${word} confirm <code>, with the 4-digit code from the change you asked for. Nothing is waiting now.`;
    }
    const entry = waiting.peek(policy.id, args[0]);
    if (!entry) return `Nothing is waiting with code ${args[0]} in this chat (codes last ${Math.round(waiting.ttlMs / 60000)} minutes and work once).`;
    // A busy chat or a full hourly limit leaves the code for a second try. Nothing waits between this check and the
    // run, so it still holds when the change starts.
    const blocked = entry.blocked();
    if (blocked) return `${blocked} Code ${args[0]} still works until it runs out.`;
    waiting.take(policy.id, args[0]);
    return entry.run();
  }
  // "draft <target> <what you want>": the AI drafts one change to a linked Google file, a GitHub issue or pull request,
  // or a repository file, from the request, the target as it is now, and the chat's recent messages. Owner only, one AI
  // request like "ask". The AI only proposes (drafts.js checks its JSON); the change waits for the owner's confirm
  // code like any other, and links the AI added that were not already in the target become [link].
  async function draftCommand(policy, args, rest, fromMe, message) {
    const word = policy.buzzword;
    const usage = `Usage: ${word} draft doc|sheet|slides <name> <what you want>, ${word} draft github #N <what you want>, or ` +
      `${word} draft github file <path> <what you want>. The AI drafts the change; nothing happens until you confirm it.`;
    if (!fromMe) return 'Only the owner of this bot can ask the AI for a draft.';
    if (!summaryService) return 'AI service unavailable.';
    const where = (args[0] || '').toLowerCase();
    let kind, request, read, apply;
    if (['doc', 'sheet', 'slides'].includes(where)) {
      if (!googleCommands) return 'Google files are not available here.';
      if (!args[1]) return usage;
      const found = googleCommands.findFile(policy, where, args[1]);
      if (found.text) return found.text;
      kind = where;
      request = typedAfter(message, rest, phrase(args[0], args[1]));
      read = () => googleCommands.source(found.file);
      apply = (draft, clean, versions) => googleCommands.applyDraft(policy, found.file, draft, clean, versions);
    } else if (where === 'github' || where === 'gh') {
      if (!github || !githubChanges) return 'GitHub is not available here.';
      if (!policy.githubRepo) return 'This chat is not linked to a GitHub repository.';
      const issue = /^#(\d{1,7})$/.exec(args[1] || '');
      let target;
      if (issue) {
        [kind, target, request] = ['issue', { n: Number(issue[1]) }, typedAfter(message, rest, phrase(args[0], args[1]))];
      } else if ((args[1] || '').toLowerCase() === 'file' && validPath(args[2] || '')) {
        [kind, target, request] = ['file', { path: args[2] }, typedAfter(message, rest, phrase(args[1], args[2]))];
      } else return usage;
      read = () => githubChanges.source(policy, target);
      apply = (draft, clean, versions) => githubChanges.applyDraft(policy, target, draft, clean, versions);
    } else return usage;
    if (!request.trim()) return usage;
    let seen;
    try { seen = await read(); } catch (error) {
      if (error instanceof GoogleError) return `Google: ${error.message}`;
      if (error instanceof GitHubError) return `GitHub: ${error.message}`;
      throw error;
    }
    const result = await summaryService({ chatId: policy.id, source: 'chat', message,
      draft: { request: request.trim(), target: seen.target, content: seen.content, actions: ACTIONS[kind].join('\n') } });
    if (typeof result === 'string') return result;
    const parsed = parseDraft(result.draft);
    if (parsed.error) return `No draft: ${parsed.error}`;
    if (parsed.draft.action === 'none') return `The AI did not draft a change: ${cleanText(String(parsed.draft.reason || 'no reason given'), 300)}`;
    const problem = checkDraft(kind, parsed.draft);
    if (problem) return `No draft: ${problem}`;
    return apply(parsed.draft, text => onlyKnownLinks(String(text ?? ''), seen.content), seen.seen || {});
  }

  function cancelCommand(policy, args, fromMe) {
    if (!fromMe) return 'Only the owner of this bot can cancel changes.';
    if (args.length > 1 || (args.length && !/^\d{4}$/.test(args[0]))) return `Usage: ${policy.buzzword} cancel [code]`;
    const dropped = waiting.cancel(policy.id, args[0] ?? null);
    return dropped ? `Cancelled ${dropped === 1 ? 'that change' : `${dropped} waiting changes`}.` : 'Nothing was waiting.';
  }

  // Owner-only commands are listed only to the owner; other members do not need to see moderation tools.
  function help(policy, fromMe) {
    const word = policy.buzzword;
    return [
      `Commands (start with "${word}"):`,
      `${word} ping - show this chat's ID and what the bot may do here`,
      `${word} check <text> - score a message with the spam rules`,
      ...(policy.hub ? [
        `${word} files - list this chat's shared files`,
        `${word} send <name> - post one of those files here`
      ] : []),
      ...(items ? [
        `${word} remind <when> <what> - post a reminder here then, e.g. ${word} remind Fri 17:00 submit report (${zoneLabel(getConfig().reminders.timeZone)})`,
        `${word} issue <what> - add an open item without a time`,
        `${word} issues - open items${policy.detect ? ' and requests spotted in messages' : ''}`,
        `${word} keep N [when] / ${word} drop N / ${word} done N - keep a spotted request, remove an item, close an item`
      ] : []),
      `${word} summary [hours] - summary of recent messages (needs AI on for this chat)`,
      ...(ideas ? [
        `${word} idea <text> - save an idea for the team; ${word} ideas lists them`
      ] : []),
      ...(ideas && fromMe ? [
        `${word} findings [github] - the AI turns the ideas and recent messages into findings, saved for later (and posted ` +
          `as a GitHub issue with "github"); ${word} findings show posts the last ones, ${word} findings post sends them to ` +
          'GitHub without a new AI run (owner only, needs AI on)',
        `${word} ideas drop N / ${word} ideas clear - remove one idea, or all of them (owner only)`
      ] : []),
      ...(github && policy.githubRepo && (fromMe || policy.githubMembers === true) ? [
        `${word} github issue <title> | issues | prs | pr N | #N | files | file <path> | commits - this chat's GitHub ` +
          `repository, ${policy.githubRepo} (also ${word} gh; ${word} github alone lists everything${fromMe ? ', changes too' : ''})`
      ] : []),
      ...(google && policy.googleFiles?.length && (fromMe || policy.googleMembers === true) ? [
        `${word} google - this chat's Google files; ${word} doc <name> / ${word} sheet <name> [range] / ${word} slides <name> - read one` +
          (fromMe ? `; add "append", "add", "set", "clear", "delete" or "replace" to change it (owner only; ${word} doc <name> help lists them)` : '')
      ] : []),
      ...(fromMe && summaryService && ((github && policy.githubRepo) || (google && policy.googleFiles?.length)) ? [
        `${word} draft doc|sheet|slides <name> <what you want> / ${word} draft github #N|file <path> <what you want> - the AI drafts ` +
          'the change from the chat and the file; you confirm it with a code (owner only, needs AI on)'
      ] : []),
      ...(fromMe && (github || google) ? [
        `${word} confirm <code> / ${word} cancel [code] - go ahead with, or drop, a change that waits for you (owner only)`
      ] : []),
      ...(fromMe ? [
        `${word} ask <question> - answer from this chat's recent messages, notes${policy.hub ? ' and files' : ''} (owner only, needs AI on)`,
        `${word} ask+ <question> - the same, thinking harder (${getConfig().summary.boostEffort} effort) for this one answer (owner only)`,
        ...(efforts ? [`${word} effort [level [hours] | reset] - how hard the AI thinks in this chat for a while: ` +
          `${EFFORTS.join(', ')} (owner only)`] : []),
        `${word} notes - size of the notes kept from this chat's older messages (owner only; text stays on the server)`,
        ...(items && policy.ai === true ? [`${word} spot - look for requests and deadlines in the new messages now (owner only, needs AI on)`] : []),
        ...(instructions ? [`${word} instructions [show | set <text> | clear] - standing instructions for the AI in this chat, e.g. ` +
          `${word} instructions set Answer in Traditional Chinese (owner only)`] : []),
        ...(policy.hub ? [`${word} sync - update this chat's files from the git repo its folder was cloned from (owner only)`] : []),
        `${word} spam - reply to a message with this to delete it and its future copies (owner only)`,
        `${word} kick / ${word} spam kick - reply to a message to remove its sender from the group (owner, needs admin)`,
        `${word} trust / ${word} untrust - reply to a message to exempt its sender from spam checks (owner only)`,
        `${word} lock [minutes] / ${word} unlock - only admins can send (owner, needs admin)`
      ] : []),
      `${word} help - this list`
    ].join('\n');
  }

  function ping(policy) {
    return [
      'pong',
      policy.label ? `Chat: ${policy.label}` : null,
      `Chat ID: ${policy.id}`,
      `Permissions: ${permissionText(policy)}`
    ].filter(Boolean).join('\n');
  }

  function check(text) {
    if (!text) return 'Usage: check <message text>';
    // A fresh detector, so test messages never count towards anyone's repetition history.
    const result = new SpamDetector(getConfig(), { learned }).check({ chatId: 'command', senderId: 'command', text });
    const config = getConfig();
    const deletable = config.deletion.mode === 'strict' ? result.certain.length > 0 : result.score >= config.deletion.threshold;
    const flagged = result.isSpam ? 'Would be flagged. ' : '';
    const lines = [`Score ${result.score} (flag at ${config.threshold}). ${flagged}${deletable ? 'Would be deleted where spam is set to delete.' : 'Would not be deleted.'}`];
    if (result.strict.length) lines.push(`Pattern match: ${result.strict.join('; ')}`);
    if (result.certain.length) lines.push(`Delete signal: ${result.certain.join('; ')}`);
    if (result.reasons.length) lines.push(`Signals: ${result.reasons.map(reason => reason.detail).join('; ')}`);
    return lines.join('\n');
  }

  // Only this chat's hub, found from the chat's own settings; nothing a member types can name another folder.
  function hub(policy) {
    if (!policy.hub) return { error: 'No shared files are set up for this chat.' };
    const dir = hubFolder(hubsRoot, policy.hub);
    if (!dir) return { error: 'This chat\'s file folder is missing or is not a plain folder.' };
    return { dir, ...listHub(dir) };
  }

  function files(policy) {
    const found = hub(policy);
    if (found.error) return found.error;
    if (!found.files.length) return `No files yet. The owner adds them to hubs/${policy.hub}/ on the server.`;
    const max = getConfig().hubs.maxListed;
    const shown = found.files.slice(0, max).map(f => `- ${f.name} (${formatSize(f.size)})`);
    const more = found.files.length > max ? [`...and ${found.files.length - max} more`] : [];
    return [`Files for this chat (${found.files.length}${found.truncated ? '+' : ''}):`, ...shown, ...more,
      `Send one with: ${policy.buzzword} send <name>`].join('\n');
  }

  function send(policy, query) {
    if (!query) return `Usage: ${policy.buzzword} send <file name>`;
    const found = hub(policy);
    if (found.error) return found.error;
    const { file, matches } = findHubFile(found.files, query);
    if (!file) {
      if (!matches?.length) return `No file matching "${query}". ${policy.buzzword} files lists them.`;
      return [`Several files match "${query}":`, ...matches.slice(0, 10).map(f => `- ${f.name}`)].join('\n');
    }
    const maxBytes = getConfig().hubs.maxSendMiB * 1024 * 1024;
    let checked;
    try { checked = hubFilePath(found.dir, file); } catch { return `${file.name} cannot be sent: it is no longer a plain file in this chat's folder.`; }
    if (checked.size > maxBytes) return `${file.name} is ${formatSize(checked.size)}; the limit is ${getConfig().hubs.maxSendMiB} MB.`;
    return { text: `${file.name} (${formatSize(checked.size)})`, file: checked.full };
  }

  // The notes outlive the messages they came from (people who joined later, messages deleted since), so their text is
  // never posted in the chat: this reply only says how big they are and where to read them.
  function showNotes(policy, fromMe) {
    if (!fromMe) return 'Only the owner of this bot can check the notes.';
    const setting = policy.keepDays > 0 ? `Messages older than ${policy.keepDays} days are folded in${policy.ai === true ? '' : ' once AI is on'}.`
      : 'Condensing is off for this chat (keepDays is 0).';
    const info = notes ? notes.stat(policy.id) : { chars: 0 };
    if (!info.chars) return `No notes yet. ${setting}`;
    const when = new Date(info.updated).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      timeZone: getConfig().reminders.timeZone });
    return `Notes: ${info.lines} lines, ${info.chars} characters, updated ${when}. ${setting}\n` +
      `They are not posted here. Read them on the server with: node src/cli.js notes "${policy.label || policy.id}". ` +
      `${policy.buzzword} ask can use them.`;
  }

  // The owner asks for a check for requests now (otherwise spotting only runs at reminders.detectTimes).
  async function spot(policy, fromMe, message) {
    if (!fromMe) return 'Only the owner of this bot can start a check for requests.';
    if (!items || typeof summaryService?.detect !== 'function') return 'Spotting requests is not available here.';
    const result = await summaryService.detect({ chatId: policy.id, source: 'chat', message });
    if (!result.done) return `Not looked at: ${result.text}`;
    if (!result.added.length) return result.text;
    const zone = getConfig().reminders.timeZone;
    return [result.text,
      ...result.added.map(item => `${item.n}. ${item.text}${item.due ? ` (due ${formatWhen(item.due, zone, clock())})` : ''}`),
      `Keep one with ${policy.buzzword} keep N [when]` +
        (github && policy.githubRepo ? `, open it as a GitHub issue with ${policy.buzzword} github issue N` : '') +
        `, or remove it with ${policy.buzzword} drop N.`].join('\n');
  }

  // The text after "set" as the owner typed it. The router's copy went through the buzzword matching, which turns
  // full-width punctuation such as "，" into ASCII and drops joiners (emoji); used only when it is the same text.
  function typedText(message, normalized) {
    const raw = /^[^\n]*?\b(?:instructions?|rules)[ \t]+set(?:\s+|$)([\s\S]*)$/i.exec(String(message?.body ?? ''));
    if (!raw) return normalized;
    return normalizeCall(raw[1]) === normalizeCall(normalized) ? raw[1] : normalized;
  }

  // The owner's standing instructions for the AI in this chat: their size, show, set or clear. Others get nothing, not
  // even the size. The text is posted only on "show", since everyone in the chat reads the reply.
  function instructionsCommand(policy, text, fromMe, message) {
    const word = policy.buzzword;
    if (!fromMe) return 'Only the owner of this bot can see or change this chat\'s instructions.';
    if (!instructions) return 'Instructions are not available here.';
    const usage = `Usage: ${word} instructions (their size), ${word} instructions show, ${word} instructions set <text>, ` +
      `${word} instructions clear. For example: ${word} instructions set Answer in Traditional Chinese, at most 3 lines.`;
    const applies = policy.ai === true ? 'The AI follows them in this chat\'s summaries, answers and spotted requests.'
      : 'AI is off in this chat, so they are not used until you turn it on.';
    const command = text.trim();
    if (!command || /^show\s*$/i.test(command)) {
      const { text: current, problem } = instructions.load(policy.id);
      if (problem) return problem;
      if (!current) return `No instructions for this chat.\n${usage}`;
      if (command) return `Instructions for this chat:\n${current}\n${applies}`;
      const lines = current.split('\n').length;
      return `This chat has instructions (${[...current].length} characters, ${lines} line${lines === 1 ? '' : 's'}). ${applies} ` +
        `They are not posted here. ${word} instructions show posts them (everyone in this chat can read them); on the ` +
        `server: node src/cli.js instructions "${policy.label || policy.id}".`;
    }
    if (/^clear\s*$/i.test(command)) return instructions.clear(policy.id) ? 'Instructions cleared.' : 'This chat had no instructions.';
    const set = /^set(?:\s+|$)([\s\S]*)$/i.exec(command);
    if (!set) return usage;
    const cleaned = cleanInstructions(typedText(message, set[1]));
    if (cleaned.error) return cleaned.error === 'empty' ? usage : cleaned.error;
    instructions.write(policy.id, cleaned.text);
    return `Saved (${[...cleaned.text].length} characters). ${applies} ` +
      'Everyone in this chat can read what you typed; to set them privately, use the console command in COMMANDS.md.';
  }

  // The owner sets how hard the AI thinks in this chat for a while: summaries, answers and spotted requests here use it
  // until it runs out, the bot restarts, or the owner resets it. Condensing keeps summary.effort.
  function effortCommand(policy, text, fromMe) {
    const word = policy.buzzword;
    if (!fromMe) return 'Only the owner of this bot can change the AI effort.';
    if (!efforts) return 'Changing the AI effort is not available here.';
    const config = getConfig();
    const base = config.summary.effort;
    const max = config.summary.maxBoostHours;
    const zone = config.reminders.timeZone;
    const usage = `Usage: ${word} effort (show it), ${word} effort <${EFFORTS.join('|')}> [hours, e.g. 2 or 30m; ` +
      `default 1, at most ${max}], ${word} effort reset. For one question only: ${word} ask+ <question>.`;
    const parts = text.trim().split(/\s+/).filter(Boolean);
    const level = (parts[0] || '').toLowerCase();
    if (!parts.length) {
      const boost = efforts.get(policy.id);
      return boost
        ? `AI effort in this chat: ${boost.effort} until ${formatWhen(boost.until, zone, clock())} (${zoneLabel(zone)}), then ${base} again.`
        : `AI effort in this chat: ${base} (the default). Raise it for a while with ${word} effort high 2h, or for one ` +
          `question with ${word} ask+ <question>.`;
    }
    if (['reset', 'off', 'default'].includes(level) && parts.length === 1) {
      return efforts.clear(policy.id) ? `AI effort in this chat is back to ${base}.` : `AI effort in this chat is already ${base}, the default.`;
    }
    if (!EFFORTS.includes(level) || parts.length > 2) return usage;
    const hours = parts.length === 2 ? parseDuration(parts[1]) : 1;
    if (!hours || hours > max) return usage;
    if (policy.ai !== true) return 'AI is off in this chat, so there is no effort to change.';
    if (level === base) {
      efforts.clear(policy.id);
      return `AI effort in this chat: ${base}, the default.`;
    }
    const until = efforts.set(policy.id, level, hours);
    const cost = EFFORTS.indexOf(level) > EFFORTS.indexOf(base) ? ' Answers take longer and use more of your plan or API credits.' : '';
    return `AI effort in this chat: ${level} until ${formatWhen(until, zone, clock())} (${zoneLabel(zone)}), then ${base} again. ` +
      `It applies to summaries, answers and spotted requests here; condensing stays at ${base}. A restart also ends it.${cost}`;
  }

  // The chat's linked GitHub repository (chats[].githubRepo): open an issue, list issues and pull requests, show one
  // pull request; everything else (issues by number, comments, files, commits, merging) is in github-changes.js.
  // Reading: the owner always, members only where the owner set githubMembers. Changing: the owner only, and anything
  // that removes, closes, merges or replaces waits for the owner's confirm code.
  async function githubCommand(policy, text, fromMe, message) {
    const word = policy.buzzword;
    const repo = policy.githubRepo;
    if (!github) return 'GitHub is not available here.';
    if (!repo) return `This chat is not linked to a GitHub repository. The owner links it on the server: node src/cli.js github "${policy.label || policy.id}" --repo OWNER/REPO`;
    if (!fromMe && policy.githubMembers !== true) return 'Only the owner of this bot can use GitHub from this chat.';
    const usage = [`GitHub for this chat: ${repo}`,
      `${word} github issue <title> - open an issue (or ${word} github issue N for item N of ${word} issues; a spotted one is kept too)`,
      `${word} github issues / prs - open issues / pull requests; ${word} github pr N - one pull request`,
      `${word} github #N - an issue or pull request with its latest comments; ${word} github #N comments - more comments`,
      `${word} github files [folder] / ${word} github file <path> - the repository's files`,
      `${word} github commits [branch] / ${word} github commit <id> - recent commits, one commit`,
      ...(fromMe ? [
        `Changes (owner only; the ones marked * wait for ${word} confirm <code>):`,
        `${word} github #N comment <text> / label <a, b> / close* [not planned] / reopen* / title* <text> / body* <text> / delete*`,
        `${word} github comment ID edit* <text> / delete*`,
        `${word} github pr N merge* [merge|squash|rebase] / close*`,
        `${word} github file <path> write* (then the new content on the next lines) / delete*`,
        `${word} github commit <id> revert*`,
        `File changes and reverts go ${getConfig().github.changes === 'direct' ? 'straight onto the default branch' : 'on a new branch with a pull request'}.`
      ] : [])].join('\n');
    const [sub = '', ...args] = text.trim().split(/\s+/).filter(Boolean);
    const command = sub.toLowerCase();
    const rest = text.trim().replace(/^\S+\s*/, '');
    try {
      if (command === 'issues') return args.length ? usage : await oneGitHubCall(policy, async () => issuesText(repo, await github.listIssues(repo)), fromMe);
      if (command === 'prs' || command === 'pulls') {
        return args.length ? usage : await oneGitHubCall(policy, async () => pullsText(repo, await github.listPulls(repo), word), fromMe);
      }
      if ((command === 'pr' || command === 'pull') && args.length === 1) {
        if (!/^#?\d{1,7}$/.test(args[0])) return usage;
        return await oneGitHubCall(policy, async () => pullText(repo, await github.getPull(repo, Number(args[0].replace('#', '')))), fromMe);
      }
      if (command === 'merge') return `To merge pull request N: ${word} github pr N merge (you get a code to confirm).`;
      if (command === 'issue') return await openIssue(policy, rest, fromMe, message);
      const changed = githubChanges ? await githubChanges.run(policy, { sub: command, args, rest: text, fromMe, message }) : null;
      return changed ?? usage;
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      return `GitHub: ${error.message}`;
    }
  }

  // "github issue <title>", or "github issue N" for item N of the chat's list. A request the AI spotted and nobody
  // kept yet is kept first, exactly as "keep N" would (same default reminder), so one command does both. It is kept
  // only once the request may go ahead: a busy chat, a cooldown or the hourly limit leaves it a suggestion.
  async function openIssue(policy, text, fromMe, message) {
    const word = policy.buzzword;
    const repo = policy.githubRepo;
    const config = getConfig();
    if (!text) return `Usage: ${word} github issue <title>, or ${word} github issue N for item N of ${word} issues.`;
    let title = text;
    let item = null;
    if (/^\d{1,4}$/.test(text)) {
      if (!items) return 'The chat\'s list is not available here.';
      const { open, suggested } = items.active(policy.id);
      item = [...open, ...suggested].find(x => x.n === Number(text));
      if (!item) return `There is no open or spotted item ${text}. ${word} issues lists them.`;
      if (item.githubIssue) return `Item ${item.n} is already GitHub issue #${item.githubIssue}.`;
      title = item.text;
    }
    title = cleanText(title, 1000);
    if (!title || [...title].length > 200) return 'An issue title needs 1-200 characters.';
    if (!fromMe && hasLink(title)) return 'Only the owner can put a link in an issue title.';
    return oneGitHubCall(policy, async () => {
      const zone = config.reminders.timeZone;
      let kept = null;
      // Everything up to items.keep runs without yielding (oneGitHubCall calls this at once), so the lookup above is
      // still current and a second message for the same item meets the busy guard. Keep it that way: no await before
      // the keep.
      if (item && item.status === 'suggested') {
        if (!github.hasToken()) {
          return 'GitHub: there is no GITHUB_TOKEN in .env yet (see "GitHub" in COMMANDS.md). The request stays a suggestion.';
        }
        const full = issueLimit();
        if (full) return full;
        const now = clock();
        const result = items.keep(policy.id, item.n, { remindAt: defaultReminder(item.due, config, now),
          source: message?.id?._serialized || null, now, settings: config.reminders });
        // Gone meanwhile (its deadline passed, or the list is full): nothing is opened.
        if (result.error) return result.error;
        item = kept = result.item;
      }
      const body = ['Opened from WhatsApp with the chat bot.'];
      if (kept) body.push('Spotted in the chat\'s messages by the AI.');
      if (item?.due) body.push(`Due: ${formatWhen(item.due, zone, clock())} (${zoneLabel(zone)}).`);
      if (item?.remindAt) body.push(`The chat gets a reminder ${formatWhen(item.remindAt, zone, clock())}.`);
      const reminder = !kept ? '' : kept.remindAt ? `\nReminder ${formatWhen(kept.remindAt, zone, clock())} (${zoneLabel(zone)}).`
        : `\nNo reminder; set one with ${word} keep ${kept.n} <when>.`;
      // Kept, but no issue: say so, so nobody thinks the request is still only a suggestion.
      const notOpened = why => `Kept ${kept.n}: ${title}. The issue was not opened. ${why}${reminder}\n` +
        `Try again with ${word} github issue ${kept.n}.`;
      let opened;
      try {
        opened = await openLimited(repo, title, body.join('\n\n'));
      } catch (error) {
        if (!kept || !(error instanceof GitHubError)) throw error;
        return notOpened(`GitHub: ${error.message}`);
      }
      if (opened.text) return kept ? notOpened(opened.text) : opened.text;
      const { issue } = opened;
      if (item) items.mark(policy.id, item.n, 'githubIssue', issue.number);
      const what = kept ? `Kept ${kept.n} and opened GitHub issue #${issue.number} in ${repo}`
        : `Opened GitHub issue #${issue.number} in ${repo}${item ? ` for item ${item.n}` : ''}`;
      return `${what}: ${title}${reminder}` + (issue.url.startsWith('https://github.com/') ? `\n${issue.url}` : '');
    }, fromMe);
  }

  // At most github.maxIssuesPerHour issues an hour from all chats. issueLimit: the refusal, or null while there is room.
  function issueLimit() {
    const config = getConfig();
    issuesOpened = issuesOpened.filter(time => time > clock() - 3600000);
    return issuesOpened.length >= config.github.maxIssuesPerHour
      ? `GitHub: at most ${config.github.maxIssuesPerHour} issues an hour can be opened from chats; try again later.` : null;
  }

  // { issue }, or { text } when the hourly limit is reached.
  async function openLimited(repo, title, body) {
    const full = issueLimit();
    if (full) return { text: full };
    issuesOpened.push(clock());
    return { issue: await github.openIssue(repo, { title, body }) };
  }

  // The chat's ideas board (src/ideas.js): anyone the chat lets call the bot saves ideas, with no AI; only the owner
  // removes them, and only the owner asks the AI for findings.
  function ideaCommand(policy, text, fromMe) {
    const word = policy.buzzword;
    if (!ideas) return 'The ideas board is not available here.';
    if (!text.trim()) return `Usage: ${word} idea <text>, e.g. ${word} idea Let the judges try the demo on their own phones`;
    if (!fromMe && hasLink(text)) return 'Only the owner can put a link in an idea.';
    const result = ideas.add(policy.id, { text, by: fromMe ? 'owner' : 'member', now: clock() });
    if (result.error) return result.error === 'empty' ? `Usage: ${word} idea <text>` : result.error;
    return `Idea ${result.idea.n} saved. ${word} ideas lists them.`;
  }

  function ideasCommand(policy, args, fromMe) {
    const word = policy.buzzword;
    if (!ideas) return 'The ideas board is not available here.';
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'drop' || sub === 'clear') {
      if (!fromMe) return 'Only the owner of this bot can remove ideas.';
      if (sub === 'clear') {
        if (args.length !== 1) return `Usage: ${word} ideas clear`;
        const count = ideas.clear(policy.id);
        return count ? `All ${count} ideas removed. The saved findings stay (${word} findings show).` : 'There were no ideas.';
      }
      if (args.length !== 2 || !/^\d{1,4}$/.test(args[1])) return `Usage: ${word} ideas drop N`;
      return ideas.drop(policy.id, Number(args[1])) ? `Idea ${Number(args[1])} removed.` : `There is no idea ${Number(args[1])}.`;
    }
    if (args.length) return `Usage: ${word} ideas, or ${word} ideas drop N / ${word} ideas clear (owner only)`;
    const list = ideas.read(policy.id).ideas;
    if (!list.length) return `No ideas yet. Save one with ${word} idea <text>.`;
    const shown = list.slice(-30);
    return [`Ideas (${list.length}${list.length > shown.length ? `, the newest ${shown.length} shown` : ''}):`,
      ...shown.map(idea => `${idea.n}. ${idea.text}`), `The owner turns them into findings with ${word} findings.`].join('\n');
  }

  async function findingsCommand(policy, args, fromMe, message) {
    const word = policy.buzzword;
    if (!fromMe) return 'Only the owner of this bot can ask for findings.';
    if (!ideas || typeof summaryService !== 'function') return 'Findings are not available here.';
    const zone = getConfig().reminders.timeZone;
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'show' && args.length === 1) {
      const saved = ideas.latestFindings(policy.id);
      if (!saved) return `No findings saved yet. Ask for them with ${word} findings.`;
      return `Findings from ${formatWhen(saved.at, zone, clock())} (${saved.ideas} ideas, ${saved.messages} messages` +
        `${saved.issue ? `, GitHub #${saved.issue}` : ''}):\n${saved.text}`;
    }
    const toGitHub = sub === 'github' && args.length === 1;
    const post = sub === 'post' && args.length === 1;
    if (args.length && !toGitHub && !post) return `Usage: ${word} findings, ${word} findings github, ${word} findings post, or ${word} findings show`;
    // Checked before the AI runs, so a missing link costs nothing.
    if ((toGitHub || post) && (!github || !policy.githubRepo)) {
      return `This chat is not linked to a GitHub repository; ${word} findings saves them on the server only.`;
    }
    if (post) {
      // The saved findings, without a new AI run: for when posting them failed or was not asked for.
      const saved = ideas.latestFindings(policy.id);
      if (!saved) return `No findings saved yet. Ask for them with ${word} findings github.`;
      if (saved.issue) return `The latest findings are already GitHub issue #${saved.issue}.`;
      return postFindings(policy, saved, `Posting the findings from ${formatWhen(saved.at, zone, clock())}.`);
    }
    const before = ideas.latestFindings(policy.id)?.at;
    const reply = await summaryService({ chatId: policy.id, source: 'chat', message });
    if (!toGitHub || typeof reply !== 'string' || !reply.startsWith('Findings (')) return reply;
    const saved = ideas.latestFindings(policy.id);
    if (!saved || saved.at === before) return reply; // nothing new was saved
    return postFindings(policy, saved, reply);
  }

  // Saved findings as a GitHub issue (one GitHub request per chat at a time, within the hourly limit).
  async function postFindings(policy, saved, reply) {
    const word = policy.buzzword;
    const zone = getConfig().reminders.timeZone;
    const title = `Findings – ${formatWhen(saved.at, zone, clock())} (${zoneLabel(zone)})`;
    const body = `${saved.text}\n\nWritten by the AI from ${saved.ideas} ideas and ${saved.messages} messages in the team's WhatsApp chat.`;
    const later = `The findings are saved; post them later with ${word} findings post.`;
    try {
      const result = await oneGitHubCall(policy, () => openLimited(policy.githubRepo, title, body), true);
      if (typeof result === 'string') return `${reply}\nGitHub: ${result} ${later}`;
      if (result.text) return `${reply}\n${result.text} ${later}`;
      ideas.markIssue(policy.id, saved.at, result.issue.number);
      return `${reply}\nAlso on GitHub as issue #${result.issue.number}` +
        (result.issue.url.startsWith('https://github.com/') ? `\n${result.issue.url}` : '');
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      return `${reply}\nGitHub: ${error.message} ${later}`;
    }
  }

  async function answerRepo(repo, query) {
    if (query.kind === 'assigned') return 'I can’t match WhatsApp accounts to GitHub assignees.';
    if (query.kind === 'issues' || query.kind === 'pulls') {
      const issues = query.kind === 'issues';
      const rows = issues ? await github.listIssues(repo) : await github.listPulls(repo);
      const kind = issues ? 'issues' : 'pull requests';
      if (!rows.length) return `No open ${kind}.`;
      const first = rows.slice(0, 3).map(row => `#${row.number} ${agentText(row.title, 90)}`).join(', ');
      return `Latest open ${kind}: ${first}.`;
    }
    const pull = query.kind === 'pull';
    const row = pull ? await github.getPull(repo, query.number) : await github.getIssue(repo, query.number);
    if (!pull && row.pull) return `#${query.number} is a pull request.`;
    return `#${query.number} is ${row.merged ? 'merged' : row.state === 'closed' ? 'closed' : 'open'}: ${agentText(row.title, 120)}.`;
  }

  // Auto-tracking has its own opt-in. Use the normal GitHub limits and the actual source event for each write.
  async function trackIssue(policy, proposal, canAct) {
    const { event, action, title, number, body } = proposal;
    if (!canAct(event)) return '';
    const repo = policy.githubRepo;
    const repository = await github.repository(repo);
    if (!repository.private || !repository.issues || !canAct(event)) return '';
    const sourceId = event.message.id._serialized;
    if (action === 'open') {
      if (issueLimit() || await github.hasOpenIssueTitle(repo, title) || !canAct(event) || issueLimit() ||
          !reserveAgentWrite(repo, policy.id, sourceId, title)) return '';
      const result = await openLimited(repo, title, 'Tracked from a task discussed in the linked WhatsApp chat.');
      if (!Number.isSafeInteger(result.issue?.number) || result.issue.number < 1) return '';
      return `Opened #${result.issue.number} ${title}.\nhttps://github.com/${repo}/issues/${result.issue.number}`;
    }
    const issue = await github.getIssue(repo, number);
    if (issue.pull || !canAct(event)) return '';
    const targetState = action === 'close' ? 'closed' : 'open';
    if (action !== 'comment' && issue.state === targetState) return '';
    if (githubChanges.reserveWrite() || !reserveAgentWrite(repo, policy.id, sourceId)) return '';
    if (action === 'comment') { await github.addComment(repo, number, body); return ''; }
    const changed = await github.editIssue(repo, number, action === 'close' ? { state: 'closed', state_reason: 'completed' } : { state: 'open' });
    if (changed.state !== targetState) return '';
    return `${action === 'close' ? 'Closed' : 'Reopened'} #${number} ${agentText(issue.title, 120)}.\nhttps://github.com/${repo}/issues/${number}`;
  }

  async function runAgent(policy, { events, trigger, canAct }) {
    const repo = policy.githubRepo;
    const hasGitHub = Boolean(repo && github?.hasToken());
    const canOpen = event => hasGitHub && !event.addressed &&
      (event.message.fromMe === true || policy.githubMembers === true) && taskHint(event.text);
    const stateEvent = policy.githubAutoIssues && hasGitHub ?
      events.findLast(event => !event.addressed && event.message.fromMe === true && canAct(event) && issueUpdate(event.text)) : null;
    const answer = trigger && !trigger.repo ? trigger.event : null;
    const allowIssue = event => policy.githubAutoIssues && !stateEvent && canOpen(event);
    const model = await summaryService?.burst?.({ policy, events, answer, canOpen: allowIssue, canAct });
    const proposal = stateEvent ? { ...issueUpdate(stateEvent.text), event: stateEvent } :
      model?.issue && allowIssue(model.issue.event) ? { ...model.issue, action: 'open' } : null;
    let reply = trigger && !trigger.repo ? (model?.reply || 'I don’t have enough context to answer that.') : '';
    let notice = '';
    if ((trigger?.repo || proposal) && hasGitHub) {
      await oneGitHubCall(policy, async () => {
        if (proposal) {
          try { notice = await trackIssue(policy, proposal, canAct); }
          catch { log('[ASSISTANT] The issue change was not confirmed.'); }
        }
        if (trigger?.repo && canAct(trigger.event)) {
          try { reply = await answerRepo(repo, trigger.repo); }
          catch { reply = 'I couldn’t verify that on GitHub.'; }
        }
      });
    }
    if (trigger?.repo && !hasGitHub) reply = 'I couldn’t verify that on GitHub.';
    if (trigger && !canAct(trigger.event)) reply = '';
    if (!notice && !reply) return null;
    const event = reply ? trigger.event : proposal?.event;
    if (!event || !canAct(event)) return null;
    // Outcome first, optional answer next, and a single trusted link at the end.
    const [outcome, url] = notice.split('\n');
    return { event, text: [outcome, reply, url].filter(Boolean).join('\n') };
  }

  async function run(policy, rest, { fromMe = false, message, onUnknown = null } = {}) {
    const [name = 'help', ...args] = rest.split(/\s+/).filter(Boolean);
    switch (name.toLowerCase()) {
      case 'ping': case 'id': case 'test': return ping(policy);
      case 'check': return check(rest.slice(rest.toLowerCase().indexOf('check') + 5).trim());
      case 'files': return files(policy);
      case 'send': return send(policy, rest.replace(/^\s*send\b/i, '').trim());
      case 'summary': case 'summarise': case 'summarize':
        return summaryService ? summaryService({ chatId: policy.id, source: 'chat', message, hours: args[0] }) : 'Summary service unavailable.';
      case 'ask': case 'ask+':
        return summaryService ? summaryService({ chatId: policy.id, source: 'chat', message }) : 'AI service unavailable.';
      case 'effort':
        return effortCommand(policy, rest.replace(/^\s*\S+/, ''), fromMe);
      case 'github': case 'gh':
        return githubCommand(policy, rest.replace(/^\s*\S+/, ''), fromMe, message);
      case 'idea':
        return ideaCommand(policy, rest.replace(/^\s*\S+\s*/, ''), fromMe);
      case 'ideas':
        return ideasCommand(policy, args, fromMe);
      case 'findings':
        return findingsCommand(policy, args, fromMe, message);
      case 'notes': return showNotes(policy, fromMe);
      case 'sync':
        if (!fromMe) return 'Only the owner of this bot can sync the files.';
        if (args.length) return `Usage: ${policy.buzzword} sync`;
        return syncHub ? syncHub(policy) : 'Sync is not available here.';
      case 'remind': case 'issue': case 'todo': case 'issues': case 'reminders': case 'todos': case 'keep': case 'drop': case 'done': {
        if (!itemCommands) return 'Reminders are not available here.';
        const text = rest.replace(/^\s*\S+\s*/, '');
        const command = name.toLowerCase();
        if (command === 'remind') return itemCommands.remind(policy, text, fromMe, message);
        if (command === 'issue' || command === 'todo') return itemCommands.issue(policy, text, fromMe);
        if (command === 'keep') return itemCommands.keep(policy, text, message);
        if (command === 'drop' || command === 'done') return itemCommands.close(policy, text, command === 'done' ? 'done' : 'dropped');
        // The spotted list mentions "github issue N" only to someone who may use it here.
        return itemCommands.list(policy, { github: Boolean(github && policy.githubRepo && (fromMe || policy.githubMembers === true)) });
      }
      case 'spot':
        if (args.length) return `Usage: ${policy.buzzword} spot`;
        return spot(policy, fromMe, message);
      case 'instructions': case 'instruction': case 'rules':
        return instructionsCommand(policy, rest.replace(/^\s*\S+[ \t]*/, ''), fromMe, message);
      case 'google': case 'gdocs': case 'doc': case 'docs': case 'sheet': case 'sheets': case 'slides': case 'slide':
        if (!googleCommands) return 'Google files are not available here.';
        return googleCommands.run(policy, { command: name.toLowerCase(), args, rest, fromMe, message });
      case 'draft': return draftCommand(policy, args, rest, fromMe, message);
      case 'confirm': return confirmCommand(policy, args, fromMe);
      case 'cancel': return cancelCommand(policy, args, fromMe);
      case 'help': return help(policy, fromMe);
      default:
        if (onUnknown) { onUnknown(); return null; }
        return `Unknown command "${name}".\n${help(policy, fromMe)}`;
    }
  }
  run.agent = runAgent;
  return run;
}

module.exports = { createCommands };
