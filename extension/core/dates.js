// Date parsing, calendar-day math and text cleanup (port of DateParse, DayMath and TextClean from Models.swift).
// Everything is local time, like Swift's Calendar.current.
import {L} from './l10n.js';

// "2026-10-25T02:00:00Z" or "2026-10-25T09:00:00+07:00" (fractional seconds are already stripped).
const ABSOLUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;
// "2026-10-25", "2026-10-25T09:30" and "2026-10-25T09:30:00": floating, so local time.
const FLOATING = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

const isLeap = y => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const daysInMonth = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const pad = (n, width = 2) => String(n).padStart(width, '0');

function validParts(y, mo, d, h, mi, s) {
    return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo) && h <= 23 && mi <= 59 && s <= 59;
}

// Parses every date shape Todoist returns: "2026-10-25", "2026-10-25T09:00:00" (floating, local time),
// "2026-10-25T02:00:00Z" and "2026-10-25T02:00:00.123456Z". Returns null when it is none of those.
export function parseDate(raw) {
    if (typeof raw !== 'string')
        return null;
    const s = raw.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, '').replace(/\.\d+/g, '');

    const abs = ABSOLUTE.exec(s);
    if (abs) {
        const [y, mo, d, h, mi, sec] = abs.slice(1, 7).map(Number);
        let offsetMinutes = 0;
        if (abs[7] !== 'Z') {
            const [oh, om] = abs[7].slice(1).split(':').map(Number);
            if (oh > 23 || om > 59)
                return null;
            offsetMinutes = (abs[7][0] === '-' ? -1 : 1) * (oh * 60 + om);
        }
        if (!validParts(y, mo, d, h, mi, sec))
            return null;
        const date = new Date(0);
        date.setUTCFullYear(y, mo - 1, d);
        date.setUTCHours(h, mi, sec, 0);
        return new Date(date.getTime() - offsetMinutes * 60_000);
    }

    const flo = FLOATING.exec(s);
    if (flo) {
        const [y, mo, d, h, mi, sec] = flo.slice(1, 7).map(part => Number(part ?? 0));
        if (!validParts(y, mo, d, h, mi, sec))
            return null;
        const date = new Date(2000, 0, 1);
        date.setFullYear(y, mo - 1, d);
        date.setHours(h, mi, sec, 0);
        return date;
    }
    return null;
}

// "2026-10-25T02:00:00Z" (UTC, whole seconds), the form the Todoist API takes for since/until.
export function utcString(date) {
    return `${date.toISOString().slice(0, 19)}Z`;
}

// "2026-10-25" for the local calendar day of `date`.
export function dayKey(date) {
    return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// A copy of `date` set to hour:minute:00 (hour clamped to 0...23) on the same local day.
export function atHour(hour, minute = 0, date) {
    const result = new Date(date.getTime());
    result.setHours(Math.min(Math.max(hour, 0), 23), minute, 0, 0);
    return result;
}

export function hourOf(date) {
    return date.getHours();
}

// Whole calendar days from day key `a` to day key `b` ("yyyy-MM-dd"); 0 when either does not parse.
export function daysBetween(a, b) {
    const x = parseDate(a);
    const y = parseDate(b);
    if (!x || !y)
        return 0;
    const dayNumber = d => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
    return dayNumber(y) - dayNumber(x);
}

// "yesterday" / "3 days ago" for an overdue "yyyy-MM-dd".
export function daysAgo(day, now = new Date()) {
    const n = daysBetween(day, dayKey(now));
    if (n === 1)
        return L('hôm qua', 'yesterday');
    return L(`${n} ngày trước`, `${n} days ago`);
}

// 24-hour "HH:MM" in local time.
export function timeString(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// The day key after `key`; "9999" when `key` does not parse (as in the Swift app).
export function nextDayKey(key) {
    const date = parseDate(key);
    if (!date)
        return '9999';
    // Noon, so a daylight-saving jump can never skip or repeat the day.
    return dayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 12));
}

// Strips Todoist markdown so titles read nicely in bubbles.
export function plainText(s) {
    return s
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\*\*|__|`/g, '')
        .replace(/^[\p{Z}\t-\r\u0085]+|[\p{Z}\t-\r\u0085]+$/gu, '');
}

const graphemes = new Intl.Segmenter('und', {granularity: 'grapheme'});

// `s` when it has at most `max` graphemes, else its first max - 1 graphemes and an ellipsis.
export function shortText(s, max = 42) {
    if (s.length <= max)
        return s;
    const parts = Array.from(graphemes.segment(s), part => part.segment);
    if (parts.length <= max)
        return s;
    return `${parts.slice(0, Math.max(max - 1, 0)).join('')}…`;
}
