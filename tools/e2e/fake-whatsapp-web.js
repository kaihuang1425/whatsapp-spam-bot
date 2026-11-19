'use strict';
// Fake whatsapp-web.js for an end-to-end run of src/bot.js without a phone or browser.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');

const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO, 'utf8'));
const log = (...args) => console.log('FAKE', ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let counter = 0;
const removed = new Set();
const pendingRequests = new Set(scenario.requests || []);
const announce = new Map(); // group id -> only admins can send

class LocalAuth { constructor(options) { this.options = options; } }

class Client extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.info = { wid: { _serialized: 'me@c.us' } };
    this.pupPage = { evaluate: async () => scenario.revoke };
  }
  async initialize() {
    setTimeout(() => {
      this.emit('authenticated');
      if (scenario.neverReady) {
        // WhatsApp Web stuck after the login, as seen on the server. The bot must give up by itself; if it doesn't,
        // a disconnect after 25 s ends the run with a pause, which the scenario's checks reject.
        this.emit('loading_screen', 30, 'WhatsApp'); this.emit('loading_screen', 55, 'WhatsApp');
        setTimeout(() => this.emit('disconnected', 'FAKE_NEVER_READY'), 25000);
        return;
      }
      this.emit('ready');
      if (scenario.readyTwice) setTimeout(() => this.emit('ready'), 200);
      // A WhatsApp Web page reload while running: the library injects again and repeats both events.
      if (scenario.reloadAfterReady) setTimeout(() => { this.emit('authenticated'); this.emit('ready'); }, 1000);
      setTimeout(() => void this.run(), 400);
    }, 50);
  }
  async getChats() { return scenario.chats; }
  async getChatById(id) {
    // Every sender in the scenario is a non-admin member (except scenario.notMember and anyone removed);
    // this account is an admin unless scenario.meAdmin is false.
    const members = [...new Set(scenario.messages.map(m => m.author).filter(Boolean))]
      .filter(author => author !== scenario.notMember && !removed.has(author));
    const participants = [{ id: { _serialized: 'me@c.us' }, isAdmin: scenario.meAdmin !== false },
      ...members.map(author => ({ id: { _serialized: author }, isAdmin: false }))];
    return {
      ...(scenario.chats.find(chat => chat.id._serialized === id) || {}),
      isGroup: id.endsWith('@g.us'), id: { _serialized: id }, participants, groupMetadata: { announce: Boolean(announce.get(id)) },
      removeParticipants: async ids => {
        log('KICK', id, ids.join(','));
        ids.forEach(member => removed.add(member));
        setTimeout(() => this.emit('group_leave', { chatId: id, recipientIds: ids }), 20);
        return { status: 200 };
      },
      setMessagesAdminsOnly: async locked => { log(locked ? 'LOCK' : 'UNLOCK', id); announce.set(id, locked); return true; }
    };
  }
  async getContactLidAndPhone(ids) { return ids.map(id => (scenario.lidMap || {})[id] || {}); }
  async getContactById(id) { return { isMyContact: (scenario.contacts || []).includes(id) }; }
  async getGroupMembershipRequests() { return [...pendingRequests].map(id => ({ id: { _serialized: id } })); }
  async approveGroupMembershipRequests(groupId, { requesterIds }) {
    requesterIds.forEach(id => { pendingRequests.delete(id); log('APPROVE', groupId, id); });
    return requesterIds.map(requesterId => ({ requesterId, message: 'Approved successfully' }));
  }
  async rejectGroupMembershipRequests(groupId, { requesterIds }) {
    requesterIds.forEach(id => { pendingRequests.delete(id); log('REJECT', groupId, id); });
    return requesterIds.map(requesterId => ({ requesterId, message: 'Rejected successfully' }));
  }
  async sendMessage(chatId, text) {
    log('SENDMESSAGE', chatId, JSON.stringify(text));
    const id = { _serialized: `true_${chatId}_s${counter++}` };
    setTimeout(() => this.emit('message_create', this.message({ chat: chatId, fromMe: true, body: text }, id)), 20);
    return { id };
  }
  async destroy() { log('DESTROY'); }
  message(spec, forcedId) {
    const short = `${scenario.runId || ""}M${counter++}`;
    const id = forcedId || { _serialized: `${Boolean(spec.fromMe)}_${spec.chat}_${short}`, id: short };
    const msg = {
      id, from: spec.fromMe ? 'me@c.us' : spec.chat, to: spec.fromMe ? spec.chat : 'me@c.us',
      author: spec.chat.endsWith('@g.us') && !spec.fromMe ? (spec.author || 'friend@lid') : undefined,
      fromMe: Boolean(spec.fromMe), body: spec.body, type: spec.type || 'chat', timestamp: spec.ts ?? Math.floor(Date.now() / 1000),
      _data: { notifyName: spec.name || 'Friend' },
      reply: async text => {
        log('REPLY', spec.chat, JSON.stringify(text));
        const replyId = { _serialized: `true_${spec.chat}_r${counter++}` };
        // Real WhatsApp echoes your own sent messages back through message_create.
        setTimeout(() => this.emit('message_create', this.message({ chat: spec.chat, fromMe: true, body: text }, replyId)), 20);
        return { id: replyId };
      },
      delete: async (everyone, clearMedia) => {
        log('DELETE', spec.chat, `everyone=${everyone}`, `clearMedia=${clearMedia}`);
        if (!everyone) setTimeout(() => this.emit('message_revoke_me', { id }), 20);
      }
    };
    msg.getChat = () => this.getChatById(spec.chat);
    return msg;
  }
  async run() {
    const emitted = [];
    for (const spec of scenario.messages) {
      if (spec.joinRequest) {
        // Someone asks to join a group with approval turned on.
        pendingRequests.add(spec.joinRequest);
        emitted.push(null);
        this.emit('group_membership_request', { chatId: spec.chat, author: spec.joinRequest });
      } else {
        const msg = this.message(spec);
        // "quote": index of an earlier scenario message this one replies to.
        if (Number.isInteger(spec.quote)) {
          msg.hasQuotedMsg = true;
          msg.getQuotedMessage = async () => emitted[spec.quote];
        }
        emitted.push(msg);
        this.emit('message_create', msg);
      }
      await sleep(Number(process.env.FAKE_GAP_MS || 3200));
    }
    await sleep(800);
    process.emit('SIGINT');
  }
}

module.exports = { Client, LocalAuth };
