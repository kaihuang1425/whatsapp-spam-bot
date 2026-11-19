'use strict';

// Owner-only files, as on a shared server: no other account may read the WhatsApp login, the API key, the chat
// settings or anything the bot recorded. Group and other permission bits are removed; the owner's are kept.
// Linux and macOS only: Windows controls access with ACLs, and chmod there only toggles read-only.

const fs = require('node:fs');
const path = require('node:path');

// Relative to the bot folder. The folder itself is locked too, so others cannot list or enter it at all.
const PRIVATE_TREES = ['.wwebjs_auth', 'data', 'logs', '.runtime', 'hubs'];
const PRIVATE_FILES = ['.env', 'config.json'];
const MAX_ENTRIES = 200000;

function lockDown(root, { platform = process.platform, fsApi = fs } = {}) {
  const result = { skipped: platform === 'win32', changed: [], failed: [], leftAlone: [], truncated: false };
  if (result.skipped) return result;
  let seen = 0;
  let rootDevice = null;

  // Only what really sits in this folder is changed. Symbolic links are never followed (chmod on a link changes
  // what it points to), hard-linked files may be the same file as one elsewhere, and another file system is
  // someone else's. Those are left alone and reported when they are one of the named private items.
  function tighten(target, { named = false } = {}) {
    let stat;
    try { stat = fsApi.lstatSync(target); } catch (error) {
      if (error.code !== 'ENOENT') result.failed.push({ path: target, error: error.message });
      return null;
    }
    const foreign = (rootDevice !== null && stat.dev !== rootDevice) || (stat.isFile() && stat.nlink > 1);
    if (stat.isSymbolicLink() || foreign) {
      if (named || foreign) result.leftAlone.push(target);
      return null;
    }
    if (!stat.isFile() && !stat.isDirectory()) return null;
    const mode = stat.mode & 0o7777;
    const next = mode & 0o700;
    if (next !== mode) {
      try {
        fsApi.chmodSync(target, next);
        result.changed.push({ path: target, from: mode, to: next });
      } catch (error) { result.failed.push({ path: target, error: error.message }); }
    }
    return stat;
  }

  function tree(top) {
    const stack = [top];
    while (stack.length) {
      const current = stack.pop();
      if (++seen > MAX_ENTRIES) { result.truncated = true; return; }
      const stat = tighten(current, { named: current === top });
      if (!stat?.isDirectory()) continue;
      let names;
      try { names = fsApi.readdirSync(current); } catch (error) { result.failed.push({ path: current, error: error.message }); continue; }
      for (const name of names) stack.push(path.join(current, name));
    }
  }

  const rootStat = tighten(root, { named: true });
  if (!rootStat) return result;
  rootDevice = rootStat.dev ?? null;
  for (const name of PRIVATE_TREES) tree(path.join(root, name));
  for (const name of PRIVATE_FILES) tighten(path.join(root, name), { named: true });
  return result;
}

// One line for the console: how many items changed, and the top-level ones by name.
function lockDownSummary(root, result) {
  if (result.skipped) return null;
  const lines = [];
  if (result.changed.length) {
    const top = result.changed.filter(x => path.dirname(x.path) === root || x.path === root)
      .map(x => `${x.path === root ? '.' : path.basename(x.path)} ${x.from.toString(8)}->${x.to.toString(8)}`);
    lines.push(`Private files: other accounts' access removed from ${result.changed.length} item(s)` +
      (top.length ? ` (${top.join(', ')})` : '') + '.');
  }
  if (result.leftAlone.length) {
    const names = result.leftAlone.slice(0, 5).map(p => path.relative(root, p) || '.');
    lines.push(`[NOTE] Left as they are (a link, a hard link or another drive, so possibly not ours): ${names.join(', ')}` +
      `${result.leftAlone.length > 5 ? ` and ${result.leftAlone.length - 5} more` : ''}. Their real files are not made private.`);
  }
  if (result.failed.length) {
    lines.push(`[WARNING] Could not make ${result.failed.length} private item(s) owner-only, for example ` +
      `${result.failed[0].path}: ${result.failed[0].error}`);
  }
  if (result.truncated) lines.push(`[WARNING] Stopped after ${MAX_ENTRIES} items; some private files were not checked.`);
  return lines.length ? lines.join('\n') : null;
}

module.exports = { lockDown, lockDownSummary, PRIVATE_TREES, PRIVATE_FILES };
