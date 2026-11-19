'use strict';

// Google Docs, Sheets and Slides from a chat: read and edit files the owner shared with a Google service account.
// This is only the low-level client. It signs a short-lived token from the service account key file (read fresh at
// each use), talks to a fixed list of Google hosts, validates every ID, range and text before any request, and never
// shows the private key, the access token or Google's own error text in a message.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const HOSTS = new Set(['oauth2.googleapis.com', 'www.googleapis.com', 'docs.googleapis.com', 'sheets.googleapis.com', 'slides.googleapis.com']);
const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/drive.metadata.readonly'
];
const KINDS = ['doc', 'sheet', 'slides'];
const ID = /^[A-Za-z0-9_-]{20,100}$/;
const OBJECT_ID = /^[A-Za-z0-9_][A-Za-z0-9_:-]{4,49}$/;
const URL_KIND = { document: 'doc', spreadsheets: 'sheet', presentation: 'slides' };
const MIME_KIND = {
  'application/vnd.google-apps.document': 'doc',
  'application/vnd.google-apps.spreadsheet': 'sheet',
  'application/vnd.google-apps.presentation': 'slides'
};
const LIMITS = { find: 500, text: 20000, title: 200, body: 5000, cell: 5000, rowCells: 26, writeRows: 200, rangeLength: 150 };
const MAX_READ_ROWS = 200;
const MAX_READ_COLS = 26;
const MAX_SLIDE_TEXT = 500;
const REFRESH_EARLY_MS = 60 * 1000;

class GoogleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoogleError';
  }
}

// Text from Google or from the chat, as one safe line (no control or direction-changing characters).
function oneLine(text, max = 100) {
  const chars = [...String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g, ' ').replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

// A Google file from a bare ID or a docs.google.com link. kind comes from the link; a bare ID has none.
function parseFileRef(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (ID.test(value)) return { id: value, kind: null };
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.username || url.password) return null;
  const match = /^\/(?:u\/\d{1,2}\/)?(document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{20,100})(?:\/|$)/.exec(url.pathname);
  return match ? { id: match[2], kind: URL_KIND[match[1]] } : null;
}

const COL = '[A-Za-z]{1,3}';
const ROW = '[0-9]{1,7}';
const CELL = `${COL}${ROW}`;
const RANGE_CELLS = new RegExp(`^(?:${CELL}(?::${CELL})?|${COL}:${COL}|${ROW}:${ROW})$`);
const PLAIN_SHEET = /^[\p{L}\p{N} _-]{1,100}$/u;
const QUOTED_SHEET = /^'([^'\u0000-\u001f\u007f-\u009f]{1,100})'$/u;

// An A1 range for Sheets: optional sheet name (plain, or 'quoted'), then A1, A1:C10, A:C or 2:5.
function validRange(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > LIMITS.rangeLength) return false;
  const bang = text.lastIndexOf('!');
  if (bang === -1) return RANGE_CELLS.test(text);
  const sheet = text.slice(0, bang);
  if (!PLAIN_SHEET.test(sheet) && !QUOTED_SHEET.test(sheet)) return false;
  return RANGE_CELLS.test(text.slice(bang + 1));
}

// The text of a Docs document, paragraphs in order. A table cell's text is joined with " | " and each row is a line.
function blocksText(content) {
  let out = '';
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.paragraph) {
      for (const element of block.paragraph.elements || []) out += element?.textRun?.content ?? '';
    } else if (block?.table) {
      for (const row of block.table.tableRows || []) {
        const cells = (row.tableCells || []).map(cell => blocksText(cell.content).trim().replace(/\s*\n\s*/g, ' '));
        out += `${cells.join(' | ')}\n`;
      }
    } else if (block?.tableOfContents) {
      out += blocksText(block.tableOfContents.content);
    }
  }
  return out;
}

function docText(doc) {
  return blocksText(doc?.body?.content);
}

function shapeText(text) {
  let out = '';
  for (const element of text?.textElements || []) out += element?.textRun?.content ?? '';
  return out.trim().replace(/\s*\n\s*/g, ' ');
}

function elementTexts(elements, found) {
  for (const element of Array.isArray(elements) ? elements : []) {
    if (element?.shape?.text) found.push(shapeText(element.shape.text));
    if (element?.table) {
      for (const row of element.table.tableRows || []) for (const cell of row.tableCells || []) found.push(shapeText(cell.text));
    }
    if (element?.elementGroup) elementTexts(element.elementGroup.children, found);
  }
  return found;
}

// All the text on one slide, shapes and table cells, trimmed and joined with " / ", at most 500 characters.
function slideTexts(slide) {
  const joined = elementTexts(slide?.pageElements, []).filter(Boolean).join(' / ');
  const chars = [...joined];
  return chars.length > MAX_SLIDE_TEXT ? `${chars.slice(0, MAX_SLIDE_TEXT - 1).join('')}…` : joined;
}

const KEY_REJECTED = 'Google rejected the service account key: make a new key in Google Cloud and replace the key file.';

function describeStatus(status, email, reason) {
  // Docs and Slides answer a write pinned to an older revision with a 400 that names the revision.
  if (status === 400 && /revision/i.test(reason)) return 'the file changed since it was read; read it again and retry.';
  if (status === 400) return `Google refused it as invalid${reason ? `: ${reason}` : ''}.`;
  if (status === 401) return KEY_REJECTED;
  if (status === 403) return `the service account cannot open it: share the file with ${email} (Editor to change it, Viewer to read it).`;
  if (status === 404) return `it was not found, or it is not shared with ${email}.`;
  if (status === 409 || status === 412) return 'the file changed since it was read; read it again and retry.';
  if (status === 429) return 'Google\'s rate limit is reached; try again later.';
  return `Google answered with error ${status}.`;
}

// A short reason out of Google's error body: one line, no links, never the token or the private key.
function reasonFrom(body, secrets) {
  let reason = typeof body?.error?.message === 'string' ? body.error.message : '';
  for (const secret of secrets) if (secret) reason = reason.split(secret).join(' ');
  // Whatever of the private key Google might echo back, line by line.
  for (const line of String(secrets[1] || '').split(/\r?\n/)) if (line.length >= 16) reason = reason.split(line).join(' ');
  return oneLine(reason.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, ' '), 120);
}

function checkId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new GoogleError(`"${oneLine(id, 40)}" is not a Google file ID.`);
  return id;
}

function checkObjectId(objectId) {
  if (typeof objectId !== 'string' || !OBJECT_ID.test(objectId)) throw new GoogleError(`"${oneLine(objectId, 40)}" is not a slide ID.`);
  return objectId;
}

function checkRange(range) {
  if (!validRange(range)) throw new GoogleError(`"${oneLine(range, 40)}" is not a range like A1:C10 or Sheet1!A1:C10.`);
  return range;
}

function checkText(value, name, min, max) {
  if (typeof value !== 'string') throw new GoogleError(`the ${name} must be text.`);
  const length = [...value].length;
  if (length < min) throw new GoogleError(min === 1 ? `the ${name} is empty.` : `the ${name} is too short.`);
  if (length > max) throw new GoogleError(`the ${name} is too long (at most ${max} characters).`);
  return value;
}

function checkRevision(revisionId) {
  if (revisionId === undefined || revisionId === null || revisionId === '') return undefined;
  if (typeof revisionId !== 'string' || revisionId.length > 200) throw new GoogleError('the revision ID is not valid; read the file again.');
  return revisionId;
}

function checkCell(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') throw new GoogleError('a cell must be text or a number.');
  if ([...value].length > LIMITS.cell) throw new GoogleError(`a cell is too long (at most ${LIMITS.cell} characters).`);
  return value;
}

function checkRow(row) {
  if (!Array.isArray(row) || row.length === 0) throw new GoogleError('a row needs at least one cell.');
  if (row.length > LIMITS.rowCells) throw new GoogleError(`a row has too many cells (at most ${LIMITS.rowCells}).`);
  return row.map(checkCell);
}

function writeControl(revisionId) {
  return revisionId ? { requiredRevisionId: revisionId } : undefined;
}

function randomObjectId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = 'wa';
  for (const byte of crypto.randomBytes(20)) out += alphabet[byte % alphabet.length];
  return out;
}

function createGoogle({
  getKeyFile, readFile = fs.readFileSync, statFile = fs.statSync, fetchFn = globalThis.fetch,
  clock = Date.now, timeoutMs = 15000, platform = process.platform
} = {}) {
  const tokens = new Map(); // client_email -> { fingerprint, token, expiresAt }

  // The key file as it is on disk right now. Never quotes its contents or the full path.
  function loadKey() {
    const file = String((typeof getKeyFile === 'function' ? getKeyFile() : '') || '').trim();
    if (!file) throw new GoogleError('there is no Google service account key yet (see "Google" in COMMANDS.md).');
    const name = path.basename(file);
    let stat;
    try { stat = statFile(file); }
    catch { throw new GoogleError(`the Google service account key file "${name}" was not found.`); }
    if (platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new GoogleError(`the Google service account key file "${name}" can be read by other users: run chmod 600 on it.`);
    }
    let key;
    try { key = JSON.parse(String(readFile(file, 'utf8'))); }
    catch { throw new GoogleError(`the Google service account key file "${name}" could not be read as JSON.`); }
    if (!key || typeof key !== 'object' || key.type !== 'service_account') {
      throw new GoogleError(`"${name}" is not a Google service account key (its type must be service_account).`);
    }
    if (typeof key.client_email !== 'string' || !key.client_email.includes('@')) {
      throw new GoogleError(`the Google service account key "${name}" has no client_email.`);
    }
    if (typeof key.private_key !== 'string' || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key.private_key)) {
      throw new GoogleError(`the Google service account key "${name}" has no private_key.`);
    }
    return {
      email: oneLine(key.client_email, 200), privateKey: key.private_key,
      keyId: typeof key.private_key_id === 'string' ? key.private_key_id : '', name
    };
  }

  async function send(method, url, { headers, body, key, secrets }) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !HOSTS.has(parsed.hostname)) throw new GoogleError('that address is not a Google address.');
    let response;
    try {
      response = await fetchFn(url, {
        method, headers, ...(body !== undefined ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new GoogleError(error?.name === 'TimeoutError' ? 'Google did not answer in time.' : 'could not reach Google (network).');
    }
    if (!response.ok) {
      if (parsed.hostname === 'oauth2.googleapis.com' && (response.status === 400 || response.status === 401)) {
        throw new GoogleError(KEY_REJECTED);
      }
      let reason = '';
      if (response.status === 400 || response.status === 403) {
        try { reason = reasonFrom(await response.json(), secrets); } catch { reason = ''; }
      }
      // A 403 also comes back when the API itself is off in the owner's Google Cloud project: say that, not "share it".
      if (response.status === 403 && /has not been used|is disabled|SERVICE_DISABLED|not been enabled/i.test(reason)) {
        const api = { 'docs.googleapis.com': 'Google Docs API', 'sheets.googleapis.com': 'Google Sheets API',
          'slides.googleapis.com': 'Google Slides API', 'www.googleapis.com': 'Google Drive API' }[parsed.hostname] || 'API';
        throw new GoogleError(`the ${api} is not turned on in the service account's Google Cloud project: turn it on under ` +
          '"APIs & Services", wait a few minutes, and try again.');
      }
      if (response.status === 401) tokens.delete(key.email);
      throw new GoogleError(describeStatus(response.status, key.email, reason));
    }
    try { return await response.json(); }
    catch { throw new GoogleError('Google\'s answer could not be read.'); }
  }

  function signAssertion(key) {
    const iat = Math.floor(clock() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', ...(key.keyId ? { kid: key.keyId } : {}) };
    const claims = { iss: key.email, scope: SCOPES.join(' '), aud: TOKEN_URL, iat, exp: iat + 3600 };
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode(header)}.${encode(claims)}`;
    try {
      const signature = crypto.createSign('RSA-SHA256').update(input).sign(key.privateKey);
      return `${input}.${signature.toString('base64url')}`;
    } catch {
      throw new GoogleError(`the private key in "${key.name}" could not be used to sign in: make a new key in Google Cloud and replace the key file.`);
    }
  }

  async function accessToken(key) {
    const fingerprint = `${key.keyId}\n${crypto.createHash('sha256').update(key.privateKey).digest('hex')}`;
    const cached = tokens.get(key.email);
    if (cached && cached.fingerprint === fingerprint && clock() < cached.expiresAt) return cached.token;
    const assertion = signAssertion(key);
    const data = await send('POST', TOKEN_URL, {
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      key, secrets: [assertion, key.privateKey]
    });
    if (typeof data?.access_token !== 'string' || !data.access_token) throw new GoogleError('Google\'s answer could not be read.');
    const seconds = Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : 3600;
    tokens.set(key.email, { fingerprint, token: data.access_token, expiresAt: clock() + seconds * 1000 - REFRESH_EARLY_MS });
    return data.access_token;
  }

  async function call(method, url, body) {
    const key = loadKey();
    const token = await accessToken(key);
    return send(method, url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      key, secrets: [token, key.privateKey]
    });
  }

  const doc = id => `https://docs.googleapis.com/v1/documents/${checkId(id)}`;
  const sheet = id => `https://sheets.googleapis.com/v4/spreadsheets/${checkId(id)}`;
  const slides = id => `https://slides.googleapis.com/v1/presentations/${checkId(id)}`;
  const values = (id, range) => `${sheet(id)}/values/${encodeURIComponent(checkRange(range))}`;

  const replaceRequest = (find, replace) => ({
    replaceAllText: { containsText: { text: checkText(find, 'text to find', 1, LIMITS.find), matchCase: true }, replaceText: checkText(replace, 'replacement text', 0, LIMITS.text) }
  });
  const changedCount = data => data?.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;

  return {
    async fileInfo(id) {
      const data = await call('GET', `https://www.googleapis.com/drive/v3/files/${checkId(id)}?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`);
      return { id: String(data?.id || id), name: oneLine(data?.name, 100), kind: MIME_KIND[data?.mimeType] || null, url: String(data?.webViewLink || '') };
    },

    async readDoc(id) {
      const data = await call('GET', doc(id));
      return { title: oneLine(data?.title, 200), revisionId: data?.revisionId, text: docText(data) };
    },
    async appendDoc(id, text, { revisionId } = {}) {
      const url = `${doc(id)}:batchUpdate`;
      checkText(text, 'text', 0, LIMITS.text);
      const revision = checkRevision(revisionId);
      const data = await call('POST', url, {
        requests: [{ insertText: { endOfSegmentLocation: {}, text: `\n${text}` } }], writeControl: writeControl(revision)
      });
      return { revisionId: data?.writeControl?.requiredRevisionId ?? null };
    },
    async replaceInDoc(id, find, replace, { revisionId } = {}) {
      const url = `${doc(id)}:batchUpdate`;
      const request = replaceRequest(find, replace);
      const data = await call('POST', url, { requests: [request], writeControl: writeControl(checkRevision(revisionId)) });
      return { changed: changedCount(data) };
    },

    async sheetInfo(id) {
      const data = await call('GET', `${sheet(id)}?fields=properties.title,sheets.properties(title,gridProperties)`);
      return {
        title: oneLine(data?.properties?.title, 200),
        sheets: (data?.sheets || []).map(item => ({
          title: oneLine(item?.properties?.title, 100),
          rows: item?.properties?.gridProperties?.rowCount || 0,
          cols: item?.properties?.gridProperties?.columnCount || 0
        }))
      };
    },
    async readRange(id, range) {
      const data = await call('GET', `${values(id, range)}?valueRenderOption=FORMATTED_VALUE`);
      const rows = (Array.isArray(data?.values) ? data.values : []).slice(0, MAX_READ_ROWS)
        .map(row => (Array.isArray(row) ? row : []).slice(0, MAX_READ_COLS).map(cell => String(cell ?? '')));
      return { range: String(data?.range || range), values: rows };
    },
    async writeRange(id, range, grid) {
      const url = `${values(id, range)}?valueInputOption=RAW`;
      if (!Array.isArray(grid) || grid.length === 0) throw new GoogleError('there is nothing to write.');
      if (grid.length > LIMITS.writeRows) throw new GoogleError(`too many rows to write (at most ${LIMITS.writeRows}).`);
      const rows = grid.map(checkRow);
      const data = await call('PUT', url, { range, values: rows });
      return { updatedCells: data?.updatedCells || 0 };
    },
    async appendRow(id, range, row) {
      const url = `${values(id, range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
      const data = await call('POST', url, { values: [checkRow(row)] });
      return { updatedRange: String(data?.updates?.updatedRange || '') };
    },
    async clearRange(id, range) {
      const data = await call('POST', `${values(id, range)}:clear`, {});
      return { clearedRange: String(data?.clearedRange || range) };
    },

    async readSlides(id) {
      const data = await call('GET', slides(id));
      return {
        title: oneLine(data?.title, 200), revisionId: data?.revisionId,
        slides: (data?.slides || []).map((slide, index) => ({ n: index + 1, objectId: slide.objectId, text: slideTexts(slide) }))
      };
    },
    async addSlide(id, { title, body = '', revisionId } = {}) {
      const url = `${slides(id)}:batchUpdate`;
      checkText(title, 'slide title', 1, LIMITS.title);
      checkText(body, 'slide text', 0, LIMITS.body);
      const revision = checkRevision(revisionId);
      const objectId = randomObjectId(), titleId = randomObjectId(), bodyId = randomObjectId();
      const requests = [
        {
          createSlide: {
            objectId, slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
            placeholderIdMappings: [
              { layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: titleId },
              { layoutPlaceholder: { type: 'BODY', index: 0 }, objectId: bodyId }
            ]
          }
        },
        { insertText: { objectId: titleId, text: title } },
        ...(body ? [{ insertText: { objectId: bodyId, text: body } }] : [])
      ];
      await call('POST', url, { requests, writeControl: writeControl(revision) });
      return { objectId };
    },
    async deleteSlide(id, objectId, { revisionId } = {}) {
      const url = `${slides(id)}:batchUpdate`;
      checkObjectId(objectId);
      await call('POST', url, { requests: [{ deleteObject: { objectId } }], writeControl: writeControl(checkRevision(revisionId)) });
      return {};
    },
    async replaceInSlides(id, find, replace, { revisionId } = {}) {
      const url = `${slides(id)}:batchUpdate`;
      const request = replaceRequest(find, replace);
      const data = await call('POST', url, { requests: [request], writeControl: writeControl(checkRevision(revisionId)) });
      return { changed: changedCount(data) };
    }
  };
}

module.exports = { createGoogle, GoogleError, parseFileRef, validRange, KINDS, SCOPES, docText, slideTexts };
