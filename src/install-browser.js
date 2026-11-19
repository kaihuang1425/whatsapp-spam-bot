'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('./config');
const { findBrowserExecutable } = require('./browser');

try {
  process.env.PUPPETEER_CACHE_DIR ||= path.join(ROOT, '.browser-cache');
  let executable = findBrowserExecutable();
  if (!executable) {
    console.log('Downloading Chrome for the bot...');
    const result = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'puppeteer', 'install.mjs')], {
      stdio: 'inherit', env: process.env
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Browser installation failed. Install Google Chrome or set CHROME_PATH to an existing browser executable.');
    executable = findBrowserExecutable();
  }
  if (!executable) throw new Error('No browser found. Install Google Chrome, then run SETUP.cmd again.');
  console.log(`Browser ready: ${executable}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
