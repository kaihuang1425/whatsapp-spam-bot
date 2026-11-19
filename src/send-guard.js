'use strict';

// Reset on every start. Each chat's first outbound message must answer the owner's own command there.
function createSendGuard() {
  const opened = new Set();
  return {
    canReply(message, policy) {
      return Boolean(policy?.receive && policy.send && message?.type === 'chat' && (opened.has(policy.id) || message.fromMe === true));
    },
    replied(message, policy) { if (message?.fromMe === true && policy?.id) opened.add(policy.id); },
    canWarn(chatId) { return opened.has(chatId); }
  };
}

module.exports = { createSendGuard };
