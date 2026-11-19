'use strict';

// Per-chat permissions: which chats the bot reads, where it may send, and the word that calls it.

const { serialized } = require('./ids');

function buildPolicies(config) {
  const policies = new Map();
  // Older configs list moderated groups in groupIds: read and moderate them, keep their text out of the archive.
  for (const id of config.groupIds) {
    if (config.managedGroupIds?.includes(id)) continue;
    policies.set(id, {
      id, label: '', receive: true, send: true, buzzword: '', callers: 'anyone',
      spam: config.deletion.enabled ? 'delete' : 'flag', archive: false, pseudonymise: true, joinRequests: 'off', ai: false, legacy: true
    });
  }
  for (const chat of config.chats) policies.set(chat.id, { ...chat, legacy: false });
  return policies;
}

function chatKind(chat) {
  const server = chat?.id?.server || String(serialized(chat?.id) || '').split('@')[1];
  if (chat?.isChannel || server === 'newsletter') return 'channel';
  if (server === 'broadcast') return 'broadcast';
  if (!chat?.isGroup && (server === 'c.us' || server === 'lid')) return 'direct';
  if (!chat?.isGroup) return 'other';
  const meta = chat.groupMetadata || {};
  if (meta.isParentGroup) return 'community';
  if (meta.defaultSubgroup || meta.isDefaultSubgroup) return 'announcements';
  if (meta.parentGroup) return 'subgroup';
  return 'group';
}

function describeChat(chat) {
  const meta = chat.groupMetadata || {};
  const parent = serialized(meta.parentGroup) || '';
  return {
    id: serialized(chat.id),
    name: String(chat.name || chat.id.user || ''),
    kind: chatKind(chat),
    members: Array.isArray(meta.participants) ? meta.participants.length : (Number.isFinite(meta.size) ? meta.size : ''),
    community: parent,
    lastActive: Number.isFinite(chat.timestamp) ? chat.timestamp : 0
  };
}

const KIND_ORDER = ['group', 'subgroup', 'announcements', 'community', 'direct', 'channel', 'broadcast', 'other'];

function sortChats(rows) {
  return [...rows].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    (a.kind === 'direct' ? b.lastActive - a.lastActive : a.name.localeCompare(b.name)));
}

function terminalText(value) {
  // Do not allow chat names or messages to inject terminal controls.
  return String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

function permissionText(policy) {
  if (!policy) return 'not set up';
  const parts = [policy.receive ? 'receive' : 'no receive', policy.send ? 'send' : 'no send'];
  if (policy.buzzword) parts.push(`buzzword "${policy.buzzword}"${policy.callers === 'me' ? ' (me only)' : ''}`);
  if (policy.spam !== 'off') parts.push(`spam: ${policy.spam}`);
  if (policy.joinRequests === 'screen') parts.push('join screening');
  parts.push(policy.ai === true ? `AI on (${policy.aiPerDay ?? 3} a day)` : 'AI off');
  if (policy.ai === true && policy.keepDays > 0) parts.push(`messages kept ${policy.keepDays} days, then folded into notes`);
  if (policy.ai === true && policy.detect === true) parts.push('spots requests');
  if (policy.assistant === true) parts.push('assistant replies');
  if (policy.githubRepo) parts.push(`GitHub ${policy.githubRepo}${policy.githubMembers ? ' (members too)' : ''}`);
  if (policy.githubAutoIssues === true) parts.push('automatic issue tracking');
  if (policy.googleFiles?.length) {
    parts.push(`Google ${policy.googleFiles.map(file => `${file.name} (${file.kind})`).join(', ')}${policy.googleMembers ? ' (members can read)' : ''}`);
  }
  if (policy.legacy) parts.push('from groupIds');
  return parts.join(', ');
}

function formatChatLine(row, index, policies) {
  const extra = row.kind === 'direct' ? '' : ` ${row.members ? `${row.members} members` : ''}`;
  return `${String(index + 1).padStart(3)}. [${row.kind}] ${terminalText(row.name)}${extra}\n       ID: ${row.id}   ${terminalText(permissionText(policies.get(row.id)))}`;
}

function chatsTsv(rows, policies) {
  const clean = value => String(value).replace(/[\t\r\n]/g, ' ');
  const lines = ['id\tname\tkind\tmembers\tcommunity\treceive\tsend\tbuzzword\tspam'];
  for (const row of rows) {
    const p = policies.get(row.id);
    lines.push([row.id, row.name, row.kind, row.members, row.community, p ? p.receive : '', p ? p.send : '',
      p ? p.buzzword : '', p ? p.spam : ''].map(clean).join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

function normalizeCall(text) {
  return String(text || '').normalize('NFKC').replace(/[​-‍⁠﻿]/g, '').trim();
}

// "!bot ping" with buzzword "!bot" returns "ping"; "!bot" alone returns ""; anything else returns null.
function matchBuzzword(text, buzzword) {
  if (!buzzword) return null;
  const body = normalizeCall(text);
  const word = normalizeCall(buzzword);
  if (body.slice(0, word.length).toLowerCase() !== word.toLowerCase()) return null;
  const rest = body.slice(word.length);
  if (rest && !/^[\s,:.!?]/u.test(rest)) return null; // "!botany" is not a call to "!bot"
  return rest.replace(/^[\s,:.!?]+/u, '').trim();
}

// Exact (case-insensitive) match on label or id, like the reader's group lookup.
function findPolicy(policies, name) {
  const wanted = String(name || '').toLowerCase();
  for (const policy of policies.values()) {
    if (wanted && (policy.id.toLowerCase() === wanted || (policy.label && policy.label.toLowerCase() === wanted))) return policy;
  }
  const known = [...policies.values()].map(p => p.label || p.id).join(', ') || '(none)';
  throw new Error(`"${name}" is not a configured chat. Configured: ${known}`);
}

module.exports = {
  buildPolicies, chatKind, describeChat, sortChats, permissionText, formatChatLine, chatsTsv,
  matchBuzzword, normalizeCall, findPolicy, terminalText
};
