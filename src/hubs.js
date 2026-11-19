'use strict';

// A private folder of files per chat, under hubs/<name>/ on this machine. The bot is the only door: a command in a
// chat can list or fetch files from that chat's own folder and nowhere else. A file is only ever chosen from the
// folder's own listing (never by joining a path the chat typed), links are skipped, and the folder itself must be a
// plain directory directly inside hubs/, so no name, link or "../" can reach another chat's files or the machine.

const fs = require('node:fs');
const path = require('node:path');

const HUB_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
const MAX_DEPTH = 4;

function validHubName(name) {
  return typeof name === 'string' && name.length <= 64 && HUB_NAME.test(name);
}

// The chat's hub folder, or null when it is missing, a link, or not directly inside hubs/.
function hubFolder(hubsRoot, name, fsApi = fs) {
  if (!hubsRoot || !validHubName(name)) return null;
  try {
    const root = fsApi.lstatSync(hubsRoot);
    if (!root.isDirectory()) return null;
    const dir = path.join(hubsRoot, name);
    const stat = fsApi.lstatSync(dir);
    if (!stat.isDirectory()) return null;
    if (path.dirname(fsApi.realpathSync(dir)) !== fsApi.realpathSync(hubsRoot)) return null;
    return dir;
  } catch { return null; }
}

// Regular files, by path relative to the hub ("slides/week1.pdf"). Hidden names and links are skipped and counted.
function listHub(dir, { maxFiles = 500, maxEntries = 5000, fsApi = fs } = {}) {
  const files = [];
  let links = 0, truncated = false, seen = 0;
  const stack = [{ rel: '', depth: 0 }];
  while (stack.length) {
    const { rel, depth } = stack.pop();
    let names;
    try { names = fsApi.readdirSync(path.join(dir, ...rel.split('/').filter(Boolean))).sort(); } catch { continue; }
    for (const name of names) {
      if (++seen > maxEntries) { truncated = true; break; }
      if (name.startsWith('.')) continue;
      const relative = rel ? `${rel}/${name}` : name;
      let stat;
      try { stat = fsApi.lstatSync(path.join(dir, ...relative.split('/'))); } catch { continue; }
      if (stat.isSymbolicLink()) { links++; continue; }
      if (stat.isDirectory()) { if (depth + 1 < MAX_DEPTH) stack.push({ rel: relative, depth: depth + 1 }); continue; }
      if (!stat.isFile()) continue;
      if (files.length >= maxFiles) { truncated = true; continue; }
      files.push({ name: relative, size: stat.size });
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { files, links, truncated };
}

// Before the AI may read a hub: the whole tree, hidden entries and any depth included, must hold only plain
// folders and files (no links, sockets or devices), within a size the check can finish.
function hubIsPlain(dir, { maxEntries = 20000, fsApi = fs } = {}) {
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const current = stack.pop();
    let names;
    try { names = fsApi.readdirSync(current); } catch { return false; }
    for (const name of names) {
      if (++seen > maxEntries) return false;
      let stat;
      try { stat = fsApi.lstatSync(path.join(current, name)); } catch { return false; }
      if (stat.isDirectory()) stack.push(path.join(current, name));
      else if (!stat.isFile()) return false;
    }
  }
  return true;
}

// Match what someone typed against the listing: exact name, then case-insensitive name, then file name without its
// folder, then a unique part of a name.
function findHubFile(files, query) {
  const wanted = String(query || '').trim().replace(/\\/g, '/');
  if (!wanted) return { matches: [] };
  const lower = wanted.toLowerCase();
  for (const test of [
    f => f.name === wanted,
    f => f.name.toLowerCase() === lower,
    f => f.name.split('/').pop().toLowerCase() === lower
  ]) {
    const hits = files.filter(test);
    if (hits.length === 1) return { file: hits[0] };
    if (hits.length > 1) return { matches: hits };
  }
  const partial = files.filter(f => f.name.toLowerCase().includes(lower));
  return partial.length === 1 ? { file: partial[0] } : { matches: partial };
}

// The absolute path of a listed file, re-checked just before use.
function hubFilePath(dir, file, fsApi = fs) {
  const full = path.join(dir, ...file.name.split('/'));
  const stat = fsApi.lstatSync(full);
  if (!stat.isFile()) throw new Error('not a plain file');
  if (!fsApi.realpathSync(full).startsWith(fsApi.realpathSync(dir) + path.sep)) throw new Error('outside the hub');
  return { full, size: stat.size };
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

module.exports = { validHubName, hubFolder, listHub, hubIsPlain, findHubFile, hubFilePath, formatSize };
