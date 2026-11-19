'use strict';

function handleQr(code, { unattended, display, onLinkRequired }) {
  if (unattended) return onLinkRequired();
  return display(code);
}

module.exports = { handleQr };
