'use strict';

const { SpamDetector } = require('./detector');
const { createWarningGate, createDeletionGate } = require('./safety');
const { createSendGuard } = require('./send-guard');

const DELETION_STATUSES = ['confirmed', 'skipped', 'unconfirmed', 'deleted-for-me', 'requested-for-me'];
const REMOVED = ['confirmed', 'deleted-for-me', 'requested-for-me'];

function createModerator({ config, clock = Date.now, onFlag = () => {}, onAction = () => {}, onError = console.error,
  warningGate, deletionGate, deleteMessage, getPolicy, learned = null, members = null, sendGuard = createSendGuard() }) {
  const detector = new SpamDetector(config, { clock, learned, members });
  const groups = new Set(config.groupIds);
  // Without per-chat policies (older configs), groupIds are moderated and deletion follows deletion.enabled.
  const policyFor = getPolicy || (chatId => (groups.has(chatId) ? { spam: 'delete', send: true } : null));
  const seen = new Map();
  const gate = warningGate || createWarningGate({ config: config.warning, clock });
  const removalGate = deletionGate || createDeletionGate({ config: config.deletion, clock });
  // A serial queue preserves order and prevents simultaneous warning bursts.
  let queue = Promise.resolve();

  // One removal path for automatic and owner-marked deletions: budget, pause on failure, audit record.
  async function remove(message, record, { byOwner = false } = {}) {
    let outcome;
    try {
      if (!deleteMessage) outcome = { status: 'skipped', reason: 'deletion-adapter-unavailable' };
      else if (!removalGate.reserve(message.from, record.messageId)) outcome = { status: 'skipped', reason: 'deletion-paused-or-budget-exhausted' };
      else {
        outcome = await deleteMessage(message, { byOwner });
        if (!DELETION_STATUSES.includes(outcome?.status)) throw new Error('Invalid deletion outcome.');
        if (outcome.status === 'unconfirmed') removalGate.pause('DELETE_UNCONFIRMED');
      }
    } catch (error) {
      outcome = { status: 'failed', reason: 'deletion-error' };
      try { removalGate.pause('DELETE_FAILURE'); }
      catch (pauseError) { onError(`Could not persist deletion pause: ${pauseError.message}`); }
      onError(`Deletion failed; further removals are paused. Check the group and phone app before resuming. ${error.message}`);
    }
    // Keep a private copy of anything removed, so a wrong deletion can be reviewed and the text recovered.
    const kept = REMOVED.includes(outcome.status) && config.deletion.keepDeletedText ? { text: String(message.body || '').slice(0, 2000) } : {};
    await onAction({ ...record, ...kept, event: 'moderation', action: outcome.action || 'delete-for-everyone', ...outcome });
    return outcome;
  }

  async function handle(message) {
    if (!message || message.fromMe || message.isStatus || message.broadcast || typeof message.from !== 'string') return;
    const isGroup = message.from.endsWith('@g.us');
    if (isGroup ? !message.author : !/@(?:c\.us|lid)$/.test(message.from)) return;
    const policy = policyFor(message.from);
    if (!policy || policy.spam === 'off') return;
    if (!['chat', 'image', 'video', 'document', 'audio', 'ptt', 'sticker'].includes(message.type)) return;
    const id = message.id?._serialized;
    if (!id || seen.has(id)) return;
    const now = clock();
    // Do not score or warn on messages delivered from old history after reconnect.
    if (!Number.isFinite(message.timestamp) || Math.abs(now - message.timestamp * 1000) > 120000) return;
    seen.set(id, now);
    if (seen.size > 10000) seen.delete(seen.keys().next().value);

    const senderId = message.author || message.from;
    const result = detector.check({ chatId: message.from, senderId, text: message.body });
    if (!result.isSpam) return result;
    const record = {
      event: 'flag',
      classification: result.certain.length ? 'owner_pattern_match' : result.strict.length ? 'pattern_match' : 'suspected_spam',
      time: new Date(now).toISOString(),
      chatId: message.from,
      senderId,
      messageId: id,
      score: result.score,
      reasons: result.reasons,
      strictRules: result.strict,
      deleteSignals: result.certain
    };
    if (config.logMessageText) record.text = String(message.body || '').slice(0, 2000);
    await onFlag(record);

    // Strict mode deletes only on patterns the owner chose (blocked domains, marked spam, rules set to delete);
    // everything else stays flagged for review.
    const deletable = config.deletion.mode === 'strict' ? result.certain.length > 0 : result.score >= config.deletion.threshold;
    if (config.deletion.enabled && policy.spam === 'delete' && deletable) {
      const outcome = await remove(message, record);
      // Do not reply to a message that has just been removed.
      if (REMOVED.includes(outcome.status)) return result;
    }

    // Re-check after awaited moderation work: a config reload may have disabled this chat meanwhile.
    const latest = policyFor(message.from);
    if (config.warning.enabled && sendGuard.canWarn(message.from) && latest && latest.receive !== false && latest.send && gate.reserve(message.from, senderId)) {
      const labels = [...new Set(result.reasons.map(reason => ({
        keyword: 'keyword match', link: 'link', 'short-link': 'shortened link',
        'blocked-domain': 'blocked domain', 'many-links': 'many links', duplicate: 'repeated message', flood: 'rapid messages'
      })[reason.code]))];
      try {
        await message.reply(`${config.replyPrefix} Possible spam (${labels.join(', ')}). Please ask a group admin to review; automated checks can be wrong.`, undefined, {
          linkPreview: false, sendSeen: false, ignoreQuoteErrors: true
        });
      } catch (error) {
        try { gate.pause('SEND_FAILURE'); }
        catch (pauseError) { onError(`Could not persist warning pause: ${pauseError.message}`); }
        onError(`Warning delivery failed; automatic replies are paused. Check the phone app before resuming. ${error.message}`);
      }
    }
    return result;
  }

  // The owner replied "<buzzword> spam" to this message: learn it, then remove it on their behalf.
  async function markSpam(message) {
    const isGroup = String(message.from).endsWith('@g.us');
    const senderId = message.author || message.from;
    const id = message.id?._serialized;
    if (!id || message.fromMe || (isGroup && !message.author)) return { status: 'skipped', reason: 'not-a-message-from-someone-else' };
    const result = detector.check({ chatId: message.from, senderId: 'owner-mark', text: message.body });
    let added = { text: false, links: [], skippedLinks: [] };
    // A failure to save what was learned must not stop the removal the owner asked for.
    try { if (learned) added = learned.learn(result.normalized, result.links); }
    catch (error) { onError(`Could not save marked spam to data/learned-spam.json: ${error.message}`); }
    const record = { event: 'flag', classification: 'owner_marked', time: new Date(clock()).toISOString(), chatId: message.from,
      senderId, messageId: id, score: result.score, reasons: result.reasons, strictRules: result.strict, deleteSignals: ['marked by you'] };
    await onFlag(record);
    const outcome = config.deletion.enabled ? await remove(message, record, { byOwner: true }) : { status: 'skipped', reason: 'deletion-disabled' };
    return { ...outcome, learned: added };
  }

  function moderate(message) {
    const pending = queue.then(() => handle(message));
    queue = pending.catch(error => onError(`Message processing failed: ${error.message}`));
    return pending;
  }
  moderate.markSpam = message => {
    const pending = queue.then(() => markSpam(message));
    queue = pending.catch(error => onError(`Marking spam failed: ${error.message}`));
    return pending;
  };
  return moderate;
}

module.exports = { createModerator };
