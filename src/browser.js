'use strict';

const fs = require('node:fs');
const path = require('node:path');

function findBrowserExecutable({ env = process.env, exists = fs.existsSync, bundledPath } = {}) {
  if (env.CHROME_PATH) {
    if (!exists(env.CHROME_PATH)) throw new Error('CHROME_PATH points to a missing file. Correct it or clear that environment variable.');
    return env.CHROME_PATH;
  }
  const bundled = bundledPath ?? require('puppeteer').executablePath();
  const candidates = [bundled];
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
    if (base) {
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  }
  candidates.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  );
  return candidates.find(candidate => candidate && exists(candidate));
}

// The browser needs none of the bot's credentials; keep them out of its environment.
const SECRET_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

function buildBrowserOptions(executablePath, { env = process.env, platform = process.platform } = {}) {
  const browserEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !SECRET_ENV.includes(key)));
  const options = { headless: true, executablePath, env: browserEnv };
  // Explicit host-only opt-in. Keep the browser sandbox enabled elsewhere.
  if (env.SPAM_BOT_NO_SANDBOX === '1') {
    if (platform !== 'linux') throw new Error('SPAM_BOT_NO_SANDBOX is supported only on the approved Linux host.');
    options.args = ['--disable-gpu', '--no-sandbox'];
  }
  return options;
}

module.exports = { findBrowserExecutable, buildBrowserOptions };
