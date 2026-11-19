'use strict';

const { resumeCommand } = require('./hints');
const path = require('node:path');
const { ROOT, loadConfig } = require('./config');
const { SpamDetector } = require('./detector');

// ANTHROPIC_API_KEY for optional summaries can live in .env next to config.json.
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env: summaries stay off */ }

const HELP = `Commands:
  npm start                    Run silently; standalone discovery works with no chats (hosted setup: see README)
  npm run setup                Choose chats: receive / send / buzzword / spam, then run the bot
  npm run choose               Choose chats, save, and exit (for PythonAnywhere, where the supervisor runs the bot)
  npm run chats                List every chat with its ID (also data/chats.tsv), then exit
  npm run status               Chat settings, archive size and pauses; no login needed
  npm run transcript -- "<chat>" [--hours 24] [--ids]   Archived messages, pseudonymised unless turned off
  npm run summarise -- "<chat>" [--hours 24] [--dry-run] [--ask "question"] [--effort high]  Summary, or an answer, through Claude
                               (ANTHROPIC_API_KEY, or your subscription with summary.provider "claude-code")
  npm run condense -- "<chat>" [--dry-run]  Fold messages older than the chat's keepDays into its notes now
  npm run notes -- "<chat>"    Print a chat's notes (never posted in the chat)
  npm run issues -- "<chat>"   List a chat's open items, reminders and spotted requests
  npm run detect -- "<chat>" [--dry-run]  Look for requests in the chat's new messages now (any chat with AI on)
  npm run ideas -- "<chat>"    The chat's saved ideas and its latest findings (summarise --findings writes new ones)
  npm run github -- "<chat>" [--repo OWNER/REPO [--members] | --off]  Link the chat to a GitHub repository (or
                               unlink it), and check that GITHUB_TOKEN in .env can see it; works while the bot runs
  npm run google -- "<chat>" [--add <link> --name <short name> | --remove <name> | --members | --no-members]
                               Link Google Docs, Sheets or Slides to the chat (or unlink, or let members read them),
                               and check that the service account can open each; works while the bot runs
  npm run instructions -- "<chat>" [--set "text" | --clear]  Show, set or clear the AI's standing instructions
                               for one chat; works while the bot runs
  npm run sync -- "<chat>"     Update the chat's hub folder from its repo, like "<buzzword> sync"
  npm run sync -- "<chat>" --clone <repo address> [--key <deploy key>]  Set an empty hub folder up for sync
  npm run sync -- "<chat>" --adopt   Move the .git folder of an earlier clone out of the hub folder
  npm run demo                 Offline spam examples; no login needed
  npm run check -- "text"      Score one message offline (includes spam you marked)
  npm run resume -- --reviewed Clear a local pause after phone review
  npm test                     Run offline tests
<chat> is the label or ID from config.json "chats". Without npm (PythonAnywhere): node src/cli.js <command> [arguments],
  for example ../node/bin/node src/cli.js notes "<chat>".`;

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function positional(args) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { if (['--hours', '--since', '--ask', '--clone', '--key', '--set', '--effort', '--repo', '--add', '--name', '--remove'].includes(args[i])) i++; continue; }
    values.push(args[i]);
  }
  return values;
}

function sinceFrom(args, config) {
  const since = option(args, '--since');
  if (since) {
    // In reminders.timeZone (London time), like everything else the bot shows; a "Z" or an offset is taken as written.
    const time = require('./when').parseLocalIso(since, config.reminders.timeZone);
    if (time === null) throw new Error('--since needs a date/time such as 2026-10-28T09:00 (London time)');
    return Math.floor(time / 1000);
  }
  const hours = Number(option(args, '--hours', config.summary.hours));
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('--hours needs a positive number');
  return Math.floor(Date.now() / 1000 - hours * 3600);
}

function archiveFor(config) {
  const { Archive } = require('./archive');
  return new Archive(path.join(ROOT, 'data', 'archive'), { maxFileMiB: config.archive.maxFileMiB });
}

function notesFor() {
  const { Notes } = require('./notes');
  return new Notes(path.join(ROOT, 'data', 'notes'));
}

function itemsFor() {
  const { Items } = require('./items');
  return new Items(path.join(ROOT, 'data', 'items'));
}

function ideasFor() {
  const { Ideas } = require('./ideas');
  return new Ideas(path.join(ROOT, 'data', 'ideas'));
}

function instructionsFor() {
  const { Instructions } = require('./instructions');
  return new Instructions(path.join(ROOT, 'data', 'instructions'));
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help') {
    console.log(HELP);
    return;
  }
  // Everything this process and its browser create is readable by this account only.
  process.umask(0o077);
  const config = loadConfig();
  if (command === 'resume') {
    const { SafetyStore } = require('./safety');
    new SafetyStore(path.join(ROOT, '.runtime')).resume({ reviewed: args.includes('--reviewed') });
    console.log('Local pauses cleared; reply and deletion budgets retained. No connection started. Run START.cmd only if the official phone app shows no restriction.');
    return;
  }
  if (['start', 'setup', 'choose', 'chats', 'groups'].includes(command)) {
    // Files from before this version, or from a copy or unzip, may still be readable by others: fix them first.
    const { lockDown, lockDownSummary } = require('./private-files');
    const summary = lockDownSummary(ROOT, lockDown(ROOT));
    if (summary) console.log(summary);
    const { startWhatsApp } = require('./bot');
    return startWhatsApp(config, { mode: command === 'groups' ? 'chats' : command });
  }
  if (command === 'status') {
    const { buildPolicies, permissionText, terminalText } = require('./chats');
    const { SafetyStore } = require('./safety');
    const { hasApiKey } = require('./summarise');
    const { createHash } = require('node:crypto');
    const archive = archiveFor(config);
    const notes = notesFor();
    const items = itemsFor();
    const instructions = instructionsFor();
    const policies = buildPolicies(config);
    const state = new SafetyStore(path.join(ROOT, '.runtime')).state;
    const dayAgo = Date.now() - 86400000;
    if (!policies.size) console.log('No chats set up yet. Run CHOOSE-CHATS.cmd.');
    for (const policy of policies.values()) {
      const { count, last } = archive.stats(policy.id);
      const when = last ? new Date(last * 1000).toLocaleString('en-GB', { timeZone: config.reminders.timeZone }) : 'never';
      const chat = createHash('sha256').update(policy.id).digest('hex');
      const used = (state.aiAttempts || []).filter(x => x.chat === chat && x.time > dayAgo && !x.kind).length;
      const looked = (state.aiAttempts || []).filter(x => x.chat === chat && x.time > dayAgo && x.kind === 'detect').length;
      const kept = notes.read(policy.id).length;
      let list = '';
      try {
        const { open, suggested } = items.active(policy.id);
        list = open.length || suggested.length ? `\n  items: ${open.length} open (${open.filter(x => x.remindAt && !x.firedAt && !x.missedAt).length} ` +
          `reminders to come), ${suggested.length} spotted, not kept yet` : '';
      } catch (error) { list = `\n  items: ${error.message}`; }
      const told = instructions.load(policy.id);
      if (told.problem) list += `\n  instructions: ${told.problem}`;
      else if (told.text) list += `\n  instructions: ${[...told.text].length} characters${policy.ai === true ? '' : ' (used once AI is on)'}`;
      console.log(`${terminalText(policy.label || policy.id)} [${policy.id}]\n  ${terminalText(permissionText(policy))}\n  archive: ${count} messages, last ${when}` +
        (policy.ai === true ? `\n  AI in the last 24h: ${used} of ${policy.aiPerDay ?? 3}; notes: ${kept ? `${kept} characters` : 'none'}` +
          `${policy.detect ? `; looked for requests ${looked} times` : ''}` : '') + list.split('\n').map(terminalText).join('\n'));
    }
    for (const [key, name] of [['connectionPause', 'connection'], ['deletionPause', 'deletion'], ['warningPause', 'warning'],
      ['replyPause', 'reply'], ['adminPause', 'admin actions']]) {
      if (state[key]) console.log(`PAUSED ${name}: ${state[key].reason} (${resumeCommand()} after checking the phone)`);
    }
    const { MemberLists } = require('./members');
    const members = new MemberLists(path.join(ROOT, 'data', 'members.json')).size;
    console.log(`Spam deletion: ${config.deletion.enabled ? config.deletion.mode : 'off'}. Summary API key: ${hasApiKey() ? 'available (per-chat AI permission still required)' : 'missing'}. ` +
      `Trusted: ${members.trusted}. Removed by you: ${members.removed}.`);
    console.log(`AI requests: ${state.aiStats.allowed} allowed, ${state.aiStats.blocked} blocked before provider; reasons: ${JSON.stringify(state.aiStats.reasons)}. Not token counts.`);
    console.log(`Discovery phrase: "${config.discoveryPhrase}"; IDs stay in data/discovered-chats.json (does not enable chats).`);
    return;
  }
  if (command === 'condense') {
    const { buildPolicies, findPolicy } = require('./chats');
    const { loadOrCreateSecret } = require('./transcript');
    const [name] = positional(args);
    if (!name) throw new Error('Name a chat: npm run condense -- "<label or ID>" [--dry-run]');
    const policy = findPolicy(buildPolicies(config), name);
    const { createSummaryService } = require('./summarise');
    const { SafetyStore } = require('./safety');
    const { ColdStore } = require('./archive');
    const safety = new SafetyStore(path.join(ROOT, '.runtime'));
    const dryRun = args.includes('--dry-run');
    // A real run rewrites the archive: no worker may be appending to it meanwhile. (A "summary" lock left by a crashed
    // CLI run is cleared automatically next time.) The dry run only reads.
    if (!dryRun) safety.acquire({ purpose: 'summary' });
    try {
      const service = createSummaryService({ getConfig: () => config, getPolicies: () => buildPolicies(config),
        archive: archiveFor(config), getSecret: () => loadOrCreateSecret(path.join(ROOT, 'data', 'pseudonym.secret')), safety,
        hubsRoot: path.join(ROOT, 'hubs'), runsDir: dryRun ? null : path.join(ROOT, '.runtime', 'claude-runs'), notes: notesFor(),
        cold: new ColdStore(path.join(ROOT, 'data', 'condensed')), instructions: instructionsFor() });
      const result = await service.condense({ chatId: policy.id, source: 'cli', dryRun });
      console.log(result.done ? result.text : `Not condensed: ${result.text}`);
    } finally { if (!dryRun) safety.release(); }
    return;
  }
  if (command === 'sync') {
    const { buildPolicies, findPolicy } = require('./chats');
    const { createHubSync } = require('./sync');
    const [name] = positional(args);
    if (!name) throw new Error('Name a chat: npm run sync -- "<label or ID>" [--clone <repo address> [--key <deploy key>] | --adopt]');
    const policy = findPolicy(buildPolicies(config), name);
    const sync = createHubSync({ hubsRoot: path.join(ROOT, 'hubs'), gitRoot: path.join(ROOT, 'data', 'hub-git'),
      getLimits: () => ({ maxFileMiB: config.hubs.maxSendMiB, maxTotalMiB: config.hubs.maxSyncMiB, maxFiles: config.hubs.maxSyncFiles }) });
    const url = option(args, '--clone');
    if (args.includes('--clone') && url === undefined) throw new Error('--clone needs the repository address, e.g. --clone git@github.com:OWNER/REPO.git');
    if (url !== undefined) console.log(await sync.clone(policy, { url, key: option(args, '--key', '') }));
    else if (args.includes('--adopt')) console.log(await sync.adopt(policy));
    else console.log(await sync(policy));
    return;
  }
  if (command === 'issues') {
    const { buildPolicies, findPolicy } = require('./chats');
    const { listText } = require('./reminders');
    const [name] = positional(args);
    if (!name) throw new Error('Name a chat: npm run issues -- "<label or ID>"');
    const policy = findPolicy(buildPolicies(config), name);
    const { terminalText } = require('./chats');
    console.log(listText(itemsFor(), policy, config, Date.now()).split('\n').map(terminalText).join('\n'));
    return;
  }
  if (command === 'detect') {
    const { buildPolicies, findPolicy } = require('./chats');
    const { loadOrCreateSecret } = require('./transcript');
    const [name] = positional(args);
    if (!name) throw new Error('Name a chat: npm run detect -- "<label or ID>" [--dry-run]');
    const policy = findPolicy(buildPolicies(config), name);
    const { createSummaryService } = require('./summarise');
    const { SafetyStore } = require('./safety');
    const safety = new SafetyStore(path.join(ROOT, '.runtime'));
    const dryRun = args.includes('--dry-run');
    // A real run changes the chat's items list and the AI budget: no worker may be running meanwhile.
    if (!dryRun) safety.acquire({ purpose: 'summary' });
    try {
      const service = createSummaryService({ getConfig: () => config, getPolicies: () => buildPolicies(config),
        archive: archiveFor(config), getSecret: () => loadOrCreateSecret(path.join(ROOT, 'data', 'pseudonym.secret')), safety,
        runsDir: dryRun ? null : path.join(ROOT, '.runtime', 'claude-runs'), items: itemsFor(), instructions: instructionsFor() });
      const result = await service.detect({ chatId: policy.id, source: 'cli', dryRun });
      console.log(result.done ? result.text : `Not looked at: ${result.text}`);
      for (const item of result.added) console.log(`  ${item.n}. ${item.text}`);
    } finally { if (!dryRun) safety.release(); }
    return;
  }
  if (command === 'ideas') {
    const { buildPolicies, findPolicy, terminalText } = require('./chats');
    const { formatWhen } = require('./when');
    const [name] = positional(args);
    if (!name) throw new Error('Name a chat: npm run ideas -- "<label or ID>"');
    const policy = findPolicy(buildPolicies(config), name);
    const board = ideasFor().read(policy.id);
    const show = text => String(text).split(String.fromCharCode(10)).map(terminalText).join(String.fromCharCode(10));
    console.log(board.ideas.length ? board.ideas.map(idea => show(`${idea.n}. ${idea.text}${idea.by === 'owner' ? ' (you)' : ''}`)).join(String.fromCharCode(10)) : 'No ideas yet.');
    const latest = board.findings[board.findings.length - 1];
    if (latest) {
      console.log(`${String.fromCharCode(10)}Latest findings, ${formatWhen(latest.at, config.reminders.timeZone, Date.now())} (${latest.ideas} ideas, ${latest.messages} messages${latest.issue ? `, GitHub #${latest.issue}` : ''}):`);
      console.log(show(latest.text));
    }
    console.log(`${String.fromCharCode(10)}(${board.findings.length} saved findings in data/ideas/)`);
    return;
  }
  if (command === 'github') {
    const fs = require('node:fs');
    const { buildPolicies, findPolicy, terminalText } = require('./chats');
    const { saveChats, configPath } = require('./config');
    const { createGitHub, validRepo, tokenFrom, GitHubError } = require('./github');
    const [name] = positional(args);
    if (!name) throw new Error('Name a chat: npm run github -- "<label or ID>" [--repo OWNER/REPO [--members] | --off]');
    let policy = findPolicy(buildPolicies(config), name);
    if (policy.legacy) throw new Error('That chat is only in groupIds; set it up with choose first.');
    const repo = option(args, '--repo');
    if (args.includes('--repo') && repo === undefined) throw new Error('--repo needs OWNER/REPO, e.g. --repo kaihuang1425/agentic-legacy');
    if (repo !== undefined && args.includes('--off')) throw new Error('Use --repo or --off, not both.');
    if (args.includes('--members') && repo === undefined) throw new Error('--members goes with --repo OWNER/REPO.');
    if (repo !== undefined && !validRepo(repo)) throw new Error('--repo needs OWNER/REPO, e.g. --repo kaihuang1425/agentic-legacy');
    const label = terminalText(policy.label || policy.id);
    if (repo !== undefined || args.includes('--off')) {
      // Only this chat's two fields change; the running bot picks the change up within seconds.
      const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
      const chat = raw.chats.find(entry => entry.id === policy.id);
      Object.assign(chat, repo !== undefined ? { githubRepo: repo, githubMembers: args.includes('--members') } : { githubRepo: '', githubMembers: false });
      policy = buildPolicies(saveChats(raw.chats)).get(policy.id);
      if (repo === undefined) {
        console.log(`${label} is no longer linked to GitHub.`);
        return;
      }
      console.log(`${label} is linked to ${repo}. ${policy.githubMembers ? 'Members can use it too.' : 'Only you can use it from the chat.'}`);
    }
    if (!policy.githubRepo) {
      console.log(`${label} is not linked to GitHub. Link it with: npm run github -- "${label}" --repo OWNER/REPO`);
      return;
    }
    if (repo === undefined) console.log(`${label} is linked to ${policy.githubRepo}. ${policy.githubMembers ? 'Members can use it too.' : 'Only you can use it from the chat.'}`);
    try {
      const github = createGitHub({ getToken: () => tokenFrom(path.join(ROOT, '.env')), timeoutMs: config.github.timeoutSeconds * 1000 });
      const seen = await github.repository(policy.githubRepo);
      console.log(`Checked: GITHUB_TOKEN can see ${seen.name}${seen.private ? ' (private)' : ''}.` +
        (seen.issues ? '' : ' Issues are turned off in this repository, so "github issue" will fail.'));
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      console.log(`Not checked: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'google') {
    const fs = require('node:fs');
    const { buildPolicies, findPolicy, terminalText } = require('./chats');
    const { saveChats, configPath } = require('./config');
    const { createGoogle, parseFileRef, GoogleError } = require('./google');
    const { keyFileFrom, KIND_NAME } = require('./google-commands');
    const [name] = positional(args);
    const usage = 'npm run google -- "<label or ID>" [--add <link or ID> --name <short name> | --remove <name> | --members | --no-members]';
    if (!name) throw new Error(`Name a chat: ${usage}`);
    let policy = findPolicy(buildPolicies(config), name);
    if (policy.legacy) throw new Error('That chat is only in groupIds; set it up with choose first.');
    const label = terminalText(policy.label || policy.id);
    const add = option(args, '--add'), short = option(args, '--name'), remove = option(args, '--remove');
    const members = args.includes('--members') ? true : args.includes('--no-members') ? false : undefined;
    if ([add, remove, members].filter(x => x !== undefined).length > 1) throw new Error(`One change at a time: ${usage}`);
    if ((args.includes('--add') && add === undefined) || (add !== undefined && short === undefined)) throw new Error(`--add needs a link and --name: ${usage}`);
    if (args.includes('--remove') && remove === undefined) throw new Error(`--remove needs the file's short name: ${usage}`);
    const google = createGoogle({ getKeyFile: () => keyFileFrom(path.join(ROOT, '.env'), ROOT), timeoutMs: config.google.timeoutSeconds * 1000 });
    // Only this chat's Google fields change; the running bot picks the change up within seconds.
    const save = changeChat => {
      const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
      const chat = raw.chats.find(entry => entry.id === policy.id);
      changeChat(chat);
      policy = buildPolicies(saveChats(raw.chats)).get(policy.id);
    };
    if (add !== undefined) {
      const ref = parseFileRef(add);
      if (!ref) throw new Error('--add needs a Google Docs, Sheets or Slides link (or a file ID).');
      if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(short)) throw new Error('--name needs a short name of a-z, 0-9 and -, up to 30 characters, e.g. --name plan');
      if ((policy.googleFiles || []).some(file => file.name === short)) throw new Error(`${label} already has a file called ${short}; --remove it first.`);
      if ((policy.googleFiles || []).length >= 20) throw new Error(`${label} already has 20 Google files linked.`);
      let info;
      try { info = await google.fileInfo(ref.id); } catch (error) {
        if (!(error instanceof GoogleError)) throw error;
        throw new Error(`Not linked: ${error.message}`);
      }
      if (!info.kind) throw new Error('Not linked: that file is not a Google Doc, Sheet or Slides presentation.');
      save(chat => { chat.googleFiles = [...(chat.googleFiles || []), { name: short, id: ref.id, kind: info.kind }]; });
      console.log(`Linked "${terminalText(info.name)}" (${KIND_NAME[info.kind]}) to ${label} as ${short}. In the chat: ${policy.buzzword || '<buzzword>'} ${info.kind} ${short}`);
      return;
    }
    if (remove !== undefined) {
      if (!(policy.googleFiles || []).some(file => file.name === remove)) throw new Error(`${label} has no Google file called ${terminalText(remove)}.`);
      save(chat => { chat.googleFiles = chat.googleFiles.filter(file => file.name !== remove); });
      console.log(`${terminalText(remove)} is no longer linked to ${label}. The file itself is unchanged; unshare it in Google if you want.`);
      return;
    }
    if (members !== undefined) {
      save(chat => { chat.googleMembers = members; });
      console.log(members ? `Members of ${label} can now read its Google files (only you can change them).` : `Only you can use ${label}'s Google files now.`);
      return;
    }
    const files = policy.googleFiles || [];
    if (!files.length) {
      console.log(`${label} has no Google files. Link one with: npm run google -- "${label}" --add <link> --name <short name>`);
      return;
    }
    console.log(`${label}'s Google files (${policy.googleMembers ? 'members can read them' : 'only you can use them'}):`);
    for (const file of files) {
      try {
        const info = await google.fileInfo(file.id);
        console.log(`  ${file.name}: ${KIND_NAME[file.kind]} "${terminalText(info.name)}", the service account can open it`);
      } catch (error) {
        if (!(error instanceof GoogleError)) throw error;
        console.log(`  ${file.name}: ${KIND_NAME[file.kind]}, not checked: ${error.message}`);
        process.exitCode = 1;
      }
    }
    return;
  }
  if (command === 'instructions') {
    const { buildPolicies, findPolicy, terminalText } = require('./chats');
    const { cleanInstructions } = require('./instructions');
    const [name] = positional(args);
    if (!name) throw new Error('Name a chat: npm run instructions -- "<label or ID>" [--set "text" | --clear]');
    const policy = findPolicy(buildPolicies(config), name);
    const instructions = instructionsFor();
    const text = option(args, '--set');
    if (args.includes('--set') && text === undefined) throw new Error('--set needs the text, e.g. --set "Answer in Traditional Chinese"');
    if (text !== undefined && args.includes('--clear')) throw new Error('Use --set or --clear, not both.');
    // The bot reads the file each time it calls the AI, so this works while it runs; no restart needed.
    if (text !== undefined) {
      const cleaned = cleanInstructions(text);
      if (cleaned.error) throw new Error(cleaned.error === 'empty' ? '--set needs some text.' : cleaned.error);
      instructions.write(policy.id, cleaned.text);
      console.log(`Saved (${[...cleaned.text].length} characters) for ${terminalText(policy.label || policy.id)}:\n` +
        cleaned.text.split('\n').map(terminalText).join('\n'));
    } else if (args.includes('--clear')) {
      console.log(instructions.clear(policy.id) ? 'Instructions cleared.' : 'This chat had no instructions.');
    } else {
      const { text: current, problem } = instructions.load(policy.id);
      if (problem) console.log(problem);
      else console.log(current ? current.split('\n').map(terminalText).join('\n') : 'No instructions for this chat.');
    }
    if (policy.ai !== true) console.log('AI is off for this chat, so they are not used until you turn it on.');
    return;
  }
  if (command === 'notes') {
    const { buildPolicies, findPolicy } = require('./chats');
    const [name] = positional(args);
    if (!name) throw new Error('Name a chat: npm run notes -- "<label or ID>"');
    const policy = findPolicy(buildPolicies(config), name);
    const notes = notesFor();
    const text = notes.read(policy.id);
    console.log(text || 'No notes yet.');
    console.log(`\n(${notes.file(policy.id)}; earlier versions: ${notes.history(policy.id).length} in data/notes/history)`);
    return;
  }
  if (command === 'transcript' || command === 'summarise' || command === 'summarize') {
    const { buildPolicies, findPolicy } = require('./chats');
    const { renderTranscript, renderSummaryTranscript, loadOrCreateSecret } = require('./transcript');
    const [name] = positional(args);
    if (!name) throw new Error(`Name a chat: npm run ${command} -- "<label or ID>"`);
    const policy = findPolicy(buildPolicies(config), name);
    const since = sinceFrom(args, config);
    // This run's effort instead of summary.effort, checked before anything else happens.
    const effort = option(args, '--effort');
    if (args.includes('--effort') && !require('./effort').EFFORTS.includes(effort)) {
      throw new Error(`--effort needs one of ${require('./effort').EFFORTS.join(', ')}`);
    }
    if (effort !== undefined && (command === 'transcript' || args.includes('--dry-run'))) {
      throw new Error('--effort applies only to a real summarise run (no AI runs for transcript or --dry-run).');
    }
    if (command !== 'transcript' && !args.includes('--dry-run')) {
      const { createSummaryService } = require('./summarise');
      const { SafetyStore } = require('./safety');
      const safety = new SafetyStore(path.join(ROOT, '.runtime'));
      // Do not race a worker (or another CLI) writing the persistent safety budget.
      safety.acquire({ purpose: 'summary' });
      try {
        const summaryService = createSummaryService({ getConfig: () => config, getPolicies: () => buildPolicies(config),
          archive: archiveFor(config), getSecret: () => loadOrCreateSecret(path.join(ROOT, 'data', 'pseudonym.secret')), safety,
          hubsRoot: path.join(ROOT, 'hubs'), runsDir: path.join(ROOT, '.runtime', 'claude-runs'), notes: notesFor(),
          hubLock: require('./sync').createHubLock(path.join(ROOT, 'data', 'hub-git')), instructions: instructionsFor(), ideas: ideasFor() });
        const question = option(args, '--ask');
        console.log(await summaryService({ chatId: policy.id, source: 'cli', since, hours: option(args, '--hours', config.summary.hours),
          ...(question !== undefined ? { question } : {}), ...(effort !== undefined ? { effort } : {}),
          ...(args.includes('--findings') ? { findings: true } : {}) }));
      } finally { safety.release(); }
      return;
    }
    const records = archiveFor(config).read(policy.id, { since }).slice(command === 'transcript' ? 0 : -config.summary.maxMessages);
    if (!records.length) {
      console.log(`No archived messages in ${policy.label || policy.id} since ${new Date(since * 1000).toLocaleString('en-GB', { timeZone: config.reminders.timeZone })}.`);
      return;
    }
    const secret = loadOrCreateSecret(path.join(ROOT, 'data', 'pseudonym.secret'));
    const options = { secret, pseudonymise: policy.pseudonymise, ids: args.includes('--ids'), scope: policy.id, timeZone: config.reminders.timeZone };
    const transcript = command === 'transcript' ? renderTranscript(records, options)
      : renderSummaryTranscript(records, { ...options, maxChars: config.summary.maxTranscriptChars }).transcript;
    if (command === 'transcript' || args.includes('--dry-run')) {
      console.log(transcript);
      return;
    }
    return;
  }
  if (command === 'check') {
    if (!args.length) throw new Error('Supply text, for example: npm run check -- "claim your prize"');
    const fs = require('node:fs');
    const { LearnedSpam } = require('./learned');
    const file = path.join(ROOT, 'data', 'learned-spam.json');
    const learned = fs.existsSync(file) ? new LearnedSpam(file) : null;
    const { normalized, ...result } = new SpamDetector(config, { learned }).check({ chatId: 'offline', senderId: 'example', text: args.join(' ') });
    const deletable = config.deletion.mode === 'strict' ? result.certain.length > 0 : result.score >= config.deletion.threshold;
    console.log(JSON.stringify({ wouldDelete: deletable, ...result }, null, 2));
    return;
  }
  if (command === 'demo') {
    const { LearnedSpam } = require('./learned');
    const examples = [
      ['Ordinary message', 'Anyone coming to the meeting at 3?'],
      ['Ordinary link', 'The notes are at https://example.org/notes'],
      ['Scam warning (talks about spam)', 'Careful: never share your OTP, and ignore "you have won" messages.'],
      ['Prize scam', 'You have won! Claim your prize at https://bit.ly/example'],
      ['Risky promotion', 'Work from home and earn daily.'],
      ['Job scam with link', 'Part time job, earn $300 per day, no experience: https://jobs.example.net'],
      ['Credential request', 'Hi, I sent you a code by mistake, please send me the code you received.'],
      ['Repeated text 1', 'Buy my wonderful product today'],
      ['Repeated text 2', 'Buy my wonderful product today'],
      ['Repeated text 3', 'Buy my wonderful product today']
    ];
    const learned = new LearnedSpam(null); // in memory only: the demo never writes data/
    const detector = new SpamDetector(config, { learned });
    const show = (label, text, senderId = label) => {
      const result = detector.check({ chatId: 'offline', senderId, text });
      const deletable = config.deletion.mode === 'strict' ? result.certain.length > 0 : result.score >= config.deletion.threshold;
      console.log(`${deletable ? 'DELETE' : result.isSpam ? 'FLAG  ' : 'PASS  '} | score ${result.score} | ${label}`);
      if (result.certain.length) console.log(`         delete signal: ${result.certain.join('; ')}`);
      else if (result.strict.length) console.log(`         pattern (flag only): ${result.strict.join('; ')}`);
      if (result.reasons.length) console.log(`         ${result.reasons.map(x => x.detail).join('; ')}`);
      return result;
    };
    for (const [label, text] of examples) show(label, text, label.startsWith('Repeated') ? 'repeat-demo' : label);
    console.log('\nNow you reply "!bot spam" to the prize scam. The bot deletes it and learns its exact text and link:');
    const marked = detector.check({ chatId: 'offline', senderId: 'mark', text: examples[3][1] });
    learned.learn(marked.normalized, marked.links);
    show('Same prize scam posted again', examples[3][1], 'someone-else');
    show('Different text, same link', 'Last chance!! https://bit.ly/example', 'someone-else-2');
    show('Ordinary message mentioning a prize', 'Who won the prize at the quiz?', 'friend');
    console.log(`\nDeletion mode: ${config.deletion.mode}. ${config.deletion.mode === 'strict'
      ? 'Only your patterns delete: blocked domains, spam you marked, and rules you set to "delete". Everything else is flagged for review.' : ''}`);
    console.log('Heuristic results are suggestions for review, not proof of spam.');
    return;
  }
  throw new Error(`Unknown command: ${command}. Run node src/cli.js --help.`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
