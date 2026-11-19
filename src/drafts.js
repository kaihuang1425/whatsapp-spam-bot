'use strict';

// AI drafts ("<buzzword> draft <target> <request>"): what the AI may propose for each kind of target, and the checks
// its JSON answer must pass before it becomes a change waiting for the owner's confirm code. The AI only proposes;
// the bot's own code reads the target, builds the preview and makes the change.

const { validRange } = require('./google');

// Shown to the AI, one action per line.
const ACTIONS = {
  doc: [
    '{"action": "append", "text": "<text to add at the end of the document>"}',
    '{"action": "replace", "find": "<text exactly as it is now in the document>", "replace": "<the new text>"}'
  ],
  sheet: [
    '{"action": "add_row", "cells": ["<cell>", "<cell>"]}  (a new row at the end of the first tab)',
    '{"action": "set", "start": "<top-left cell, e.g. B2>", "rows": [["<cell>", "<cell>"], ["<cell>", "<cell>"]]}'
  ],
  slides: [
    '{"action": "add_slide", "title": "<slide title>", "body": "<slide text, lines separated by \\n>"}',
    '{"action": "replace", "find": "<text exactly as it is now on the slides>", "replace": "<the new text>"}'
  ],
  issue: [
    '{"action": "comment", "text": "<a new comment>"}',
    '{"action": "body", "text": "<the whole new description>"}',
    '{"action": "title", "text": "<the new title>"}'
  ],
  file: [
    '{"action": "write", "content": "<the whole new file>"}'
  ]
};

const LIMITS = { text: 20000, find: 500, title: 256, cell: 5000, cells: 26, rows: 200, file: 200000 };

const isText = (value, min, max) => typeof value === 'string' && [...value].length >= min && [...value].length <= max;

// The AI's answer as one JSON object, or an error the owner can read.
function parseDraft(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return { error: 'the AI did not answer with a draft (no JSON object).' };
  let value;
  try { value = JSON.parse(raw.slice(start, end + 1)); } catch { return { error: 'the AI\'s draft is not valid JSON.' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.action !== 'string') {
    return { error: 'the AI\'s draft has no action.' };
  }
  return { draft: value };
}

// null when the draft is usable for this kind of target, else what is wrong with it.
function checkDraft(kind, draft) {
  const { action } = draft;
  if (action === 'none') return null;
  const grid = rows => Array.isArray(rows) && rows.length >= 1 && rows.length <= LIMITS.rows &&
    rows.every(row => Array.isArray(row) && row.length >= 1 && row.length <= LIMITS.cells && row.every(cell => isText(cell, 0, LIMITS.cell)));
  const ok = {
    doc: {
      append: () => isText(draft.text, 1, LIMITS.text),
      replace: () => isText(draft.find, 1, LIMITS.find) && isText(draft.replace, 0, LIMITS.text)
    },
    sheet: {
      add_row: () => grid([draft.cells]),
      set: () => typeof draft.start === 'string' && validRange(draft.start) && !draft.start.includes(':') && grid(draft.rows)
    },
    slides: {
      add_slide: () => isText(draft.title, 1, 200) && (draft.body === undefined || isText(draft.body, 0, 5000)),
      replace: () => isText(draft.find, 1, LIMITS.find) && isText(draft.replace, 0, LIMITS.text)
    },
    issue: {
      comment: () => isText(draft.text, 1, LIMITS.text),
      body: () => isText(draft.text, 0, LIMITS.text),
      title: () => isText(draft.text, 1, LIMITS.title) && !/[\r\n]/.test(draft.text)
    },
    file: {
      write: () => typeof draft.content === 'string' && draft.content.length > 0 && Buffer.byteLength(draft.content) <= LIMITS.file
    }
  }[kind] || {};
  if (!ok[action]) return `the AI proposed "${String(action).slice(0, 30)}", which is not one of the changes allowed here.`;
  return ok[action]() ? null : `the AI's "${action}" draft is missing something or is too long.`;
}

module.exports = { ACTIONS, parseDraft, checkDraft };
