'use strict';

// Google Docs, Sheets and Slides from a chat. A chat reaches only the files linked to it (chats[].googleFiles, set with
// the console's "google" command), each by a short name, and only through the owner's service account, which sees only
// the files shared with it.
// - Reading: the owner, and members where the owner set googleMembers (members' reads google.cooldownSeconds apart).
//   Text from the files shows links and long numbers as [link] and [number], as for GitHub: anyone who can edit a
//   file could otherwise have the bot post a phishing link from the owner's account.
// - Changing: the owner only. Adding (text at the end of a doc, a row at the end of a sheet, a slide at the end) happens
//   at once. Replacing, overwriting cells, clearing and deleting wait for "<buzzword> confirm <code>" (pending.js), and
//   the preview shows what is there now. Docs and slides are changed only at the revision the preview read.
// - AI drafts (applyDraft) always wait for the code, must fit in full in the preview, and are refused if the file
//   changed while the AI was drafting.
// - One Google request per chat at a time; at most google.maxWritesPerHour changes an hour from all chats, each
//   logged as "[GOOGLE] chat: what" (never the text).

const path = require('node:path');
const { GoogleError, validRange } = require('./google');
const { STRIP } = require('./instructions');
const { stripLinksAndNumbers } = require('./items');
const { typedAfter, phrase } = require('./github-changes');

const KIND_NAME = { doc: 'Google Doc', sheet: 'Google Sheet', slides: 'Google Slides' };
const COMMAND_KIND = { doc: 'doc', docs: 'doc', sheet: 'sheet', sheets: 'sheet', slides: 'slides', slide: 'slides' };
const LINK = { doc: 'document', sheet: 'spreadsheets', slides: 'presentation' };
// An AI draft is offered only if the preview can show all of it.
const DRAFT_TEXT = { maxChars: 1500, maxLines: 30 };
const DRAFT_CELLS = { rows: 10, cellChars: 100 };
const PREVIEW_CUT = '(cut short in this preview)';
const fits = (text, { maxChars, maxLines }) => [...String(text)].length <= maxChars && String(text).split('\n').length <= maxLines;

// GOOGLE_SERVICE_ACCOUNT_FILE from the .env file, read at each use (a path relative to the bot's folder, or absolute);
// else the environment. '' when there is none.
function keyFileFrom(envFile, root, env = process.env, fsApi = require('node:fs')) {
  let value = '';
  try { value = require('node:util').parseEnv(fsApi.readFileSync(envFile, 'utf8')).GOOGLE_SERVICE_ACCOUNT_FILE || ''; }
  catch { /* no .env, or unreadable: fall back to the environment */ }
  value = String(value || env.GOOGLE_SERVICE_ACCOUNT_FILE || '').trim();
  return value ? path.resolve(root, value) : '';
}

// Text as the chat sees it: line breaks kept, control and invisible characters taken out, links and long numbers as
// [link] and [number], cut short with a note.
function block(text, { maxChars = 2500, maxLines = 50, more = '(cut short; open the file for the rest)' } = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
    .map(line => stripLinksAndNumbers(line.replace(STRIP, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g, ' ').replace(/[ \t]+$/, '')));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  let out = lines.slice(0, maxLines).join('\n');
  const cut = lines.length > maxLines || [...out].length > maxChars;
  if ([...out].length > maxChars) out = [...out].slice(0, maxChars - 1).join('');
  return cut ? `${out}…\n${more}` : out;
}
const line = (text, max) => block(text, { maxChars: max, maxLines: 1 }).replace(/\n[\s\S]*$/, '');

// Spreadsheet cell addresses: "B2" -> { col: 2, row: 2 }, and back.
function parseCell(text) {
  const found = /^([A-Za-z]{1,3})([0-9]{1,7})$/.exec(text);
  if (!found) return null;
  const col = [...found[1].toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  return { col, row: Number(found[2]) };
}
function columnName(col) {
  let name = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
// "Tab!B2" with a 2x3 grid -> "Tab!B2:D3"; a full range stays as given.
function rangeFor(start, rows, cols) {
  const bang = start.lastIndexOf('!');
  const sheet = bang >= 0 ? start.slice(0, bang + 1) : '';
  const cell = parseCell(start.slice(bang + 1));
  if (!cell) return start;
  return `${sheet}${columnName(cell.col)}${cell.row}:${columnName(cell.col + cols - 1)}${cell.row + rows - 1}`;
}
// The first row number of a range, for labelling rows ("A5:C9" -> 5; "A:C" -> 1).
function firstRow(range) {
  const found = /([0-9]+)/.exec(range.slice(range.lastIndexOf('!') + 1));
  return found ? Number(found[1]) : 1;
}
function gridText(values, start, { maxRows = 30 } = {}) {
  if (!values.length) return '(empty)';
  const rows = values.slice(0, maxRows).map((row, i) => `${start + i}: ${row.map(cell => line(cell, 120)).join(' | ')}`);
  return rows.join('\n') + (values.length > maxRows ? `\n...and ${values.length - maxRows} more rows` : '');
}
// "a | b" lines -> [["a", "b"]]: cells split on "|", rows on new lines.
function parseGrid(text) {
  return String(text).split('\n').map(row => row.trim()).filter(Boolean).map(row => row.split('|').map(cell => cell.trim()));
}
function count(text, find) {
  return find ? String(text).split(find).length - 1 : 0;
}

function createGoogleCommands({ getConfig, google, pending, clock = Date.now, log = console.log }) {
  const busy = new Set();
  const lastRead = new Map();
  let writes = [];

  // One Google request per chat at a time. Members' requests also wait google.cooldownSeconds after the last one;
  // the owner's never wait. Google's refusals come back as a reply.
  async function oneCall(policy, call, fromMe = true) {
    if (busy.has(policy.id)) return 'A Google request for this chat is still running; try again in a moment.';
    const wait = getConfig().google.cooldownSeconds * 1000 - (clock() - (lastRead.get(policy.id) ?? -Infinity));
    if (!fromMe && wait > 0) return `Please wait ${Math.ceil(wait / 1000)}s between Google commands in this chat.`;
    busy.add(policy.id);
    lastRead.set(policy.id, clock());
    try { return await call(); } catch (error) {
      if (!(error instanceof GoogleError)) throw error;
      return `Google: ${error.message}`;
    } finally { busy.delete(policy.id); }
  }
  function writeLimit() {
    const max = getConfig().google.maxWritesPerHour;
    writes = writes.filter(time => time > clock() - 3600000);
    return writes.length >= max ? `Google: at most ${max} changes an hour can be made from chats; try again later.` : null;
  }
  function change(policy, run) {
    return oneCall(policy, async () => {
      const full = writeLimit();
      if (full) return full;
      writes.push(clock());
      return run();
    });
  }
  // Why a confirmed change could not start right now (the code then stays valid), or null.
  const blocked = policy => (busy.has(policy.id) ? 'A Google request for this chat is still running; try again in a moment.' : writeLimit());
  function ask(policy, preview, run) {
    const code = pending.add(policy.id, { what: preview.split('\n')[0], run: () => change(policy, run), blocked: () => blocked(policy) });
    const minutes = Math.round(pending.ttlMs / 60000);
    return `${preview}\nTo do it, send ${policy.buzzword} confirm ${code} within ${minutes} minutes (or ${policy.buzzword} cancel ${code}).`;
  }
  const done = (policy, file, what) => log(`[GOOGLE] ${policy.label || policy.id}: ${what} in ${file.name}`);
  const link = file => `\nhttps://docs.google.com/${LINK[file.kind]}/d/${file.id}/edit`;
  const noRevision = file => `Google did not say which version of ${file.name} it read, so it is not changed from the chat; change it in Google.`;

  function list(policy) {
    const files = policy.googleFiles || [];
    const word = policy.buzzword;
    if (!files.length) {
      return `No Google files are linked to this chat. The owner links one on the server: node src/cli.js google "${policy.label || policy.id}" --add <link> --name <short name>`;
    }
    return ['Google files for this chat:', ...files.map(file => `${file.name} - ${KIND_NAME[file.kind]}`),
      `Read one with ${word} doc <name>, ${word} sheet <name> [range] or ${word} slides <name>.`].join('\n');
  }

  // An addition happens at once when the owner typed it; one the AI drafted waits for the code like everything else.
  // draft: the preview's opening words for an AI draft, '' for the owner's own command.
  function addition(policy, draft, preview, run) {
    return draft ? ask(policy, `${draft}${preview}`, run) : change(policy, run);
  }
  // How much of a text a preview shows: all of an AI draft (it was checked to fit), the start of anything else.
  const view = (draft, small) => (draft ? { maxChars: DRAFT_TEXT.maxChars + 500, maxLines: DRAFT_TEXT.maxLines + 1, more: PREVIEW_CUT }
    : { ...small, more: PREVIEW_CUT });

  // ---- docs ----
  // opts for an AI draft: { draft, pair: [find, replacement], revisionId: the version the AI saw }.
  async function doc(policy, file, verb, text, { draft = '', pair = null, revisionId = null } = {}, fromMe = true) {
    const word = policy.buzzword;
    if (!verb) {
      return oneCall(policy, async () => {
        const { title, text: body } = await google.readDoc(file.id);
        return `${line(title, 120)} (${file.name}):\n${block(body) || '(empty)'}${link(file)}`;
      }, fromMe);
    }
    if (verb === 'append') {
      if (!text) return `Usage: ${word} doc ${file.name} append <text> (it goes at the end of the document)`;
      return addition(policy, draft, `Add this at the end of ${file.name}?\n${block(text, view(draft, { maxChars: 1200, maxLines: 25 }))}`, async () => {
        await google.appendDoc(file.id, text);
        done(policy, file, 'added text at the end');
        return `Added ${[...text].length} characters at the end of ${file.name}.${link(file)}`;
      });
    }
    if (verb === 'replace') {
      const [find, replacement] = pair || splitReplace(text);
      if (!find) return `Usage: ${word} doc ${file.name} replace <old text> => <new text>`;
      return oneCall(policy, async () => {
        const current = await google.readDoc(file.id);
        if (!current.revisionId) return noRevision(file);
        if (draft && revisionId && current.revisionId !== revisionId) return `${file.name} changed while the AI was drafting; ask again.`;
        const found = count(current.text, find);
        if (!found) return `"${line(find, 80)}" is not in ${file.name} (it must match exactly, capitals too).`;
        return ask(policy, `${draft}Replace "${block(find, view(draft, { maxChars: 200, maxLines: 3 }))}" with ` +
          `"${block(replacement, view(draft, { maxChars: 200, maxLines: 3 }))}" everywhere in ${file.name}? It is in ${found === 1 ? 'one place' : `${found} places`} ` +
          'of the main text; other tabs, headers and footers change too if they have it. Only if nobody changes the document first.', async () => {
          const { changed } = await google.replaceInDoc(file.id, find, replacement, { revisionId: current.revisionId });
          done(policy, file, 'replaced text');
          return `Replaced ${changed} ${changed === 1 ? 'place' : 'places'} in ${file.name}.${link(file)}`;
        });
      });
    }
    return null;
  }

  // ---- sheets ----
  // A range may name a tab with spaces ('Tab 2'!B5:C9), so it is the rest of the words, not one word.
  // opts for an AI draft: { draft, row } (add) or { draft, start, rows } (set).
  async function sheet(policy, file, verb, args, text, { draft = '', row: draftRow = null, start: draftStart = null, rows = null } = {}, fromMe = true) {
    const word = policy.buzzword;
    if (!verb || !['add', 'set', 'clear'].includes(verb)) {
      const range = args.join(' ') || 'A1:J20';
      if (!validRange(range)) return null;
      return oneCall(policy, async () => {
        const read = await google.readRange(file.id, range);
        return `${file.name}, ${line(read.range || range, 80)}:\n${gridText(read.values, firstRow(read.range || range))}${link(file)}`;
      }, fromMe);
    }
    if (verb === 'add') {
      const [row] = draftRow ? [draftRow] : parseGrid(text);
      if (!row || (!draftRow && parseGrid(text).length !== 1)) return `Usage: ${word} sheet ${file.name} add <cell> | <cell> | ... (one new row at the end of the first tab)`;
      return addition(policy, draft, `Add a row at the end of ${file.name}?\n${block(row.join(' | '), view(draft, { maxChars: 600, maxLines: 3 }))}`, async () => {
        await google.appendRow(file.id, 'A1', row);
        done(policy, file, 'added a row');
        return `Added a row to ${file.name}: ${line(row.join(' | '), 300)}${link(file)}`;
      });
    }
    if (verb === 'set') {
      // text: "B2 Done", "'Tab 2'!B2 Done", or "A5" with the rows on the next lines.
      const found = /^('[^'\n]{1,100}'!\S+|\S+)(?:[ \t]*\n|[ \t]+|$)([\s\S]*)$/.exec(text) || ['', '', ''];
      const start = draftStart ?? found[1];
      const grid = rows ?? parseGrid(found[2]);
      if (!validRange(start) || !grid.length) {
        return `Usage: ${word} sheet ${file.name} set B2 Done, or ${word} sheet ${file.name} set A5 then rows on the next lines, cells split by |`;
      }
      const width = Math.max(...grid.map(cells => cells.length));
      const range = rangeFor(start, grid.length, width);
      const filled = grid.map(cells => [...cells, ...Array(width - cells.length).fill('')]);
      return oneCall(policy, async () => {
        const now = await google.readRange(file.id, range);
        return ask(policy, `${draft}Write ${grid.length * width === 1 ? 'one cell' : `${grid.length} ${grid.length === 1 ? 'row' : 'rows'} × ${width} cells`} in ${file.name}, ` +
          `${line(range, 80)}?\nnow:\n${gridText(now.values, firstRow(range), { maxRows: 10 })}\nnew:\n` +
          `${gridText(filled, firstRow(range), { maxRows: 10 })}`, async () => {
          await google.writeRange(file.id, range, filled);
          done(policy, file, `wrote ${range}`);
          return `Wrote ${line(range, 80)} in ${file.name}.${link(file)}`;
        });
      });
    }
    if (verb === 'clear') {
      const range = text.trim();
      if (!validRange(range)) return `Usage: ${word} sheet ${file.name} clear <range>, e.g. B2:D9`;
      return oneCall(policy, async () => {
        const now = await google.readRange(file.id, range);
        const cells = now.values.reduce((sum, cellRow) => sum + cellRow.filter(cell => String(cell).trim()).length, 0);
        // The read stops at 200 rows and 26 columns, so a bigger range may hold more.
        const capped = now.values.length >= 200 || now.values.some(cellRow => cellRow.length >= 26);
        if (!cells && !capped) return `${line(range, 80)} in ${file.name} is already empty.`;
        return ask(policy, `Clear ${capped ? 'at least ' : ''}${cells} ${cells === 1 ? 'cell' : 'cells'} in ${file.name}, ${line(range, 80)}?\n` +
          `${gridText(now.values, firstRow(range), { maxRows: 10 })}`, async () => {
          await google.clearRange(file.id, range);
          done(policy, file, `cleared ${range}`);
          return `Cleared ${line(range, 80)} in ${file.name}.${link(file)}`;
        });
      });
    }
    return null;
  }

  // ---- slides ----
  // opts for an AI draft: { draft, title, body } (add) or { draft, pair: [find, replacement] } (replace), and
  // revisionId: the version the AI saw.
  async function slides(policy, file, verb, args, text, { draft = '', title: draftTitle = null, body: draftBody = '', pair = null, revisionId = null } = {},
    fromMe = true) {
    const word = policy.buzzword;
    if (!verb) {
      return oneCall(policy, async () => {
        const deck = await google.readSlides(file.id);
        const lines = deck.slides.slice(0, 40).map(slide => `${slide.n}. ${line(slide.text, 150) || '(no text)'}`);
        return `${line(deck.title, 120)} (${file.name}, ${deck.slides.length} slides):\n` +
          `${lines.join('\n') || '(no slides)'}${deck.slides.length > 40 ? '\n...' : ''}${link(file)}`;
      }, fromMe);
    }
    if (verb === 'add') {
      const [first, ...more] = text.split('\n');
      const bar = first.indexOf('|');
      const title = draftTitle ?? (bar >= 0 ? first.slice(0, bar) : first).trim();
      const body = draftTitle !== null ? draftBody : [bar >= 0 ? first.slice(bar + 1).trim() : '', ...more].join('\n').trim();
      if (!title) return `Usage: ${word} slides ${file.name} add <title> | <text>, or the title then the text on the next lines`;
      return addition(policy, draft, `Add a slide at the end of ${file.name}?\n${block(title, view(draft, { maxChars: 200, maxLines: 2 }))}\n` +
        `${block(body, view(draft, { maxChars: 800, maxLines: 15 }))}`, async () => {
        await google.addSlide(file.id, { title, body });
        done(policy, file, 'added a slide');
        return `Added a slide "${line(title, 80)}" at the end of ${file.name}.${link(file)}`;
      });
    }
    if (verb === 'delete') {
      const n = Number(args[1]);
      if (args.length !== 2 || !Number.isSafeInteger(n) || n < 1) return `Usage: ${word} slides ${file.name} delete N, with N from ${word} slides ${file.name}`;
      return oneCall(policy, async () => {
        const deck = await google.readSlides(file.id);
        if (!deck.revisionId) return noRevision(file);
        const slide = deck.slides.find(x => x.n === n);
        if (!slide) return `${file.name} has ${deck.slides.length} slides; there is no slide ${n}.`;
        return ask(policy, `Delete slide ${n} of ${file.name}: "${line(slide.text, 150) || '(no text)'}"? ` +
          'Only if nobody changes the presentation first.', async () => {
          await google.deleteSlide(file.id, slide.objectId, { revisionId: deck.revisionId });
          done(policy, file, `deleted slide ${n}`);
          return `Deleted slide ${n} of ${file.name}.${link(file)}`;
        });
      });
    }
    if (verb === 'replace') {
      const [find, replacement] = pair || splitReplace(text);
      if (!find) return `Usage: ${word} slides ${file.name} replace <old text> => <new text>`;
      return oneCall(policy, async () => {
        const deck = await google.readSlides(file.id);
        if (!deck.revisionId) return noRevision(file);
        if (draft && revisionId && deck.revisionId !== revisionId) return `${file.name} changed while the AI was drafting; ask again.`;
        const found = deck.slides.reduce((sum, slide) => sum + count(slide.text, find), 0);
        if (!found) return `"${line(find, 80)}" is not on any slide of ${file.name} (it must match exactly, capitals too).`;
        return ask(policy, `${draft}Replace "${block(find, view(draft, { maxChars: 200, maxLines: 3 }))}" with ` +
          `"${block(replacement, view(draft, { maxChars: 200, maxLines: 3 }))}" everywhere in ${file.name} (about ${found} ${found === 1 ? 'place' : 'places'})? ` +
          'Only if nobody changes the presentation first.', async () => {
          const { changed } = await google.replaceInSlides(file.id, find, replacement, { revisionId: deck.revisionId });
          done(policy, file, 'replaced text');
          return `Replaced ${changed} ${changed === 1 ? 'place' : 'places'} in ${file.name}.${link(file)}`;
        });
      });
    }
    return null;
  }

  function splitReplace(text) {
    const at = text.indexOf('=>');
    if (at < 0) return ['', ''];
    return [text.slice(0, at).trim(), text.slice(at + 2).trim()];
  }

  // command: the word after the buzzword ("doc", "sheet", "slides", "google", ...); args: the words after it; rest: the
  // router's text after the buzzword. Returns the reply.
  async function run(policy, { command, args, rest, fromMe, message }) {
    const word = policy.buzzword;
    if (!fromMe && policy.googleMembers !== true) return 'Only the owner of this bot can use Google files from this chat.';
    if (command === 'google' || command === 'gdocs') return list(policy);
    const kind = COMMAND_KIND[command];
    const name = (args[0] || '').toLowerCase();
    const file = (policy.googleFiles || []).find(x => x.name === name);
    if (!name || !file) return name ? `No ${KIND_NAME[kind]} called "${line(name, 30)}" is linked here.\n${list(policy)}` : list(policy);
    if (file.kind !== kind) return `${file.name} is a ${KIND_NAME[file.kind]}: use ${word} ${file.kind} ${file.name}`;
    const verb = (args[1] || '').toLowerCase();
    const changing = { doc: ['append', 'replace'], sheet: ['add', 'set', 'clear'], slides: ['add', 'delete', 'replace'] }[kind];
    if (changing.includes(verb) && !fromMe) return 'Only the owner of this bot can change Google files from the chat.';
    const text = changing.includes(verb) ? typedAfter(message, rest, phrase(args[0], args[1])) : '';
    const action = args.length > 1 ? verb : '';
    const result = kind === 'doc' ? await doc(policy, file, action, text, {}, fromMe)
      : kind === 'sheet' ? await sheet(policy, file, action, args.slice(1), text, {}, fromMe)
        : await slides(policy, file, action, args.slice(1), text, {}, fromMe);
    return result ?? usage(policy, file);
  }

  function usage(policy, file) {
    const word = policy.buzzword;
    const lines = {
      doc: [`${word} doc ${file.name} - read it`, `${word} doc ${file.name} append <text> - add at the end (owner)`,
        `${word} doc ${file.name} replace <old> => <new> - replace text everywhere (owner, with a confirm code)`],
      sheet: [`${word} sheet ${file.name} [range] - read it (A1:J20 of the first tab unless you give a range, e.g. Tab!A1:D30)`,
        `${word} sheet ${file.name} add <cell> | <cell> - a new row at the end (owner)`,
        `${word} sheet ${file.name} set <cell> <value>, or set <cell> then rows on the next lines - write cells (owner, confirm code)`,
        `${word} sheet ${file.name} clear <range> - empty cells (owner, confirm code)`],
      slides: [`${word} slides ${file.name} - list the slides`, `${word} slides ${file.name} add <title> | <text> - a new slide at the end (owner)`,
        `${word} slides ${file.name} delete N - remove slide N (owner, confirm code)`,
        `${word} slides ${file.name} replace <old> => <new> - replace text on every slide (owner, confirm code)`]
    }[file.kind];
    return [`${file.name} (${KIND_NAME[file.kind]}):`, ...lines].join('\n');
  }

  // ---- AI drafts ----

  // A linked file for "draft": { file } or { text } when it is not linked here.
  function findFile(policy, kind, name) {
    const file = (policy.googleFiles || []).find(x => x.name === String(name).toLowerCase());
    if (!file) return { text: `No ${KIND_NAME[kind]} called "${line(name, 30)}" is linked here.\n${list(policy)}` };
    if (file.kind !== kind) return { text: `${file.name} is a ${KIND_NAME[file.kind]}: draft ${file.kind} ${file.name} ...` };
    return { file };
  }

  // What the AI gets to see of the file: { target, content, seen }, where seen is the version the draft is based on.
  // Throws GoogleError.
  async function source(file) {
    if (file.kind === 'doc') {
      const { title, text, revisionId } = await google.readDoc(file.id);
      return { target: `the Google Doc "${line(title, 120)}"`, content: [...text].slice(0, 15000).join(''), seen: { revisionId } };
    }
    if (file.kind === 'sheet') {
      const { values } = await google.readRange(file.id, 'A1:Z200');
      return { target: `the Google Sheet ${file.name} (its first tab, A1:Z200)`,
        content: values.map((cells, i) => `row ${i + 1}: ${cells.join(' | ')}`).join('\n'), seen: {} };
    }
    const deck = await google.readSlides(file.id);
    return { target: `the Google Slides presentation "${line(deck.title, 120)}"`,
      content: deck.slides.map(slide => `slide ${slide.n}: ${slide.text}`).join('\n'), seen: { revisionId: deck.revisionId } };
  }

  // A checked draft (drafts.js) as a change waiting for the code. clean: takes out links the AI added (onlyKnownLinks);
  // seen: the version source() read. A draft the preview cannot show in full is refused.
  async function applyDraft(policy, file, draft, clean, seen = {}) {
    const draftNote = 'Drafted by the AI. ';
    const tooLong = 'The AI\'s draft is too long to show here in full; ask for a shorter one.';
    const texts = file.kind === 'sheet' ? [] : draft.action === 'append' ? [draft.text]
      : draft.action === 'add_slide' ? [draft.title, draft.body || ''] : [draft.find, draft.replace];
    if (texts.some(text => !fits(text, DRAFT_TEXT))) return tooLong;
    if (file.kind === 'doc' && draft.action === 'append') return doc(policy, file, 'append', clean(draft.text), { draft: draftNote });
    if (file.kind === 'doc') return doc(policy, file, 'replace', '', { draft: draftNote, pair: [draft.find, clean(draft.replace)], revisionId: seen.revisionId });
    if (file.kind === 'sheet') {
      const grid = draft.action === 'add_row' ? [draft.cells] : draft.rows;
      if (grid.length > DRAFT_CELLS.rows || grid.some(cells => cells.some(cell => [...cell].length > DRAFT_CELLS.cellChars || /\n/.test(cell)))) {
        return `The AI's draft has more than ${DRAFT_CELLS.rows} rows, or cells longer than ${DRAFT_CELLS.cellChars} characters, so it cannot be shown here in full; ask for a smaller change.`;
      }
      if (draft.action === 'add_row') return sheet(policy, file, 'add', [], '', { draft: draftNote, row: draft.cells.map(clean) });
      return sheet(policy, file, 'set', [], '', { draft: draftNote, start: draft.start, rows: draft.rows.map(cells => cells.map(clean)) });
    }
    if (draft.action === 'add_slide') {
      return slides(policy, file, 'add', [], '', { draft: draftNote, title: clean(draft.title).trim(), body: clean(draft.body || '') });
    }
    return slides(policy, file, 'replace', [], '', { draft: draftNote, pair: [draft.find, clean(draft.replace)], revisionId: seen.revisionId });
  }

  return { run, list, findFile, source, applyDraft, oneCall };
}

module.exports = { createGoogleCommands, keyFileFrom, rangeFor, parseGrid, columnName, block, KIND_NAME };
