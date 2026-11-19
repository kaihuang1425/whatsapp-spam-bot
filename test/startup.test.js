'use strict';

// The startup timeout: how long WhatsApp Web may take to load after the login before the bot gives up. The behaviour
// itself is checked end to end (tools/e2e/run.js, "stuck-loading"), with a simulated WhatsApp Web that never loads.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, validateConfig } = require('../src/config');

test('the loading timeout has a safe default and sane bounds', () => {
  const config = loadConfig();
  assert.deepEqual(config.startup, { readyTimeoutSeconds: 300 });
  const withStartup = startup => ({ ...structuredClone(config), startup });
  for (const bad of [9, 3601, 30.5, '300', null]) {
    assert.throws(() => validateConfig(withStartup({ readyTimeoutSeconds: bad })), /startup\.readyTimeoutSeconds must be a whole number of seconds from 10 to 3600/, String(bad));
  }
  validateConfig(withStartup({ readyTimeoutSeconds: 10 }));
  validateConfig(withStartup({ readyTimeoutSeconds: 3600 }));
  const old = structuredClone(config);
  delete old.startup;
  assert.deepEqual(validateConfig(old).startup, { readyTimeoutSeconds: 300 });
});
