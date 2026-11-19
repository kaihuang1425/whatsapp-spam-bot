'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handleQr } = require('../src/pairing');

test('unattended pairing pauses without exposing the QR credential', () => {
  let paused = false;
  handleQr('fixture-credential', {
    unattended: true,
    display: () => assert.fail('QR must not reach unattended logs'),
    onLinkRequired: () => { paused = true; }
  });
  assert.equal(paused, true);
});

test('interactive pairing sends the code only to the terminal display', () => {
  let shown;
  handleQr('fixture-credential', {
    unattended: false,
    display: code => { shown = code; },
    onLinkRequired: () => assert.fail('Interactive pairing must remain available')
  });
  assert.equal(shown, 'fixture-credential');
});
