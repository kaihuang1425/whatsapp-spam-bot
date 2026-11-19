'use strict';

// Reminder times. What someone types after "remind" is read in one time zone (reminders.timeZone, Europe/London by
// default) and turned into an exact moment. Only a fixed set of forms is understood, and anything that looks like a
// time or a day but is not one of them is refused, so nothing is guessed:
//   in 30 min | in 2 hours | in 3 days [5pm] | in 1 week
//   today 17:00 | tomorrow 9am | tomorrow 5.30 p.m. | Fri 17:00 | Friday, 5pm | Fri 20 Nov 17:00 (the bot's own format)
//   20 Nov 17:00 | Nov 20, 17:00 | 2026-11-20 17:00 | 2026-11-20T17:00 | 17:00 (today, or tomorrow once it has passed)
//   the time first: 9am tomorrow | 5pm Friday | 17:00 on 20 Nov | 5pm Fri (only at the end, or after "on")
// A date without a time means reminders.defaultHour. "at" before the time, and "to", "-", ":", "," or "." after the
// whole time, are skipped, so "tomorrow at 9am to call mum" is tomorrow 09:00, "call mum".

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MINUTE = 60000, HOUR = 3600000, DAY = 86400000;

function validTimeZone(timeZone) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone }); return typeof timeZone === 'string' && timeZone.length > 0; }
  catch { return false; }
}

// The wall-clock date and time at a moment, in a time zone.
function zoneParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }).formatToParts(new Date(ms));
  const get = type => parts.find(part => part.type === type)?.value || '';
  return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')), hour: Number(get('hour')),
    minute: Number(get('minute')), second: Number(get('second')), weekday: WEEKDAYS.indexOf(get('weekday').slice(0, 3).toLowerCase()) };
}

// Minutes the zone is ahead of UTC at a moment (60 for London in summer).
function offsetMinutes(ms, timeZone) {
  const p = zoneParts(ms, timeZone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000) / MINUTE);
}

// The moment a wall-clock time happens in a zone. A time skipped by a clock change lands just after it.
function wallToUtc({ year, month, day, hour, minute }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ms = guess - offsetMinutes(guess, timeZone) * MINUTE;
  ms = guess - offsetMinutes(ms, timeZone) * MINUTE;
  return ms;
}

function realDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCDate() === day;
}

// The calendar date k days after a wall-clock date.
function addDays({ year, month, day }, k) {
  const date = new Date(Date.UTC(year, month - 1, day + k));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function monthIndex(word) {
  const lower = word.toLowerCase().replace(/\.$/, '');
  if (lower === 'sept') return 8;
  if (lower.length < 3) return -1;
  return MONTHS.findIndex(name => name.startsWith(lower));
}

// A word ends at a space, the end, or punctuation followed by a space or the end ("5pm:", "Fri,", "tomorrow.").
const END = String.raw`(?=$|\s|[,:;.!?)](?:\s|$))`;
const WEEKDAY = new RegExp(String.raw`^(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)${END}`, 'i');
const FULL_DAY = new RegExp(String.raw`^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)${END}`, 'i');
const HALF = String.raw`(am|pm|a\.m\.|p\.m\.)`;
const TIME = new RegExp(String.raw`^(?:at\s+)?(?:(\d{1,2})[:.](\d{2})\s*${HALF}?|(\d{1,2})\s*${HALF}|(noon|midday))${END}`, 'i');
// Looks like a time but is not one this reads: "1700", "17h30", "5:3", "at 5", "5pm:x", "5 p m".
const NOT_A_TIME = /^(?:at\s+\d\S*|\d{3,4}(?!\w)|\d{1,2}h\d{0,2}(?!\w)|\d{1,2}:\d\S*|\d{1,2}:(?=\s|$)|\d{1,2}(?:[:.]\d{2})?\s*[ap]\.?\s?m\b\S*)/i;

function readTime(match) {
  if (match[6]) return { hour: 12, minute: 0 };
  let hour = Number(match[1] ?? match[4]);
  const minute = Number(match[2] ?? 0);
  const half = (match[3] || match[5] || '').toLowerCase().replace(/\./g, '');
  if (minute > 59) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (half === 'pm' ? 12 : 0);
  } else if (hour > 23) return null;
  return { hour, minute };
}

// A day at the start of text, without reading it yet: { length, date, explicitYear, relative } or { length, weekday }.
function dayAt(text, today) {
  let match;
  if ((match = new RegExp(`^today${END}`, 'i').exec(text))) return { length: match[0].length, date: today, explicitYear: true, relative: true };
  if ((match = new RegExp(`^(?:tomorrow|tmrw?)${END}`, 'i').exec(text))) {
    return { length: match[0].length, date: addDays(today, 1), explicitYear: true, relative: true };
  }
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T(?=\d)|(?=$|[\s,]))/i.exec(text))) {
    return { length: match[0].length, date: { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }, explicitYear: true };
  }
  if ((match = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9}\.?)(?:\s+(\d{4}))?(?![\w:.])/i.exec(text)) && monthIndex(match[2]) >= 0) {
    return { length: match[0].length, date: { year: match[3] ? Number(match[3]) : today.year, month: monthIndex(match[2]) + 1, day: Number(match[1]) },
      explicitYear: Boolean(match[3]) };
  }
  if ((match = /^([a-z]{3,9}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?![\w:.])/i.exec(text)) && monthIndex(match[1]) >= 0) {
    return { length: match[0].length, date: { year: match[3] ? Number(match[3]) : today.year, month: monthIndex(match[1]) + 1, day: Number(match[2]) },
      explicitYear: Boolean(match[3]) };
  }
  if ((match = WEEKDAY.exec(text))) return { length: match[0].length, weekday: WEEKDAYS.indexOf(match[1].slice(0, 3).toLowerCase()) };
  return null;
}

// parseWhen('Fri 17:00 submit report', { now, timeZone }) -> { at, text: 'submit report' }, or { error }.
function parseWhen(input, { now = Date.now(), timeZone = 'Europe/London', defaultHour = 9 } = {}) {
  let rest = String(input || '').trim();
  const take = length => { rest = rest.slice(length).trimStart(); };
  const skipComma = () => { const comma = /^,\s*/.exec(rest); if (comma) take(comma[0].length); };
  const finish = at => ({ at, text: rest.replace(/^(?:to\s+|[-–:,.;!?]\s*)/i, '').trim() });
  const today = zoneParts(now, timeZone);

  // A time, null, or { error } for something that looks like a time but is not one this reads.
  const readClock = () => {
    const match = TIME.exec(rest);
    if (match) {
      const time = readTime(match);
      if (!time) return { error: `"${match[0].trim()}" is not a time. Use 17:00, 5pm, 5.30pm or 9:30am.` };
      take(match[0].length);
      skipComma();
      if (TIME.test(rest)) return { error: 'That has two times in a row. Give one, for example: Fri 17:00 submit report.' };
      return time;
    }
    const wrong = NOT_A_TIME.exec(rest);
    return wrong ? { error: `"${wrong[0]}" is not a time this understands. Use 17:00, 5pm, 5.30pm or 9:30am.` } : null;
  };

  let match = /^in\s+(\d{1,3})\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b/i.exec(rest);
  if (match) {
    take(match[0].length);
    const n = Number(match[1]);
    if (n < 1) return { error: 'Give a time at least 1 minute from now.' };
    const unit = match[2][0].toLowerCase();
    if (unit === 'm' || unit === 'h') {
      // "in 2 hours at 5pm" gives two different times.
      if (TIME.test(rest)) return { error: `"in ${n} ${match[2]}" and a time are two different times. Give one, for example: in 2 hours call mum, or today 5pm call mum.` };
      return finish(now + n * (unit === 'm' ? MINUTE : HOUR));
    }
    // Days and weeks keep the same wall-clock time across a clock change, unless a time follows ("in 2 days 5pm").
    const time = readClock();
    if (time?.error) return time;
    const date = addDays(today, unit === 'w' ? 7 * n : n);
    return finish(wallToUtc({ ...date, ...(time || { hour: today.hour, minute: today.minute }) }, timeZone));
  }

  // explicitYear: a date that has passed stays in the past (and is refused) instead of moving to next year.
  let date = null, weekday = -1, explicitYear = false, statedWeekday = -1;
  const readDay = ({ afterTime = false } = {}) => {
    const lead = /^(?:on|the)\s+/i.exec(rest);
    const text = lead ? rest.slice(lead[0].length) : rest;
    const found = dayAt(text, today);
    if (!found) return null;
    // After a time, a short day name or a date in the middle of the text may be part of the text ("5pm sun cream",
    // "9am may 20 people come"): only "on ...", today, tomorrow, a full day name or a day at the very end count.
    if (afterTime && !lead && !found.relative && !FULL_DAY.test(text) && !/^\s*(?:[,.;:!?)]\s*)?$/.test(text.slice(found.length))) {
      return { error: `Is "${text.slice(0, found.length)}" the day? Put the day first, for example: Fri 5pm submit report, or today 5pm sun cream.` };
    }
    take((lead ? lead[0].length : 0) + found.length);
    if (found.date) ({ date, explicitYear } = found);
    else {
      weekday = found.weekday;
      // "Fri 20 Nov": a day name before a date (the bot's own format) is checked against the date.
      skipComma();
      const next = dayAt(rest, today);
      if (next?.date && !next.relative) {
        take(next.length);
        ({ date, explicitYear } = next);
        statedWeekday = weekday;
        weekday = -1;
      }
    }
    skipComma();
    return true;
  };

  const first = readDay();
  if (first?.error) return first;
  const time = readClock();
  if (time?.error) return time;
  if (!first && time) {
    const after = readDay({ afterTime: true });
    if (after?.error) return after;
  }
  if (!date && weekday < 0 && !time) return { error: 'Start with when, for example: tomorrow 9am, Fri 17:00, 20 Nov 14:30 or in 2 hours.' };
  const clock = time || { hour: defaultHour, minute: 0 };
  const at = day => wallToUtc({ ...day, ...clock }, timeZone);

  if (weekday >= 0) {
    let k = (weekday - today.weekday + 7) % 7;
    if (k === 0 && at(today) <= now) k = 7;
    return finish(at(addDays(today, k)));
  }
  if (date) {
    if (!realDate(date.year, date.month, date.day)) return { error: 'That date does not exist.' };
    // "20 Nov" once 20 Nov has passed means next year's.
    if (!explicitYear && at(date) <= now) date = { ...date, year: date.year + 1 };
    if (!realDate(date.year, date.month, date.day)) return { error: 'That date does not exist next year.' };
    if (statedWeekday >= 0) {
      const actual = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
      if (actual !== statedWeekday) {
        return { error: `${date.day} ${MONTH_NAMES[date.month - 1]} ${date.year} is a ${DAY_NAMES[actual]}, not a ${DAY_NAMES[statedWeekday]}.` };
      }
    }
    return finish(at(date));
  }
  return finish(at(today) > now ? at(today) : at(addDays(today, 1)));
}

// "2026-11-20T17:00" in the zone's local time (what the AI writes), or null. A date alone means defaultHour.
// Seconds are ignored; a time with "Z" or an offset is taken as that exact moment.
function parseLocalIso(text, timeZone, defaultHour = 0) {
  const trimmed = String(text || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(trimmed);
  if (!match) return null;
  if (match[6]) {
    const moment = Date.parse(trimmed);
    return Number.isFinite(moment) ? moment : null;
  }
  const [year, month, day] = [1, 2, 3].map(i => Number(match[i]));
  const hour = match[4] === undefined ? defaultHour : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  if (!realDate(year, month, day) || hour > 23 || minute > 59) return null;
  return wallToUtc({ year, month, day, hour, minute }, timeZone);
}

// "Fri 20 Nov 17:00", with the year when it is not this year.
function formatWhen(ms, timeZone, now = Date.now()) {
  const p = zoneParts(ms, timeZone);
  const year = p.year !== zoneParts(now, timeZone).year ? ` ${p.year}` : '';
  return `${WEEKDAY_NAMES[p.weekday]} ${p.day} ${MONTH_NAMES[p.month - 1]}${year} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

// "Thursday 5 November 2026, 21:30" for the AI, so it can read "Friday" or "tomorrow" in the messages.
function describeNow(now, timeZone) {
  const p = zoneParts(now, timeZone);
  return `${DAY_NAMES[p.weekday]} ${p.day} ${MONTHS[p.month - 1][0].toUpperCase()}${MONTHS[p.month - 1].slice(1)} ${p.year}, ` +
    `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

// "London time" for "Europe/London".
function zoneLabel(timeZone) {
  return `${String(timeZone).split('/').pop().replace(/_/g, ' ')} time`;
}

// "HH:MM", 00:00 to 23:59.
function validClockTime(text) {
  return typeof text === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text);
}

// The scheduled run a moment belongs to: "YYYY-MM-DD HH:MM" (the slot's local date and time) when now is within
// windowMinutes after one of times ("HH:MM" in timeZone), else null. Yesterday's times count too, for a window that
// runs past midnight. A time skipped by a clock change starts just after the change.
function scheduledSlot(now, timeZone, times, windowMinutes) {
  const today = zoneParts(now, timeZone);
  const pad = n => String(n).padStart(2, '0');
  for (const day of [today, addDays(today, -1)]) {
    for (const time of times) {
      const [hour, minute] = time.split(':').map(Number);
      const start = wallToUtc({ year: day.year, month: day.month, day: day.day, hour, minute }, timeZone);
      if (now >= start && now < start + windowMinutes * MINUTE) return `${day.year}-${pad(day.month)}-${pad(day.day)} ${time}`;
    }
  }
  return null;
}

module.exports = { parseWhen, parseLocalIso, formatWhen, describeNow, zoneLabel, validTimeZone, validClockTime, scheduledSlot, wallToUtc, zoneParts, DAY };
