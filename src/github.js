'use strict';

// GitHub from a chat: the chat's linked repository (chats[].githubRepo). Reading: issues, comments, pull requests, files
// and commits. Writing (the commands decide who may, and which changes wait for the owner's confirm code): issues and
// their comments, files (each change is a commit), pull requests (including merging) and reverting a commit with a new
// commit. Nothing here force-pushes or rewrites history: a branch only ever moves forward. It uses a fine-grained token
// (GITHUB_TOKEN in .env) that the owner limits to that repository, and never shows it: no error message carries it or
// GitHub's own reply text.

const { STRIP } = require('./instructions');
const { stripLinksAndNumbers } = require('./items');

const API = 'https://api.github.com';
// OWNER/REPO as GitHub allows them: owner 1-39 letters, digits and dashes; repository letters, digits, ".", "_", "-".
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const MAX_LISTED = 10;
// The largest file shown or changed from a chat, and the most files one revert may touch.
const MAX_FILE_BYTES = 200000;
const MAX_REVERT_FILES = 20;

class GitHubError extends Error {}

function validRepo(name) {
  return typeof name === 'string' && REPO.test(name) && !/\/\.{1,2}$/.test(name);
}

// A path inside the repository: relative, no "." or ".." parts, no empty parts, no control characters or backslashes.
function validPath(path) {
  if (typeof path !== 'string' || !path || path.length > 300 || /[\u0000-\u001f\u007f\\]/.test(path)) return false;
  return path.split('/').every(part => part && part !== '.' && part !== '..');
}

// A branch name the bot may use: letters, digits and . _ / -, no "..", not starting with "-" or ending in "/" or ".lock".
function validBranch(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._/-]{1,100}$/.test(name) && !name.includes('..') && !name.startsWith('-') &&
    !name.startsWith('/') && !name.endsWith('/') && !name.endsWith('.lock') && !name.includes('//');
}

function validSha(text) {
  return typeof text === 'string' && /^[0-9a-f]{7,40}$/i.test(text);
}

const encodePath = path => path.split('/').map(encodeURIComponent).join('/');

// GitHub text (titles, branch names, logins) written by anyone with access to the repository, as one safe line.
function oneLine(text, max = 100) {
  const chars = [...String(text ?? '').replace(STRIP, ' ').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

// Text that anyone with access to the repository wrote (in a public one, anyone at all), as the chat sees it: one
// line, with links and long numbers taken out, so a title cannot post a phishing link from the owner's account.
function shown(text, max = 100) {
  return stripLinksAndNumbers(oneLine(text, max));
}

// Several lines of GitHub text (an issue body, a comment, a file) as the chat sees it: line breaks kept, everything else
// as in shown(), at most maxLines lines and maxChars characters, with a note when something was left out.
function shownBlock(text, { maxChars = 1500, maxLines = 40, more = '(cut short; the rest is on GitHub)' } = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
    .map(line => stripLinksAndNumbers([...line.replace(STRIP, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g, ' ')]
      .join('').replace(/[ \t]+$/, '')));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let out = lines.slice(0, maxLines).join('\n');
  const cut = lines.length > maxLines || [...out].length > maxChars;
  if ([...out].length > maxChars) out = [...out].slice(0, maxChars - 1).join('');
  return cut ? `${out}…\n${more}` : out;
}

function describeStatus(status, repo, headers) {
  if (status === 401) return 'GitHub rejected the token: check GITHUB_TOKEN in .env (it may have expired).';
  if (status === 403 && headers?.get?.('x-ratelimit-remaining') === '0') return 'GitHub\'s rate limit is reached; try again later.';
  if (status === 403) return `the token may not do that in ${repo}. It needs Contents, Issues and Pull requests: read and write (and Workflows for files in .github/workflows).`;
  if (status === 404) return `${repo} was not found, or the token cannot see it (add it under the token's Repository access).`;
  if (status === 405) return 'GitHub will not do that as things are (for a merge: a required review or check, or conflicts).';
  if (status === 409) return 'it changed on GitHub since you asked; ask again.';
  if (status === 410) return `issues are turned off in ${repo}.`;
  if (status === 422) return 'GitHub refused it as invalid.';
  if (status === 429) return 'GitHub\'s rate limit is reached; try again later.';
  return `GitHub answered with error ${status}.`;
}

function createGitHub({ getToken = () => process.env.GITHUB_TOKEN || '', fetchFn = globalThis.fetch, timeoutMs = 15000 } = {}) {
  // REST calls under /repos/OWNER/REPO. A 404 can be turned into null (notFound: 'null') where "missing" is an answer.
  async function call(method, repo, pathname, body, { notFound = 'error' } = {}) {
    if (!validRepo(repo)) throw new GitHubError(`"${oneLine(repo, 60)}" is not a repository name like OWNER/REPO.`);
    return request(method, `${API}/repos/${repo}${pathname}`, body, repo, notFound);
  }

  async function request(method, url, body, repo, notFound = 'error') {
    const token = String(getToken() || '').trim();
    if (!token) throw new GitHubError('there is no GITHUB_TOKEN in .env yet (see "GitHub" in COMMANDS.md).');
    let response;
    try {
      response = await fetchFn(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'whatsapp-spam-bot',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new GitHubError(error?.name === 'TimeoutError' ? 'GitHub did not answer in time.' : 'could not reach GitHub (network).');
    }
    if (response.status === 404 && notFound === 'null') return null;
    if (!response.ok) throw new GitHubError(describeStatus(response.status, repo, response.headers));
    if (response.status === 204) return {};
    try { return await response.json(); }
    catch { throw new GitHubError('GitHub\'s answer could not be read.'); }
  }

  function number(n) {
    if (!Number.isSafeInteger(n) || n < 1) throw new GitHubError('that is not an issue or pull request number.');
    return n;
  }
  function checkPath(path) {
    if (!validPath(path)) throw new GitHubError(`"${oneLine(path, 60)}" is not a file path in the repository.`);
    return encodePath(path);
  }
  function checkBranch(name) {
    if (!validBranch(name)) throw new GitHubError(`"${oneLine(name, 60)}" is not a branch name the bot can use.`);
    return name.split('/').map(encodeURIComponent).join('/');
  }
  function checkSha(sha) {
    if (!validSha(sha)) throw new GitHubError(`"${oneLine(sha, 60)}" is not a commit id.`);
    return sha;
  }
  const ref = branch => (branch ? `?ref=${checkBranch(branch)}` : '');
  const short = sha => String(sha || '').slice(0, 7);

  // An issue or pull request as the chat sees it.
  function issueView(data) {
    return {
      number: data.number, nodeId: String(data.node_id || ''), title: shown(data.title, 200), body: String(data.body || ''),
      state: data.state, stateReason: data.state_reason || null, user: shown(data.user?.login, 40),
      labels: (data.labels || []).map(label => shown(typeof label === 'string' ? label : label?.name, 40)).filter(Boolean),
      comments: data.comments || 0, pull: Boolean(data.pull_request), updatedAt: String(data.updated_at || ''),
      url: String(data.html_url || '')
    };
  }
  function commentView(data) {
    return { id: data.id, user: shown(data.user?.login, 40), body: String(data.body || ''), created: String(data.created_at || ''),
      updatedAt: String(data.updated_at || ''),
      issue: Number(String(data.issue_url || '').split('/').pop()) || null, url: String(data.html_url || '') };
  }
  // A file's text: null for a folder, a binary file or one too large to show or change from a chat.
  function fileView(data) {
    if (!data || Array.isArray(data) || data.type !== 'file') return { type: Array.isArray(data) ? 'dir' : String(data?.type || 'none') };
    const view = { type: 'file', path: String(data.path || ''), sha: String(data.sha || ''), size: data.size || 0, text: null };
    if (view.size > MAX_FILE_BYTES || typeof data.content !== 'string') return view;
    const bytes = Buffer.from(data.content, 'base64');
    if (bytes.includes(0)) return view;
    try { view.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* not UTF-8 text */ }
    return view;
  }

  return {
    // Whether .env has a token at all (read fresh each time). Says nothing about whether GitHub accepts it.
    hasToken: () => String(getToken() || '').trim() !== '',
    // The repository as the token sees it: proves the token works and can see it.
    async repository(repo) {
      const data = await call('GET', repo, '');
      return { name: oneLine(data.full_name, 140), private: data.private === true, issues: data.has_issues !== false,
        defaultBranch: validBranch(data.default_branch) ? data.default_branch : 'main' };
    },
    async openIssue(repo, { title, body }) {
      const data = await call('POST', repo, '/issues', { title, body });
      return { number: data.number, url: String(data.html_url || '') };
    },
    // Open issues, newest activity first; pull requests (which GitHub also lists as issues) left out.
    async listIssues(repo) {
      const data = await call('GET', repo, '/issues?state=open&sort=updated&direction=desc&per_page=30');
      return (Array.isArray(data) ? data : []).filter(issue => !issue.pull_request).map(issue => ({
        number: issue.number, title: shown(issue.title), user: shown(issue.user?.login, 40), comments: issue.comments || 0
      }));
    },
    async hasOpenIssueTitle(repo, title) {
      if (!validRepo(repo)) throw new GitHubError('The linked repository name is invalid.');
      const phrase = title.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!phrase) return true;
      const query = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${phrase}"`);
      const data = await request('GET', `${API}/search/issues?q=${query}&per_page=100`, undefined, repo);
      if (data.incomplete_results !== false || !Array.isArray(data.items) || data.total_count > data.items.length) {
        throw new GitHubError('GitHub could not complete the duplicate issue check.');
      }
      return data.items.some(issue => !issue.pull_request && String(issue.title).trim().toLowerCase() === title.toLowerCase());
    },
    async listPulls(repo) {
      const data = await call('GET', repo, '/pulls?state=open&sort=updated&direction=desc&per_page=30');
      return (Array.isArray(data) ? data : []).map(pull => ({
        number: pull.number, title: shown(pull.title), user: shown(pull.user?.login, 40), draft: pull.draft === true,
        head: shown(pull.head?.ref, 60), base: shown(pull.base?.ref, 60)
      }));
    },
    async getPull(repo, number) {
      const pull = await call('GET', repo, `/pulls/${number}`);
      return {
        number: pull.number, title: shown(pull.title, 200), user: shown(pull.user?.login, 40), state: pull.state,
        merged: pull.merged === true, draft: pull.draft === true, mergeableState: String(pull.mergeable_state || 'unknown'),
        head: shown(pull.head?.ref, 60), base: shown(pull.base?.ref, 60), additions: pull.additions || 0,
        deletions: pull.deletions || 0, files: pull.changed_files || 0, comments: (pull.comments || 0) + (pull.review_comments || 0),
        url: String(pull.html_url || ''), headSha: validSha(pull.head?.sha) ? pull.head.sha : '', body: String(pull.body || '')
      };
    },

    // Issues (and pull requests, which GitHub also treats as issues) and their comments.
    async getIssue(repo, n) { return issueView(await call('GET', repo, `/issues/${number(n)}`)); },
    // fields: any of title, body, state ("open" / "closed"), state_reason.
    async editIssue(repo, n, fields) { return issueView(await call('PATCH', repo, `/issues/${number(n)}`, fields)); },
    async addLabels(repo, n, labels) {
      const data = await call('POST', repo, `/issues/${number(n)}/labels`, { labels });
      return (Array.isArray(data) ? data : []).map(label => shown(label?.name, 40));
    },
    // The newest comments last (GitHub lists the oldest first; up to 100 are read).
    async listComments(repo, n) {
      const data = await call('GET', repo, `/issues/${number(n)}/comments?per_page=100`);
      return (Array.isArray(data) ? data : []).map(commentView);
    },
    async getComment(repo, id) { return commentView(await call('GET', repo, `/issues/comments/${number(id)}`)); },
    async addComment(repo, n, body) { return commentView(await call('POST', repo, `/issues/${number(n)}/comments`, { body })); },
    async editComment(repo, id, body) { return commentView(await call('PATCH', repo, `/issues/comments/${number(id)}`, { body })); },
    async deleteComment(repo, id) { await call('DELETE', repo, `/issues/comments/${number(id)}`); },
    // Really deleting an issue is only possible through GitHub's GraphQL API, and only for repository admins.
    async deleteIssue(repo, nodeId) {
      if (!validRepo(repo)) throw new GitHubError(`"${oneLine(repo, 60)}" is not a repository name like OWNER/REPO.`);
      if (!/^[A-Za-z0-9_=-]{4,100}$/.test(String(nodeId))) throw new GitHubError('GitHub did not give an id for that issue.');
      const data = await request('POST', `${API}/graphql`, {
        query: 'mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }', variables: { id: nodeId } }, repo);
      if (Array.isArray(data?.errors) && data.errors.length) {
        throw new GitHubError(`GitHub would not delete it (deleting an issue needs admin rights on ${repo}; you can still close it).`);
      }
    },

    // Files. getFile: { type: 'file', path, sha, size, text } (text null when binary or too large), or { type } for a
    // folder; null when there is no such file.
    async getFile(repo, path, branch) {
      const data = await call('GET', repo, `/contents/${checkPath(path)}${ref(branch)}`, undefined, { notFound: 'null' });
      return data === null ? null : fileView(data);
    },
    async listDir(repo, path, branch) {
      const where = path ? `/contents/${checkPath(path)}` : '/contents';
      const data = await call('GET', repo, `${where}${ref(branch)}`, undefined, { notFound: 'null' });
      if (data === null) return null;
      if (!Array.isArray(data)) return { file: true };
      return data.map(entry => ({ name: oneLine(entry.name, 100), type: entry.type === 'dir' ? 'dir' : 'file', size: entry.size || 0 }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    },
    // A new file (no sha) or a new version of one (sha: the version it replaces; GitHub refuses if it changed since).
    async putFile(repo, path, { content, message, sha, branch }) {
      checkBranch(branch);
      const data = await call('PUT', repo, `/contents/${checkPath(path)}`, {
        message, content: Buffer.from(content, 'utf8').toString('base64'), branch, ...(sha ? { sha } : {}) });
      return { commit: String(data.commit?.sha || ''), url: String(data.content?.html_url || '') };
    },
    async deleteFile(repo, path, { message, sha, branch }) {
      checkBranch(branch);
      const data = await call('DELETE', repo, `/contents/${checkPath(path)}`, { message, sha, branch });
      return { commit: String(data.commit?.sha || '') };
    },

    // Branches move only forward: a new branch, or a fast-forward of an existing one (never force).
    async branchSha(repo, branch) {
      const data = await call('GET', repo, `/git/ref/heads/${checkBranch(branch)}`);
      if (!validSha(data.object?.sha)) throw new GitHubError(`GitHub did not say where ${oneLine(branch, 60)} is.`);
      return data.object.sha;
    },
    async createBranch(repo, branch, sha) {
      checkBranch(branch);
      await call('POST', repo, '/git/refs', { ref: `refs/heads/${branch}`, sha: checkSha(sha) });
    },
    async moveBranch(repo, branch, sha) {
      await call('PATCH', repo, `/git/refs/heads/${checkBranch(branch)}`, { sha: checkSha(sha), force: false });
    },

    // Pull requests.
    async openPull(repo, { title, head, base, body }) {
      checkBranch(head); checkBranch(base);
      const data = await call('POST', repo, '/pulls', { title, head, base, body });
      return { number: data.number, url: String(data.html_url || '') };
    },
    // fields: any of title, body, state ("closed" / "open").
    async editPull(repo, n, fields) { await call('PATCH', repo, `/pulls/${number(n)}`, fields); },
    // sha: the head commit the owner saw; GitHub refuses (409) if more was pushed since.
    async mergePull(repo, n, { sha, method }) {
      if (!['merge', 'squash', 'rebase'].includes(method)) throw new GitHubError('the merge method is merge, squash or rebase.');
      const data = await call('PUT', repo, `/pulls/${number(n)}/merge`, { sha: checkSha(sha), merge_method: method });
      return { merged: data.merged === true, sha: validSha(data.sha) ? data.sha : '' };
    },

    // Commits.
    async listCommits(repo, branch) {
      const data = await call('GET', repo, `/commits?per_page=${MAX_LISTED}${branch ? `&sha=${checkBranch(branch)}` : ''}`);
      return (Array.isArray(data) ? data : []).map(commit => ({
        sha: String(commit.sha || ''), short: short(commit.sha), message: shown(String(commit.commit?.message || '').split('\n')[0], 80),
        author: shown(commit.author?.login || commit.commit?.author?.name, 40), date: String(commit.commit?.author?.date || '')
      }));
    },
    async getCommit(repo, sha) {
      const data = await call('GET', repo, `/commits/${checkSha(sha)}`);
      return {
        sha: String(data.sha || ''), short: short(data.sha), subject: shown(String(data.commit?.message || '').split('\n')[0], 120),
        rawSubject: oneLine(String(data.commit?.message || '').split('\n')[0], 120),
        author: shown(data.author?.login || data.commit?.author?.name, 40), date: String(data.commit?.author?.date || ''),
        parents: (data.parents || []).map(parent => String(parent.sha || '')),
        files: (data.files || []).map(file => ({ path: String(file.filename || ''), status: String(file.status || ''),
          previous: file.previous_filename ? String(file.previous_filename) : null, blob: String(file.sha || ''),
          additions: file.additions || 0, deletions: file.deletions || 0 })),
        additions: data.stats?.additions || 0, deletions: data.stats?.deletions || 0
      };
    },

    // Reverting a commit, in two steps so the owner confirms in between. planRevert only reads: it refuses merge
    // commits, renames, more than MAX_REVERT_FILES files, and any file that changed again after the commit (a plain
    // revert would silently undo that later work too). revert then builds one new commit on top of the branch head
    // the plan saw, with those files as they were before the commit; the caller puts it on a branch.
    async planRevert(repo, sha, branch) {
      const commit = await this.getCommit(repo, sha);
      if (commit.parents.length !== 1) throw new GitHubError(`${commit.short} is a merge commit (or the first one); revert it on GitHub or locally.`);
      if (!commit.files.length) throw new GitHubError(`${commit.short} changes no files.`);
      if (commit.files.length > MAX_REVERT_FILES) throw new GitHubError(`${commit.short} changes ${commit.files.length} files; the chat reverts at most ${MAX_REVERT_FILES}.`);
      if (commit.files.some(file => file.previous || !['added', 'modified', 'removed'].includes(file.status) || !validPath(file.path))) {
        throw new GitHubError(`${commit.short} renames or copies files; revert it on GitHub or locally.`);
      }
      const head = await this.branchSha(repo, branch);
      // Only a commit in the branch's own history: a commit from a fork or another branch has a parent the branch
      // never had, and "reverting" it would write that parent's files onto the branch.
      const compared = await call('GET', repo, `/compare/${checkSha(commit.sha)}...${checkSha(head)}`);
      if (!['ahead', 'identical'].includes(compared?.status)) {
        throw new GitHubError(`${commit.short} is not in the history of ${oneLine(branch, 60)}; only its own commits can be reverted from the chat.`);
      }
      for (const file of commit.files) {
        const now = await call('GET', repo, `/contents/${checkPath(file.path)}?ref=${head}`, undefined, { notFound: 'null' });
        const same = file.status === 'removed' ? now === null : now?.type === 'file' && now.sha === file.blob;
        if (!same) throw new GitHubError(`${oneLine(file.path, 80)} changed again after ${commit.short}; revert it on GitHub or locally.`);
      }
      return { commit, branch, head };
    },
    async revert(repo, plan) {
      const { commit, head } = plan;
      if (await this.branchSha(repo, plan.branch) !== head) throw new GitHubError(`${oneLine(plan.branch, 60)} moved since you asked; ask again.`);
      const [headCommit, parentCommit] = await Promise.all([call('GET', repo, `/git/commits/${checkSha(head)}`),
        call('GET', repo, `/git/commits/${checkSha(commit.parents[0])}`)]);
      const tree = await call('GET', repo, `/git/trees/${checkSha(parentCommit.tree?.sha)}?recursive=1`);
      if (tree.truncated) throw new GitHubError('the repository is too large to revert from the chat; revert it on GitHub or locally.');
      const before = new Map((tree.tree || []).filter(entry => entry.type === 'blob').map(entry => [entry.path, entry]));
      const entries = commit.files.map(file => {
        if (file.status === 'added') return { path: file.path, mode: '100644', type: 'blob', sha: null };
        const old = before.get(file.path);
        if (!old) throw new GitHubError(`${oneLine(file.path, 80)} is missing from the commit before ${commit.short}.`);
        return { path: file.path, mode: old.mode, type: 'blob', sha: old.sha };
      });
      const newTree = await call('POST', repo, '/git/trees', { base_tree: checkSha(headCommit.tree?.sha), tree: entries });
      const created = await call('POST', repo, '/git/commits', {
        message: `Revert "${commit.rawSubject}"\n\nThis reverts commit ${commit.sha}.`, tree: checkSha(newTree.sha), parents: [head] });
      return checkSha(created.sha);
    }
  };
}

// What GitHub's mergeable_state means, in words. GitHub works it out in the background, so it can be "unknown" at first.
const MERGE_STATE = {
  clean: 'can be merged',
  has_hooks: 'can be merged',
  unstable: 'can be merged, but some checks failed or are still running',
  blocked: 'blocked: a required review or check is missing',
  behind: 'behind its base branch',
  dirty: 'has merge conflicts',
  draft: 'a draft',
  unknown: 'GitHub is still working out whether it can be merged; ask again in a minute'
};

function more(list) {
  return list.length > MAX_LISTED ? [`...and ${list.length - MAX_LISTED} more on GitHub`] : [];
}

function issuesText(repo, issues) {
  if (!issues.length) return `No open issues in ${repo}.`;
  return [`Open issues in ${repo} (${issues.length}${issues.length >= 30 ? '+' : ''}):`,
    ...issues.slice(0, MAX_LISTED).map(issue => `#${issue.number} ${issue.title} (${issue.user}${issue.comments ? `, ${issue.comments} comments` : ''})`),
    ...more(issues)].join('\n');
}

function pullsText(repo, pulls, word) {
  if (!pulls.length) return `No open pull requests in ${repo}.`;
  return [`Open pull requests in ${repo} (${pulls.length}${pulls.length >= 30 ? '+' : ''}):`,
    ...pulls.slice(0, MAX_LISTED).map(pull => `#${pull.number} ${pull.title} (${pull.user}${pull.draft ? ', draft' : ''}; ${pull.head} → ${pull.base})`),
    ...more(pulls), `Details: ${word} github pr N`].join('\n');
}

function pullText(repo, pull) {
  const state = pull.merged ? 'merged' : pull.state === 'closed' ? 'closed without merging'
    : pull.draft ? 'open, a draft' : `open, ${MERGE_STATE[pull.mergeableState] || pull.mergeableState}`;
  return [`#${pull.number} ${pull.title}`, `By ${pull.user}: ${pull.head} → ${pull.base}. State: ${state}.`,
    `${pull.files} files changed (+${pull.additions} −${pull.deletions}), ${pull.comments} comments.`,
    pull.url.startsWith('https://github.com/') ? `Review and merge on GitHub: ${pull.url}` : null].filter(Boolean).join('\n');
}

// GITHUB_TOKEN from the .env file, read at each use, so adding or replacing it needs no restart; else the environment.
function tokenFrom(envFile, env = process.env, fsApi = require('node:fs')) {
  try {
    const value = require('node:util').parseEnv(fsApi.readFileSync(envFile, 'utf8')).GITHUB_TOKEN;
    if (typeof value === 'string' && value.trim()) return value.trim();
  } catch { /* no .env, or unreadable: fall back to the environment */ }
  return String(env.GITHUB_TOKEN || '').trim();
}

module.exports = { createGitHub, validRepo, validPath, validBranch, validSha, oneLine, shown, shownBlock, issuesText, pullsText, pullText,
  tokenFrom, GitHubError, MAX_LISTED, MAX_FILE_BYTES, MAX_REVERT_FILES, MERGE_STATE };
