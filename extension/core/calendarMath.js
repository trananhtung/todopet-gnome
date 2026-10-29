// Pure calendar arithmetic (port of CalendarMath and the event filtering of CalendarWatcher.events(on:) from
// CalendarWatcher.swift). A CalEvent is {id, title, start: Date, end: Date, joinURL: string|null};
// an interval is {start: Date, end: Date}.

const MINUTE_MS = 60_000;
const QUARTER_MS = 15 * MINUTE_MS;

const MEETING_HOSTS = Object.freeze([
    'zoom.us', 'meet.google.com', 'teams.microsoft.com', 'teams.live.com', 'webex.com', 'whereby.com',
]);

// Lower-case host of an absolute URL text ("https://user@Host:8080/x" -> "host"), or null when there is none.
function hostOf(text) {
    const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(text);
    if (!match)
        return null;
    const authority = match[1].slice(match[1].lastIndexOf('@') + 1);
    const host = authority.startsWith('[')
        ? authority.slice(0, authority.indexOf(']') + 1)
        : authority.replace(/:\d*$/, '');
    return host === '' ? null : host.toLowerCase();
}

const isMeetingHost = host => host !== null && MEETING_HOSTS.some(meetingHost => host.endsWith(meetingHost));

// True for an absolute http:// or https:// URL with a host: the only links TodoPet opens in the default app (a
// calendar event can come from anyone's invitation, so its URL must not start whatever handles another scheme).
export function isWebURL(text) {
    return typeof text === 'string' && /^https?:\/\//i.test(text) && hostOf(text) !== null;
}

// What a log line may say about a link: its scheme and host ("https://zoom.us/…"). The rest stays out of the journal:
// a Join link can carry the meeting's password, a file: link a path in your home folder.
export function linkForLog(text) {
    if (typeof text !== 'string')
        return '(no link)';
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1].toLowerCase();
    if (!scheme)
        return '(not a link)';
    const host = hostOf(text);
    return host === null ? `${scheme}:…` : `${scheme}://${host}/…`;
}

// Finds a video-call link in the event URL, then in the given texts (location, notes). Like the Swift app,
// an event URL that is not a meeting link is still returned when the texts hold no meeting link, but only a web
// (http or https) one: any other URL is no Join link.
export function joinURL(url, texts = []) {
    const web = isWebURL(url) ? url : null;
    if (web !== null && isMeetingHost(hostOf(web)))
        return web;
    for (const text of texts ?? []) {
        if (typeof text !== 'string')
            continue;
        for (const [link] of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
            if (isMeetingHost(hostOf(link)))
                return link;
        }
    }
    return web;
}

// Busy intervals clipped to [from, to], sorted by start and merged when they overlap or touch.
export function busy(events, from, to) {
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const clipped = [];
    for (const e of events) {
        const start = Math.max(e.start.getTime(), fromMs);
        const end = Math.min(e.end.getTime(), toMs);
        if (start < end)
            clipped.push([start, end]);
    }
    clipped.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of clipped) {
        const last = merged.at(-1);
        if (last && start <= last[1])
            last[1] = Math.max(last[1], end);
        else
            merged.push([start, end]);
    }
    return merged.map(([start, end]) => ({start: new Date(start), end: new Date(end)}));
}

// The gaps between meetings that last at least `minMinutes`.
export function freeSlots(events, from, to, minMinutes = 30) {
    if (!(from.getTime() < to.getTime()))
        return [];
    const slots = [];
    let cursor = from.getTime();
    for (const b of busy(events, from, to)) {
        if (b.start.getTime() - cursor >= minMinutes * MINUTE_MS)
            slots.push({start: new Date(cursor), end: b.start});
        cursor = Math.max(cursor, b.end.getTime());
    }
    if (to.getTime() - cursor >= minMinutes * MINUTE_MS)
        slots.push({start: new Date(cursor), end: new Date(to.getTime())});
    return slots;
}

export function freeMinutes(events, from, to) {
    if (!(from.getTime() < to.getTime()))
        return 0;
    const busyMinutes = busy(events, from, to).reduce((sum, i) => sum + (i.end.getTime() - i.start.getTime()) / MINUTE_MS, 0);
    return (to.getTime() - from.getTime()) / MINUTE_MS - busyMinutes;
}

// About one meaningful task per 2 free hours, capped by the user's daily target (Swift: CalendarMath.target).
export function targetFor(freeMinutesLeft, maxTarget) {
    const wanted = Number.isFinite(freeMinutesLeft) ? Math.ceil(freeMinutesLeft / 120) : 0;
    return Math.max(1, Math.min(maxTarget, wanted));
}

// The meeting going on at `at` (a meeting is over at its end).
export function currentEvent(events, at) {
    return events.find(e => e.start.getTime() <= at.getTime() && at.getTime() < e.end.getTime()) ?? null;
}

// The first meeting that starts after `after`.
export function nextEvent(events, after) {
    return events.find(e => e.start.getTime() > after.getTime()) ?? null;
}

// Places the top tasks (without a time yet) into today's next free slots, starting at the next quarter hour.
// Returns [{task, start, end}] with at most `limit` entries.
export function suggest(tasks, events, now, dayEnd, limit = 3) {
    const start = new Date(Math.ceil(now.getTime() / QUARTER_MS) * QUARTER_MS);
    const slots = freeSlots(events, start, dayEnd, 30);
    const out = [];
    for (const task of tasks) {
        if (task.dueTime !== null || task.isRecurring)
            continue;
        if (out.length >= limit)
            break;
        const wanted = (task.durationMinutes ?? 60) * MINUTE_MS;
        const length = slot => slot.end.getTime() - slot.start.getTime();
        const i = slots.findIndex(slot => length(slot) >= Math.min(wanted, 30 * MINUTE_MS));
        if (i < 0)
            break;
        const slot = slots[i];
        const end = new Date(slot.start.getTime() + Math.min(wanted, length(slot)));
        out.push({task, start: new Date(slot.start.getTime()), end});
        const rest = new Date(end.getTime() + 10 * MINUTE_MS);
        if (rest.getTime() < slot.end.getTime())
            slots[i] = {start: rest, end: slot.end};
        else
            slots.splice(i, 1);
    }
    return out;
}

// "8h" or "1h30": minutes rounded to the nearest whole minute (halves away from zero, like Swift).
export function hoursText(minutes) {
    const value = Number.isFinite(minutes) ? minutes : 0;
    const m = Math.sign(value) * Math.round(Math.abs(value));
    const rest = m % 60;
    return rest === 0 ? `${Math.trunc(m / 60)}h` : `${Math.trunc(m / 60)}h${String(rest).padStart(2, '0')}`;
}

// --- Mappers: calendar sources -> CalEvent ---

const isLocalMidnight = d => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;

// The calendar server has no all-day flag here: such an event runs from local midnight to a later local midnight.
const isAllDay = (start, end) => end.getTime() > start.getTime() && isLocalMidnight(start) && isLocalMidnight(end);

// Tuples [id, summary, startSeconds, endSeconds, extras] from the shell's calendar server, sorted by start;
// all-day events are dropped. `extras` is ignored. The server gives no join link.
export function eventsFromServer(tuples) {
    const events = [];
    for (const tuple of tuples) {
        if (!Array.isArray(tuple))
            continue;
        const [id, summary, startSec, endSec] = tuple;
        if (!Number.isFinite(startSec) || !Number.isFinite(endSec))
            continue;
        const start = new Date(startSec * 1000);
        const end = new Date(endSec * 1000);
        if (isAllDay(start, end))
            continue;
        events.push({id: String(id), title: summary == null ? '' : String(summary), start, end, joinURL: null});
    }
    return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}

// One occurrence of a calendar component, or null when it is not a busy, timed, accepted event
// (all-day, cancelled, "free" time, or declined by the user).
export function eventFromComp({uid, rid, summary, start, end, allDay, cancelled, transparent, declined, url, location, description}) {
    if (allDay || cancelled || transparent || declined)
        return null;
    if (!(start instanceof Date) || !(end instanceof Date) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
        return null;
    return {
        id: `${uid}${rid ? `:${rid}` : ''}@${Math.floor(start.getTime() / 1000)}`,
        title: summary ?? '',
        start,
        end,
        joinURL: joinURL(url, [location, description]),
    };
}
