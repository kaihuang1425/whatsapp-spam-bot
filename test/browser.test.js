'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { findBrowserExecutable, buildBrowserOptions } = require('../src/browser');

test('honours an explicit existing browser path', () => {
  assert.equal(findBrowserExecutable({ env: { CHROME_PATH: 'custom-browser' }, exists: p => p === 'custom-browser' }), 'custom-browser');
});

test('rejects a missing explicit browser path with a useful error', () => {
  assert.throws(() => findBrowserExecutable({ env: { CHROME_PATH: 'missing' }, exists: () => false }), /CHROME_PATH/);
});

test('uses the bundled executable when present', () => {
  assert.equal(findBrowserExecutable({ env: {}, bundledPath: 'bundled', exists: p => p === 'bundled' }), 'bundled');
});

test('falls back to installed Chrome when the browser download is incomplete', () => {
  const chrome = path.join('programs', 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.equal(findBrowserExecutable({ env: { ProgramFiles: 'programs' }, bundledPath: 'missing-bundle', exists: p => p === chrome }), chrome);
});

test('returns no executable when setup or installation is needed', () => {
  assert.equal(findBrowserExecutable({ env: {}, bundledPath: '', exists: () => false }), undefined);
});

test('keeps the browser sandbox enabled by default on Linux', () => {
  assert.deepEqual(buildBrowserOptions('/usr/bin/chromium', { env: {}, platform: 'linux' }), {
    headless: true, executablePath: '/usr/bin/chromium', env: {}
  });
});

test('the browser never sees the bot\'s API key or subscription token', () => {
  const env = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o', SPAM_BOT_NO_SANDBOX: '1' };
  assert.deepEqual(buildBrowserOptions('/usr/bin/chromium', { env, platform: 'linux' }).env, { PATH: '/usr/bin', SPAM_BOT_NO_SANDBOX: '1' });
});

test('uses the host workaround only with an explicit Linux opt-in', () => {
  assert.deepEqual(buildBrowserOptions('/usr/bin/chromium', { env: { SPAM_BOT_NO_SANDBOX: '1' }, platform: 'linux' }).args,
    ['--disable-gpu', '--no-sandbox']);
});

test('does not treat other environment values as sandbox approval', () => {
  assert.equal(buildBrowserOptions('chrome', { env: { SPAM_BOT_NO_SANDBOX: 'true' }, platform: 'linux' }).args, undefined);
});

test('rejects accidental sandbox disabling on a different platform', () => {
  assert.throws(() => buildBrowserOptions('chrome', { env: { SPAM_BOT_NO_SANDBOX: '1' }, platform: 'win32' }), /Linux host/);
});
