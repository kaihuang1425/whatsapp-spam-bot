'use strict';

// GitHub changes from a chat linked to a repository, and the reads that go with them (githubCommand in commands.js
// handles opening issues and the issue / pull request lists, and passes everything else here).
// - Reading (an issue with its comments, files, commits): the owner, and members where the owner set githubMembers.
// - Changing: the owner only. Adding (a comment, labels) happens at once. Anything that removes, closes, merges or
//   replaces what is there waits for "<buzzword> confirm <code>" (pending.js); its preview says exactly what will happen.
// - File changes and reverts are commits: by default on a new branch with a pull request (github.changes "pull"), or
//   straight onto the default branch ("direct"). Branches only move forward: nothing force-pushes or rewrites history.
// - AI drafts (applyDraft) always wait for the code, must fit in full in the preview, always go on a new branch, and are
//   refused if the target changed while the AI was drafting.
// - At most github.maxWritesPerHour changes an hour from all chats, each logged as "[GITHUB] chat: what".

const { GitHubError, shown, shownBlock, oneLine, validPath, validSha, validBranch, MERGE_STATE, MAX_FILE_BYTES } = require('./github');
const { normalizeCall } = require('./chats');
const { formatSize } = require('./hubs');
const { formatWhen } = require('./when');

const MAX_TEXT = 20000;
const MAX_FILES_LISTED = 40;
// An AI draft is offered only if the preview can show all of it: text up to this size, a file change up to this many
// changed lines. The preview is drawn a little larger, since [link] and [number] can be longer than what they replace.
const DRAFT_TEXT = { maxChars: 1500, maxLines: 30 };
const DRAFT_DIFF = { lines: 60, chars: 4000 };
const PREVIEW_CUT = '(cut short in this preview)';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fits = (text, { maxChars, maxLines }) => [...String(text)].length <= maxChars && String(text).split('\n').length <= maxLines;

// The words before the text, as a pattern for typedAfter: phrase('#12', 'comment') matches "#12 comment".
function phrase(...words) {
  return words.map(word => String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ \\t]+');
}

// The text after the first "<keyword>" (a phrase() pattern) on a command's first line, line breaks kept. The router's
// copy went through NFKC (full-width punctuation becomes ASCII); the message as typed is used when it says the same.
function tailAfter(text, keyword) {
  const found = new RegExp(`^[^\\n]*?\\s${keyword}(?:[ \\t]*\\n|[ \\t]+|$)([\\s\\S]*)$`, 'i').exec(String(text ?? ''));
  return found ? found[1] : null;
}
function typedAfter(message, rest, keyword) {
  const normalized = tailAfter(` ${rest}`, keyword) ?? '';
  const raw = tailAfter(String(message?.body ?? ''), keyword);
  return (raw !== null && normalizeCall(raw) === normalizeCall(normalized) ? raw : normalized).replace(/\s+$/, '');
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'change';
}

// The lines a change removes ("-") and adds ("+"), in order (a longest-common-subsequence diff after the common start
// and end are set aside). null when the changed part is too large to compare here.
function lineDiff(before, after, maxCells = 4000000) {
  const a = String(before).split('\n'), b = String(after).split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const x = a.slice(start, endA), y = b.slice(start, endB);
  if (x.length * y.length > maxCells) return null;
  const table = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; } else if (table[i + 1][j] >= table[i][j + 1]) out.push(['-', x[i++]]); else out.push(['+', y[j++]]);
  }
  while (i < x.length) out.push(['-', x[i++]]);
  while (j < y.length) out.push(['+', y[j++]]);
  return out;
}

function createGitHubChanges({ getConfig, github, pending, oneGitHubCall, isBusy = () => false, clock = Date.now, log = console.log }) {
  let writes = [];
  function writeLimit() {
    const max = getConfig().github.maxWritesPerHour;
    writes = writes.filter(time => time > clock() - 3600000);
    return writes.length >= max ? `GitHub: at most ${max} changes an hour can be made from chats; try again later.` : null;
  }
  function reserveWrite() {
    const full = writeLimit();
    if (!full) writes.push(clock());
    return full;
  }
  // Why a confirmed change could not start right now (the code then stays valid), or null.
  const blocked = policy => (isBusy(policy.id) ? 'A GitHub request for this chat is still running; try again in a moment.' : writeLimit());

  const zone = () => getConfig().reminders.timeZone;
  const label = policy => policy.label || policy.id;
  const link = url => (String(url).startsWith('https://github.com/') ? `\n${url}` : '');
  const fileLink = (repo, branch, path) => `\nhttps://github.com/${repo}/blob/${branch.split('/').map(encodeURIComponent).join('/')}/` +
    path.split('/').map(encodeURIComponent).join('/');

  // A change made now (adding a comment or labels, or a confirmed one): one request at a time, counted against the
  // hourly limit. GitHub's refusals come back as a reply (a confirmed change runs outside githubCommand's own catch).
  function now(policy, run) {
    return oneGitHubCall(policy, async () => {
      const full = reserveWrite();
      if (full) return full;
      try { return await run(); } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        return `GitHub: ${error.message}`;
      }
    }, true);
  }

  // A change that waits for the owner's code. preview: what will happen; run: does it and returns the reply.
  function ask(policy, preview, run) {
    const code = pending.add(policy.id, { what: preview.split('\n')[0], run: () => now(policy, run), blocked: () => blocked(policy) });
    const minutes = Math.round(pending.ttlMs / 60000);
    return `${preview}\nTo do it, send ${policy.buzzword} confirm ${code} within ${minutes} minutes (or ${policy.buzzword} cancel ${code}).`;
  }

  function done(policy, text) {
    log(`[GITHUB] ${label(policy)}: ${oneLine(text, 160)}`);
  }

  // Where a commit from the chat goes. A new branch starts at the commit the preview saw (baseSha), so the change is
  // made to what the owner looked at; an AI draft always gets a new branch.
  async function destination(repo, what, { forcePull = false } = {}) {
    const base = (await github.repository(repo)).defaultBranch;
    if (getConfig().github.changes === 'direct' && !forcePull) return { base, branch: base, pull: false };
    const stamp = new Date(clock()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    return { base, branch: `whatsapp/${stamp}-${slug(what)}`, pull: true, baseSha: await github.branchSha(repo, base) };
  }
  const where = target => (target.pull ? `on a new branch, with a pull request into ${target.base}` : `straight onto ${target.base}`);

  // Commits on target.branch (a new branch made at target.baseSha first), then opens the pull request if there is one.
  async function commitThen(repo, target, title, commit) {
    if (target.pull) await github.createBranch(repo, target.branch, target.baseSha);
    const result = await commit(target.branch);
    if (!target.pull) return { text: `${title} on ${target.base}.`, url: result.url || '' };
    const pull = await github.openPull(repo, { title, head: target.branch, base: target.base, body: 'Made from WhatsApp with the chat bot.' });
    return { text: `${title}: pull request #${pull.number} (${target.branch} → ${target.base}) is ready for review.`, url: pull.url };
  }

  // ---- issues and pull requests by number ----

  async function showIssue(policy, repo, n) {
    const issue = await github.getIssue(repo, n);
    const comments = issue.comments ? (await github.listComments(repo, n)).slice(-3) : [];
    const kind = issue.pull ? 'pull request' : 'issue';
    const lines = [`#${issue.number} ${issue.title} (${kind}, ${issue.state}; by ${issue.user}` +
      `${issue.labels.length ? `; labels: ${issue.labels.join(', ')}` : ''}; ${issue.comments} comments)`];
    if (issue.body.trim()) lines.push(shownBlock(issue.body, { maxChars: 800, maxLines: 15 }));
    if (comments.length) {
      lines.push('Latest comments:', ...comments.map(c => `[comment ${c.id}] ${c.user}: ${shownBlock(c.body, { maxChars: 200, maxLines: 4 })}`));
    }
    return lines.join('\n') + link(issue.url);
  }

  async function listComments(policy, repo, n) {
    const comments = (await github.listComments(repo, n)).slice(-5);
    if (!comments.length) return `#${n} has no comments.`;
    return [`Latest comments on #${n}:`, ...comments.map(c => `[comment ${c.id}] ${c.user}: ${shownBlock(c.body, { maxChars: 300, maxLines: 6 })}`),
      `Change one with ${policy.buzzword} github comment ID edit <text>, or remove it with ${policy.buzzword} github comment ID delete.`].join('\n');
  }

  // opts for an AI draft: { draft: the preview's opening words, updatedAt: the issue as the AI saw it }. A drafted
  // comment waits for the code too, and a draft is refused if the issue changed while the AI was drafting.
  async function issueChange(policy, repo, n, action, args, text, { draft = '', updatedAt = null } = {}) {
    const word = policy.buzzword;
    const textView = draft ? { maxChars: 2000, maxLines: DRAFT_TEXT.maxLines + 1, more: PREVIEW_CUT } : { maxChars: 300, maxLines: 6, more: PREVIEW_CUT };
    if (draft && !fits(text, DRAFT_TEXT)) {
      return `The AI's draft is too long to show here in full (${[...text].length} characters); ask for a shorter one.`;
    }
    if (action === 'comment' && !draft) {
      if (!text) return `Usage: ${word} github #${n} comment <text>`;
      if ([...text].length > MAX_TEXT) return `A comment can have at most ${MAX_TEXT} characters.`;
      return now(policy, async () => {
        const comment = await github.addComment(repo, n, text);
        done(policy, `commented on #${n}`);
        return `Commented on #${n}.${link(comment.url)}`;
      });
    }
    if (action === 'label' || action === 'labels') {
      const labels = args.join(' ').split(',').map(x => x.trim()).filter(Boolean);
      if (!labels.length || labels.length > 10 || labels.some(x => [...x].length > 50)) return `Usage: ${word} github #${n} label bug, help wanted (up to 10)`;
      return now(policy, async () => {
        const all = await github.addLabels(repo, n, labels);
        done(policy, `labelled #${n}`);
        return `#${n} now has the labels: ${all.join(', ')}.`;
      });
    }
    const issue = await github.getIssue(repo, n);
    if (draft && updatedAt !== null && issue.updatedAt !== updatedAt) return `#${n} changed on GitHub while the AI was drafting; ask again.`;
    const kind = issue.pull ? 'pull request' : 'issue';
    const named = `${kind} #${n} "${issue.title}"`;
    if (action === 'comment') {
      return ask(policy, `${draft}Comment on #${n}?\n${shownBlock(text, textView)}`, async () => {
        await unchanged(repo, n, issue);
        const comment = await github.addComment(repo, n, text);
        done(policy, `commented on #${n}`);
        return `Commented on #${n}.${link(comment.url)}`;
      });
    }
    if (action === 'close' || action === 'reopen') {
      const state = action === 'close' ? 'closed' : 'open';
      if (issue.state === state) return `#${n} is already ${state}.`;
      const reason = action === 'close' && /^not[\s-]?planned$/i.test(args.join(' ')) ? 'not_planned' : null;
      return ask(policy, `${action === 'close' ? 'Close' : 'Reopen'} ${named} in ${repo}${reason ? ' as not planned' : ''}?`, async () => {
        if (issue.pull) await github.editPull(repo, n, { state });
        else await github.editIssue(repo, n, { state, ...(reason ? { state_reason: reason } : {}) });
        done(policy, `${action}d #${n}`);
        return `${action === 'close' ? 'Closed' : 'Reopened'} ${kind} #${n}.${link(issue.url)}`;
      });
    }
    if (action === 'title') {
      const title = oneLine(text, 300);
      if (!title || [...title].length > 256) return `Usage: ${word} github #${n} title <new title> (up to 256 characters)`;
      return ask(policy, `${draft}Change the title of ${kind} #${n}\nfrom: ${issue.title}\nto: ${shown(title, 256)}`, async () => {
        await unchanged(repo, n, issue);
        if (issue.pull) await github.editPull(repo, n, { title }); else await github.editIssue(repo, n, { title });
        done(policy, `retitled #${n}`);
        return `Changed the title of #${n}.${link(issue.url)}`;
      });
    }
    if (action === 'body') {
      if ([...text].length > MAX_TEXT) return `A description can have at most ${MAX_TEXT} characters.`;
      const before = issue.body.trim() ? shownBlock(issue.body, { maxChars: 300, maxLines: 6, more: PREVIEW_CUT }) : '(empty)';
      const after = text ? shownBlock(text, textView) : '(empty)';
      return ask(policy, `${draft}Replace the description of ${named}\nnow: ${before}\nnew: ${after}`, async () => {
        await unchanged(repo, n, issue);
        if (issue.pull) await github.editPull(repo, n, { body: text }); else await github.editIssue(repo, n, { body: text });
        done(policy, `rewrote the description of #${n}`);
        return `Changed the description of #${n}.${link(issue.url)}`;
      });
    }
    if (action === 'delete') {
      if (issue.pull) return `Pull requests cannot be deleted. Close it with ${word} github pr ${n} close.`;
      return ask(policy, `Delete ${named} from ${repo} for good, with all its comments? This cannot be undone ` +
        '(GitHub allows it only for repository admins; closing keeps it).', async () => {
        await github.deleteIssue(repo, issue.nodeId);
        done(policy, `deleted issue #${n}`);
        return `Deleted issue #${n}.`;
      });
    }
    return null;
  }

  // An edit confirmed a while after its preview must not overwrite what someone changed on GitHub in between.
  async function unchanged(repo, n, seen) {
    const current = await github.getIssue(repo, n);
    if (current.updatedAt !== seen.updatedAt) throw new GitHubError(`#${n} changed on GitHub since you asked; ask again.`);
  }

  async function commentChange(policy, repo, id, action, text) {
    const word = policy.buzzword;
    const comment = await github.getComment(repo, id);
    const where = comment.issue ? ` on #${comment.issue}` : '';
    const stillSame = async () => {
      const current = await github.getComment(repo, id);
      if (current.updatedAt !== comment.updatedAt) throw new GitHubError(`comment ${id} changed on GitHub since you asked; ask again.`);
    };
    if (action === 'edit') {
      if (!text || [...text].length > MAX_TEXT) return `Usage: ${word} github comment ${id} edit <new text> (up to ${MAX_TEXT} characters)`;
      return ask(policy, `Change comment ${id} by ${comment.user}${where}\nnow: ${shownBlock(comment.body, { maxChars: 300, maxLines: 6, more: PREVIEW_CUT })}\n` +
        `new: ${shownBlock(text, { maxChars: 300, maxLines: 6, more: PREVIEW_CUT })}`, async () => {
        await stillSame();
        await github.editComment(repo, id, text);
        done(policy, `edited comment ${id}`);
        return `Changed comment ${id}${where}.${link(comment.url)}`;
      });
    }
    if (action === 'delete') {
      return ask(policy, `Delete comment ${id} by ${comment.user}${where}: "${shownBlock(comment.body, { maxChars: 200, maxLines: 3, more: PREVIEW_CUT })}"? ` +
        'This cannot be undone.', async () => {
        await stillSame();
        await github.deleteComment(repo, id);
        done(policy, `deleted comment ${id}`);
        return `Deleted comment ${id}${where}.`;
      });
    }
    return `Usage: ${word} github comment ID edit <text>, or ${word} github comment ID delete (IDs from ${word} github #N comments)`;
  }

  // ---- pull requests ----

  async function pullChange(policy, repo, n, action, args) {
    const word = policy.buzzword;
    const pull = await github.getPull(repo, n);
    if (pull.merged) return `Pull request #${n} is already merged.`;
    if (pull.state === 'closed') return `Pull request #${n} is closed. Reopen it with ${word} github #${n} reopen first.`;
    if (action === 'close') {
      return ask(policy, `Close pull request #${n} "${pull.title}" (${pull.head} → ${pull.base}) without merging?`, async () => {
        await github.editPull(repo, n, { state: 'closed' });
        done(policy, `closed pull request #${n}`);
        return `Closed pull request #${n} without merging.${link(pull.url)}`;
      });
    }
    const method = (args[0] || 'merge').toLowerCase();
    if (!['merge', 'squash', 'rebase'].includes(method) || args.length > 1) return `Usage: ${word} github pr ${n} merge [merge|squash|rebase]`;
    if (pull.draft) return `Pull request #${n} is a draft; mark it ready for review on GitHub first.`;
    if (pull.mergeableState === 'dirty') return `Pull request #${n} has merge conflicts; resolve them on GitHub first.`;
    if (!pull.headSha) return `GitHub did not say which commit #${n} is at; ask again in a minute.`;
    return ask(policy, `Merge pull request #${n} "${pull.title}" (${pull.head} → ${pull.base}, at commit ${pull.headSha.slice(0, 7)}; ` +
      `${plural(pull.files, 'file')}, +${pull.additions} −${pull.deletions}) as a ${method} merge? GitHub says: ` +
      `${MERGE_STATE[pull.mergeableState] || pull.mergeableState}. It merges only if nothing was pushed to it since now.`, async () => {
      const result = await github.mergePull(repo, n, { sha: pull.headSha, method });
      if (!result.merged) return `GitHub did not merge #${n}.`;
      done(policy, `merged pull request #${n} (${method})`);
      return `Merged pull request #${n} into ${pull.base} (${method}).${link(pull.url)}`;
    });
  }

  // ---- files ----

  async function listFiles(policy, repo, dir) {
    if (dir && !validPath(dir)) return `"${shown(dir, 60)}" is not a folder path in the repository.`;
    const { defaultBranch } = await github.repository(repo);
    const entries = await github.listDir(repo, dir, defaultBranch);
    if (entries === null) return `There is no folder ${shown(dir, 80)} in ${repo}.`;
    if (entries.file) return `${shown(dir, 80)} is a file: ${policy.buzzword} github file ${shown(dir, 80)}`;
    if (!entries.length) return `${dir ? shown(dir, 80) : 'The repository'} is empty.`;
    return [`${dir ? shown(dir, 80) : 'Top folder'} of ${repo} on ${defaultBranch} (${entries.length}):`,
      ...entries.slice(0, MAX_FILES_LISTED).map(e => (e.type === 'dir' ? `${shown(e.name, 100)}/` : `${shown(e.name, 100)} (${formatSize(e.size)})`)),
      ...(entries.length > MAX_FILES_LISTED ? [`...and ${entries.length - MAX_FILES_LISTED} more on GitHub`] : [])].join('\n');
  }

  async function showFile(policy, repo, path) {
    const { defaultBranch } = await github.repository(repo);
    const file = await github.getFile(repo, path, defaultBranch);
    if (file === null) return `There is no file ${shown(path, 80)} in ${repo} on ${defaultBranch}.`;
    if (file.type === 'dir') return `${shown(path, 80)} is a folder: ${policy.buzzword} github files ${shown(path, 80)}`;
    if (file.type !== 'file') return `${shown(path, 80)} is not a plain file.`;
    const head = `${shown(path, 120)} (${formatSize(file.size)}) on ${defaultBranch}:`;
    if (file.text === null) return `${head} too large or not text, so it is not shown here.${fileLink(repo, defaultBranch, path)}`;
    return `${head}\n${shownBlock(file.text, { maxChars: 3000, maxLines: 60 })}${fileLink(repo, defaultBranch, path)}`;
  }

  // opts for an AI draft: { draft: the preview's opening words, sha: the file's version the AI saw (null: no file) }.
  async function fileChange(policy, repo, path, action, text, { draft = '', sha: seenSha } = {}) {
    const word = policy.buzzword;
    if (action === 'write') {
      if (!text) return `Usage: ${word} github file ${shown(path, 80)} write, then the whole new file on the next lines`;
      const content = text.endsWith('\n') ? text : `${text}\n`;
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) return `A file changed from the chat can be at most ${formatSize(MAX_FILE_BYTES)}.`;
      const target = await destination(repo, `${path} update`, { forcePull: Boolean(draft) });
      const file = await github.getFile(repo, path, target.base);
      if (file && file.type !== 'file') return `${shown(path, 80)} is a folder, not a file.`;
      if (file && file.text === null) return `${shown(path, 80)} is too large or not text; change it on GitHub.`;
      if (draft && seenSha !== undefined && (file?.sha ?? null) !== seenSha) return `${shown(path, 80)} changed on GitHub while the AI was drafting; ask again.`;
      if (file && file.text === content) return `${shown(path, 80)} already has exactly that content.`;
      const diff = lineDiff(file?.text ?? '', content);
      if (draft && (!diff || diff.length > DRAFT_DIFF.lines || diff.reduce((sum, [, line]) => sum + [...line].length + 3, 0) > DRAFT_DIFF.chars)) {
        return `The AI's draft changes too much of ${shown(path, 80)} to show here line by line` +
          `${diff ? ` (${diff.length} changed lines)` : ''}; ask for a smaller change, or change the file on GitHub.`;
      }
      const changed = (diff || []).map(([sign, line]) => `${sign} ${line}`);
      const added = changed.filter(line => line.startsWith('+')).length, removed = changed.length - added;
      const shownLines = draft ? changed : changed.slice(0, 6);
      const rest = changed.length - shownLines.length;
      const title = `${file ? 'Update' : 'Add'} ${path}`;
      const preview = `${file ? `Change ${shown(path, 120)} (${formatSize(file.size)} → ${formatSize(Buffer.byteLength(content))}; ` +
        `${diff ? `+${added} −${removed} lines` : 'too many changes to count'})` : `Add ${shown(path, 120)} (${formatSize(Buffer.byteLength(content))})`} ` +
        `in ${repo}, ${where(target)}?` +
        (shownLines.length ? `\n${shownBlock(shownLines.join('\n'), { maxChars: draft ? DRAFT_DIFF.chars + 600 : 600, maxLines: shownLines.length + 1, more: PREVIEW_CUT })}` : '') +
        (rest > 0 ? `\n(and ${plural(rest, 'more changed line')})` : '');
      return ask(policy, `${draft}${preview}`, async () => {
        const result = await commitThen(repo, target, title, branch =>
          github.putFile(repo, path, { content, message: `${title} (from WhatsApp)`, sha: file?.sha, branch }));
        done(policy, `${file ? 'changed' : 'added'} ${path}`);
        return result.text + link(result.url);
      });
    }
    if (action === 'delete') {
      const target = await destination(repo, `${path} delete`);
      const file = await github.getFile(repo, path, target.base);
      if (file === null) return `There is no file ${shown(path, 80)} in ${repo} on ${target.base}.`;
      if (file.type !== 'file') return `${shown(path, 80)} is a folder; the chat deletes single files only.`;
      return ask(policy, `Delete ${shown(path, 120)} (${formatSize(file.size)}) from ${repo}, ${where(target)}?`, async () => {
        const result = await commitThen(repo, target, `Delete ${path}`, branch =>
          github.deleteFile(repo, path, { message: `Delete ${path} (from WhatsApp)`, sha: file.sha, branch }));
        done(policy, `deleted ${path}`);
        return result.text + link(result.url);
      });
    }
    return null;
  }

  // ---- commits ----

  async function listCommits(policy, repo, branch) {
    if (branch && !validBranch(branch)) return `"${shown(branch, 60)}" is not a branch name.`;
    const commits = await github.listCommits(repo, branch);
    if (!commits.length) return `No commits on ${branch ? shown(branch, 60) : 'the default branch'} of ${repo}.`;
    return [`Latest commits${branch ? ` on ${shown(branch, 60)}` : ''} in ${repo}:`,
      ...commits.map(c => `${c.short} ${c.message} (${c.author}${Date.parse(c.date) ? `, ${formatWhen(Date.parse(c.date), zone(), clock())}` : ''})`),
      `Details: ${policy.buzzword} github commit <id>`].join('\n');
  }

  async function showCommit(policy, repo, sha) {
    const c = await github.getCommit(repo, sha);
    return [`${c.short} ${c.subject}`, `By ${c.author}${Date.parse(c.date) ? `, ${formatWhen(Date.parse(c.date), zone(), clock())}` : ''}. ` +
      `${plural(c.files.length, 'file')} (+${c.additions} −${c.deletions}):`,
    ...c.files.slice(0, 15).map(f => `${f.status} ${shown(f.path, 100)} (+${f.additions} −${f.deletions})`),
    ...(c.files.length > 15 ? [`...and ${c.files.length - 15} more`] : [])].join('\n') +
      link(`https://github.com/${repo}/commit/${c.sha}`);
  }

  async function revertCommit(policy, repo, sha) {
    const target = await destination(repo, `revert ${sha.slice(0, 7)}`);
    const plan = await github.planRevert(repo, sha, target.base);
    const { commit } = plan;
    const files = commit.files.map(f => shown(f.path, 60));
    return ask(policy, `Revert ${commit.short} "${commit.subject}" by ${commit.author} (${plural(files.length, 'file')}: ${files.slice(0, 5).join(', ')}` +
      `${files.length > 5 ? ', ...' : ''}) with a new commit in ${repo}, ${where(target)}?`, async () => {
      const created = await github.revert(repo, plan);
      const title = `Revert "${commit.rawSubject}"`;
      if (target.pull) {
        await github.createBranch(repo, target.branch, created);
        const pull = await github.openPull(repo, { title, head: target.branch, base: target.base, body: `Reverts ${commit.sha}. Made from WhatsApp with the chat bot.` });
        done(policy, `reverted ${commit.short} in pull request #${pull.number}`);
        return `Reverted ${commit.short}: pull request #${pull.number} (${target.branch} → ${target.base}) is ready for review.${link(pull.url)}`;
      }
      await github.moveBranch(repo, target.base, created);
      done(policy, `reverted ${commit.short} on ${target.base}`);
      return `Reverted ${commit.short} on ${target.base} with commit ${created.slice(0, 7)}.${link(`https://github.com/${repo}/commit/${created}`)}`;
    });
  }

  // ---- the commands ----

  // sub: the first word after "github" (lower case); args: the words after it; rest: the router's text after the
  // buzzword. Returns the reply, or null when these words are not one of these commands.
  async function run(policy, { sub, args, rest, fromMe, message }) {
    const word = policy.buzzword;
    const repo = policy.githubRepo;
    const action = (args[1] || '').toLowerCase();
    const changeOnly = () => (fromMe ? null : 'Only the owner of this bot can change things on GitHub from the chat.');
    const read = call => oneGitHubCall(policy, call, fromMe);
    const issueNumber = /^#(\d{1,7})$/.exec(sub);

    if (issueNumber) {
      const n = Number(issueNumber[1]);
      const verb = (args[0] || '').toLowerCase();
      if (!verb) return read(() => showIssue(policy, repo, n));
      if (verb === 'comments' && args.length === 1) return read(() => listComments(policy, repo, n));
      if (!['comment', 'label', 'labels', 'close', 'reopen', 'title', 'body', 'delete'].includes(verb)) return null;
      const refused = changeOnly();
      if (refused) return refused;
      if (['reopen', 'delete'].includes(verb) && args.length > 1) return null;
      const text = ['comment', 'title', 'body'].includes(verb) ? typedAfter(message, rest, phrase(sub, verb)) : '';
      return issueChange(policy, repo, n, verb, args.slice(1), text);
    }

    if (sub === 'comment') {
      if (!/^\d{1,12}$/.test(args[0] || '')) return `Usage: ${word} github comment ID edit <text>, or ${word} github comment ID delete`;
      const refused = changeOnly();
      if (refused) return refused;
      if (action === 'delete' && args.length > 2) return null;
      return commentChange(policy, repo, Number(args[0]), action, action === 'edit' ? typedAfter(message, rest, phrase(args[0], 'edit')) : '');
    }

    if (sub === 'pr' || sub === 'pull') {
      if (args.length < 2 || !/^#?\d{1,7}$/.test(args[0])) return null;
      const n = Number(args[0].replace('#', ''));
      const refused = changeOnly();
      if (['merge', 'close'].includes(action)) {
        if (refused) return refused;
        if (action === 'close' && args.length > 2) return null;
        return pullChange(policy, repo, n, action, args.slice(2));
      }
      if (['comment', 'title', 'body'].includes(action)) {
        if (refused) return refused;
        return issueChange(policy, repo, n, action, args.slice(2), typedAfter(message, rest, phrase(args[0], action)));
      }
      return null;
    }

    if (sub === 'files') {
      if (args.length > 1) return null;
      return read(() => listFiles(policy, repo, (args[0] || '').replace(/\/+$/, '')));
    }
    if (sub === 'file') {
      const path = (args[0] || '').replace(/^\/+/, '');
      if (!path) return `Usage: ${word} github file <path>, ${word} github file <path> write (then the new content), ${word} github file <path> delete`;
      if (!validPath(path)) return `"${shown(path, 60)}" is not a file path in the repository.`;
      if (args.length === 1) return read(() => showFile(policy, repo, path));
      if (action !== 'write' && action !== 'delete') return null;
      if (action === 'delete' && args.length > 2) return null;
      const refused = changeOnly();
      if (refused) return refused;
      return fileChange(policy, repo, path, action, action === 'write' ? typedAfter(message, rest, phrase(args[0], 'write')) : '');
    }

    if (sub === 'commits') {
      if (args.length > 1) return null;
      return read(() => listCommits(policy, repo, args[0] || ''));
    }
    if (sub === 'commit') {
      if (!validSha(args[0] || '')) return `Usage: ${word} github commit <id>, or ${word} github commit <id> revert`;
      if (args.length === 1) return read(() => showCommit(policy, repo, args[0]));
      if (action !== 'revert' || args.length > 2) return null;
      const refused = changeOnly();
      if (refused) return refused;
      return revertCommit(policy, repo, args[0]);
    }
    return null;
  }

  // ---- AI drafts ----

  // What the AI gets to see: { target, content, seen } for an issue or pull request (target.n) or a file (target.path).
  // seen is the version the draft is based on, checked again before the change is offered. Throws GitHubError.
  async function source(policy, target) {
    const repo = policy.githubRepo;
    if (target.n) {
      const issue = await github.getIssue(repo, target.n);
      const comments = issue.comments ? (await github.listComments(repo, target.n)).slice(-10) : [];
      return { target: `${issue.pull ? 'pull request' : 'issue'} #${issue.number} in ${repo}`,
        content: [`Title: ${issue.title}`, `State: ${issue.state}`, `Description:\n${issue.body || '(empty)'}`,
          ...comments.map(c => `Comment by ${c.user}:\n${c.body}`)].join('\n\n').slice(0, 30000),
        seen: { updatedAt: issue.updatedAt } };
    }
    const { defaultBranch } = await github.repository(repo);
    const file = await github.getFile(repo, target.path, defaultBranch);
    if (file && file.type !== 'file') throw new GitHubError(`${shown(target.path, 80)} is a folder, not a file.`);
    if (file && file.text === null) throw new GitHubError(`${shown(target.path, 80)} is too large or not text to draft from the chat.`);
    if (file && file.text.length > 30000) throw new GitHubError(`${shown(target.path, 80)} is too long to draft from the chat (30000 characters at most).`);
    return { target: `the file ${target.path} in ${repo} (on ${defaultBranch})`, content: file ? file.text : '(this file does not exist yet)',
      seen: { sha: file ? file.sha : null } };
  }

  // A checked draft (drafts.js) as a change waiting for the code. clean: takes out links the AI added (onlyKnownLinks);
  // seen: the version source() read.
  async function applyDraft(policy, target, draft, clean, seen = {}) {
    const draftNote = 'Drafted by the AI. ';
    return oneGitHubCall(policy, async () => {
      try {
        if (target.path) return await fileChange(policy, policy.githubRepo, target.path, 'write', clean(draft.content), { draft: draftNote, sha: seen.sha });
        return await issueChange(policy, policy.githubRepo, target.n, draft.action, [], clean(draft.text),
          { draft: draftNote, updatedAt: seen.updatedAt ?? null });
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        return `GitHub: ${error.message}`;
      }
    }, true);
  }

  return { run, source, applyDraft, reserveWrite };
}

module.exports = { createGitHubChanges, typedAfter, phrase, lineDiff };
