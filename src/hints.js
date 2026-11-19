'use strict';

// The command that clears a local pause, written the way it has to be typed on this machine: npm on Windows, and
// the bot's own copy of Node elsewhere (PythonAnywhere has no npm on PATH).

const path = require('node:path');

function resumeCommand({ platform = process.platform, execPath = process.execPath, root = path.resolve(__dirname, '..') } = {}) {
  if (platform === 'win32') return 'npm.cmd run resume -- --reviewed';
  const quote = value => (/^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`);
  return `cd ${quote(root)} && ${quote(execPath)} src/cli.js resume --reviewed`;
}

module.exports = { resumeCommand };
