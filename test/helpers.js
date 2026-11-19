'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Same cleanup guard as the safety tests: only ever remove the folder this helper created.
function tempDirectory(t, prefix = 'spam-bot-test-') {
  const root = path.resolve(process.env.SPAM_BOT_TEST_TMP || os.tmpdir());
  fs.mkdirSync(root, { recursive: true });
  const location = fs.mkdtempSync(path.join(root, prefix));
  t.after(() => {
    if (path.dirname(location) !== root || !path.basename(location).startsWith(prefix)) throw new Error('Unsafe test cleanup path.');
    fs.rmSync(location, { recursive: true, force: true });
  });
  return location;
}

module.exports = { tempDirectory };
