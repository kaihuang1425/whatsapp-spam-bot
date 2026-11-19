'use strict';

// Chrome marks its profile as in use with a SingletonLock link ("<machine>-<pid>") in the profile folder and removes
// it when it closes normally. A Chrome that was killed (a supervisor stop, Ctrl+C in a console) leaves it behind,
// and the next Chrome started on another machine then refuses the profile ("in use by another Chromium process ...
// on another computer"). On PythonAnywhere the always-on worker and the consoles run on different machines, so this
// happened after every stop. Before starting Chrome the bot clears such a lock when the Chrome that left it has
// certainly ended:
// - it was on this machine and that process no longer exists (or is no longer a Chrome on this profile), or
// - this run holds the bot's instance lock (.runtime/instance.lock, on the same shared disk as the profile), so no
//   other copy of the bot is running on any machine (src/safety.js: a lock from another machine is only taken over
//   once its holder has shown no sign of life for 3 minutes), Chrome is only ever started by a running bot, and the
//   profile has not changed for 3 minutes (in case a Chrome outlived its bot).
// A lock held by a live Chrome on this machine is left alone.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// { target, host, pid } of the profile's lock, or null if there is none.
function readProfileLock(profileDir, { fsApi = fs } = {}) {
  let target;
  try { target = fsApi.readlinkSync(path.join(profileDir, 'SingletonLock')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'EINVAL') return { target: '(a plain file)', host: '', pid: NaN };
    throw error;
  }
  const cut = target.lastIndexOf('-');
  return { target, host: cut > 0 ? target.slice(0, cut) : target, pid: cut > 0 ? Number(target.slice(cut + 1)) : NaN };
}

// Whether a live process is a Chrome using this profile. On Linux its command line says so; a process id that was
// reused by something else is not. Elsewhere there is no cheap way to tell, so any live process counts.
function chromeOnProfile(pid, profileDir, { fsApi = fs } = {}) {
  let cmdline;
  try { cmdline = fsApi.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); }
  catch { return true; }
  return cmdline.includes('--user-data-dir=') && cmdline.includes(path.resolve(profileDir));
}

// The newest change time of the profile's own entries (its top folder and Default/), or 0. Chrome writes there
// while it runs, so a recent change means a Chrome may still be using the profile.
function lastUsed(profileDir, { fsApi = fs } = {}) {
  let newest = 0;
  for (const dir of [profileDir, path.join(profileDir, 'Default')]) {
    let names = [];
    try { names = fsApi.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (LOCK_FILES.includes(name)) continue;
      try { newest = Math.max(newest, fsApi.lstatSync(path.join(dir, name)).mtimeMs); } catch { /* gone meanwhile */ }
    }
  }
  return newest;
}

// {} when there was no lock, { cleared: target } when it was removed, { kept: target, reason } when it stays.
// A lock from another machine is also kept while the profile changed within recentMs, so a Chrome that outlived
// its bot is not joined by a second one; a few minutes after a stop the lock goes.
function clearStaleProfileLock(profileDir, { holdsInstanceLock = false, hostname = os.hostname(), isAlive = processAlive,
  isChrome = chromeOnProfile, now = Date.now(), recentMs = 3 * 60 * 1000, fsApi = fs } = {}) {
  const lock = readProfileLock(profileDir, { fsApi });
  if (!lock) return {};
  const here = lock.host === hostname;
  if (here && Number.isSafeInteger(lock.pid) && lock.pid > 0 && isAlive(lock.pid) && isChrome(lock.pid, profileDir, { fsApi })) {
    return { kept: lock.target, reason: `Chrome process ${lock.pid} on this machine is still running with the WhatsApp profile` };
  }
  if (!here && !holdsInstanceLock) {
    return { kept: lock.target, reason: 'it was left on another machine, and without the bot\'s instance lock this run cannot tell whether that Chrome has ended' };
  }
  if (!here && lastUsed(profileDir, { fsApi }) > now - recentMs) {
    return { kept: lock.target, reason: 'that Chrome was using the profile less than 3 minutes ago. Wait a few minutes, then start again' };
  }
  for (const name of LOCK_FILES) {
    try { fsApi.unlinkSync(path.join(profileDir, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { cleared: lock.target };
}

// A startup error from Chrome itself (it never started), as opposed to one from WhatsApp: nothing reached WhatsApp,
// so there is no account to check and no reason to record a connection pause.
function isBrowserLaunchFailure(error) {
  const message = String(error?.message ?? error);
  return /^Failed to launch the browser process/i.test(message) || /^Timed out after \d+ ?ms while waiting for the WS endpoint URL/i.test(message);
}

module.exports = { clearStaleProfileLock, readProfileLock, isBrowserLaunchFailure, LOCK_FILES };
