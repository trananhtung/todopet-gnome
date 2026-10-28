import {atHour, dayKey, parseDate} from '../extension/core/dates.js';
import {Task} from '../extension/core/models.js';
import {
    busy, currentEvent, eventFromComp, eventsFromServer, freeMinutes, freeSlots, hoursText, isWebURL, joinURL, nextEvent,
    suggest, targetFor,
} from '../extension/core/calendarMath.js';
import {StuckTracker, stuckDays} from '../extension/core/stuck.js';
import {isBrowser, matchTitle, stripBrowserName, titleKeywords} from '../extension/core/sites.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// An in-memory store with the interface StuckTracker expects; `saves` records every save, in order.
function memoryStore(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        saves: [],
        async load(name) {
            return data.get(name) ?? null;
        },
        save(name, obj) {
            this.saves.push([name, JSON.parse(JSON.stringify(obj))]);
            data.set(name, JSON.parse(JSON.stringify(obj)));
        },
    };
}

const times = intervals => intervals.map(i => [i.start.getTime(), i.end.getTime()]);

export default async function (t) {
    // --- Calendar math (DevTools.swift "Calendar math", now = 2026-10-25 11:00) ---
    const now = atHour(11, 0, parseDate('2026-10-25'));
    const base = atHour(8, 0, now);
    const dayEnd = atHour(18, 0, now);
    const meeting = (h, hours) => ({
        id: String(h), title: 'm', start: new Date(base.getTime() + h * HOUR),
        end: new Date(base.getTime() + (h + hours) * HOUR), joinURL: null,
    });
    const events = [meeting(1, 1), meeting(1.5, 1), meeting(5, 0.5)]; // 9:00-10:30 (overlapping) and 13:00-13:30

    t.eq(busy(events, base, dayEnd).length, 2, 'overlapping meetings merge');
    t.near(freeMinutes(events, base, dayEnd), 480, 0.1, 'free minutes');
    t.eq(freeSlots(events, base, dayEnd).length, 3, 'free slots between meetings');
    t.check(targetFor(480, 3) === 3 && targetFor(200, 3) === 2 && targetFor(60, 3) === 1, 'target follows free time');

    const slotTasks = [
        new Task({id: 'a', content: 'A', priority: 4, due: {date: '2026-10-25'}}),
        new Task({id: 'b', content: 'B', priority: 1, due: {date: '2026-10-25'}, duration: {amount: 30, unit: 'minute'}}),
    ];
    const sug = suggest(slotTasks, events, new Date(base.getTime() + 50 * MINUTE), dayEnd);
    t.check(sug.length > 0 && sug[0].start.getHours() === 10 && sug[0].start.getMinutes() === 30,
        'first suggestion starts after the meeting');
    t.check(sug.length === 2 && sug[1].end.getTime() - sug[1].start.getTime() === 1800_000, 'task duration respected');
    t.eq(sug.map(s => s.task.id), ['a', 'b'], 'suggestions carry their task');
    t.eq([sug[0].end.getHours() * 60 + sug[0].end.getMinutes(), sug[1].start.getHours() * 60 + sug[1].start.getMinutes()],
        [11 * 60 + 30, 11 * 60 + 40], 'a 10 minute break follows each block');

    t.eq(joinURL(null, ['Join: https://us02web.zoom.us/j/123?pwd=x thanks']), 'https://us02web.zoom.us/j/123?pwd=x',
        'meeting link found in notes');

    // --- Busy intervals and free slots in detail ---
    t.eq(times(busy(events, base, dayEnd)), [
        [base.getTime() + HOUR, base.getTime() + 2.5 * HOUR],
        [base.getTime() + 5 * HOUR, base.getTime() + 5.5 * HOUR],
    ], 'merged busy intervals are 9:00-10:30 and 13:00-13:30');
    t.check(busy(events, base, dayEnd).every(i => i.start instanceof Date && i.end instanceof Date),
        'busy intervals hold Dates');
    t.eq(times(busy([meeting(5, 0.5), meeting(1, 1)], base, dayEnd)).map(i => i[0]),
        [base.getTime() + HOUR, base.getTime() + 5 * HOUR], 'busy intervals are sorted by start');
    t.eq(times(busy([meeting(1, 1), meeting(2, 1)], base, dayEnd)), [[base.getTime() + HOUR, base.getTime() + 3 * HOUR]],
        'back-to-back meetings merge');
    t.eq(times(busy([meeting(-1, 2), meeting(9, 3)], base, dayEnd)),
        [[base.getTime(), base.getTime() + HOUR], [base.getTime() + 9 * HOUR, dayEnd.getTime()]],
        'busy intervals are clipped to the window');
    t.eq(busy([meeting(-3, 1), meeting(11, 1)], base, dayEnd), [], 'meetings outside the window are not busy');
    t.eq(busy([], base, dayEnd), [], 'no meetings, nothing busy');
    t.eq(busy([meeting(1, 0)], base, dayEnd), [], 'an empty meeting is not busy');

    t.eq(times(freeSlots(events, base, dayEnd)), [
        [base.getTime(), base.getTime() + HOUR],
        [base.getTime() + 2.5 * HOUR, base.getTime() + 5 * HOUR],
        [base.getTime() + 5.5 * HOUR, dayEnd.getTime()],
    ], 'free slots are the gaps of at least 30 minutes');
    t.eq(times(freeSlots([meeting(0, 1), meeting(1.3, 3)], base, dayEnd)), [[base.getTime() + 4.3 * HOUR, dayEnd.getTime()]],
        'a gap under 30 minutes is not a slot');
    t.eq(times(freeSlots([meeting(1, 2)], base, new Date(base.getTime() + 3.5 * HOUR), 60)),
        [[base.getTime(), base.getTime() + HOUR]], 'minMinutes is configurable and a gap of exactly that length counts');
    t.eq(times(freeSlots([], base, dayEnd)), [[base.getTime(), dayEnd.getTime()]], 'no meetings, one big slot');
    t.eq(freeSlots(events, dayEnd, base), [], 'free slots of an inverted window are empty');
    t.eq(freeSlots(events, base, base), [], 'free slots of an empty window are empty');
    t.eq(times(freeSlots([meeting(0, 10)], base, dayEnd)), [], 'a fully busy window has no slots');

    t.near(freeMinutes([], base, dayEnd), 600, 0.001, 'free minutes without meetings');
    t.eq(freeMinutes(events, dayEnd, base), 0, 'free minutes of an inverted window is 0');
    t.near(freeMinutes([meeting(-2, 20)], base, dayEnd), 0, 0.001, 'free minutes of a fully busy window is 0');

    // --- Daily target ---
    t.eq([480, 241, 240, 120, 119, 1, 0].map(m => targetFor(m, 5)), [4, 3, 2, 1, 1, 1, 1],
        'about one task per 2 free hours, rounded up, at least 1');
    t.eq([targetFor(2000, 3), targetFor(2000, 1), targetFor(2000, 0), targetFor(-50, 3)], [3, 1, 1, 1],
        'the target is capped by maxTarget and never below 1');

    // --- Current and next meeting ---
    const m1 = meeting(1, 1);
    const m2 = meeting(3, 1);
    const two = [m1, m2];
    t.eq(currentEvent(two, new Date(m1.start.getTime() - 1))?.id, undefined, 'no current meeting before the first one');
    t.eq(currentEvent(two, m1.start)?.id, m1.id, 'a meeting is current at its start');
    t.eq(currentEvent(two, new Date(m1.end.getTime() - 1))?.id, m1.id, 'a meeting is current until its last millisecond');
    t.eq(currentEvent(two, m1.end), null, 'a meeting is over at its end');
    t.eq(nextEvent(two, m1.start)?.id, m2.id, 'next meeting starts strictly after the given time');
    t.eq(nextEvent(two, new Date(m1.start.getTime() - 1))?.id, m1.id, 'next meeting before the first one');
    t.eq(nextEvent(two, m2.start), null, 'no next meeting after the last one starts');
    t.eq([currentEvent([], now), nextEvent([], now)], [null, null], 'no meetings, no current or next meeting');

    // --- Suggestions in detail ---
    const open = [];
    const day = (id, extra = {}) => new Task({id, content: id, priority: 1, due: {date: '2026-10-25'}, ...extra});
    const at = (h, m = 0) => atHour(h, m, now);
    const minutesOf = d => d.getHours() * 60 + d.getMinutes();
    let s = suggest([day('a')], open, at(8, 50), dayEnd);
    t.eq([minutesOf(s[0].start), minutesOf(s[0].end)], [9 * 60, 10 * 60], 'the start rounds up to the next quarter hour');
    s = suggest([day('a')], open, at(9, 0), dayEnd);
    t.eq(minutesOf(s[0].start), 9 * 60, 'a time on a quarter hour is kept');
    s = suggest([day('a')], open, new Date(at(9, 0).getTime() + 1), dayEnd);
    t.eq(minutesOf(s[0].start), 9 * 60 + 15, 'one millisecond past a quarter hour rounds up');
    s = suggest([day('a'), day('b'), day('c'), day('d')], open, at(8, 0), dayEnd);
    t.eq(s.map(x => x.task.id), ['a', 'b', 'c'], 'at most 3 suggestions by default');
    s = suggest([day('a'), day('b'), day('c'), day('d')], open, at(8, 0), dayEnd, 2);
    t.eq(s.map(x => x.task.id), ['a', 'b'], 'the limit is configurable');
    t.eq(suggest([day('a')], open, at(8, 0), dayEnd, 0), [], 'a limit of 0 suggests nothing');
    t.eq(suggest([day('a')], open, at(17, 45), dayEnd), [], 'a slot under 30 minutes is not used');
    t.eq(suggest([], open, at(8, 0), dayEnd), [], 'no tasks, no suggestions');
    s = suggest([day('a')], open, at(17, 30), dayEnd);
    t.eq([minutesOf(s[0].start), minutesOf(s[0].end)], [17 * 60 + 30, 18 * 60],
        'a task longer than its slot is cut to the slot');
    s = suggest([day('a', {duration: {amount: 10, unit: 'minute'}})], open, at(8, 0), dayEnd);
    t.eq(minutesOf(s[0].end) - minutesOf(s[0].start), 10, 'a short task needs only its own length');
    s = suggest([day('a', {duration: {amount: 2, unit: 'day'}})], open, at(8, 0), dayEnd);
    t.eq(minutesOf(s[0].end) - minutesOf(s[0].start), 600, 'a multi-day task fills the whole slot');
    s = suggest([day('a', {due: {date: '2026-10-25T15:00:00'}}), day('b'), day('c', {due: {date: '2026-10-25', isRecurring: true}}), day('d')],
        open, at(8, 0), dayEnd);
    t.eq(s.map(x => x.task.id), ['b', 'd'], 'timed and recurring tasks are not placed');
    // Slot 8:00-9:00 holds a 60 minute task; the next one has to wait for the next slot because the rest is under 30.
    s = suggest([day('a'), day('b', {duration: {amount: 30, unit: 'minute'}})], [meeting(1, 1)], at(8, 0), dayEnd);
    t.eq(s.map(x => [minutesOf(x.start), minutesOf(x.end)]), [[8 * 60, 9 * 60], [10 * 60, 10 * 60 + 30]],
        'a used-up slot is dropped and the next task goes to the next slot');
    t.eq(suggest([day('a')], [meeting(0, 10)], at(8, 0), dayEnd), [], 'a day full of meetings has no suggestions');
    const fill = suggest([day('a')], [meeting(1, 1)], at(8, 0), dayEnd)[0];
    t.check(fill.start instanceof Date && fill.end instanceof Date && fill.start < fill.end, 'suggestions hold Dates');
    // The break leaves 50 minutes -> a second task (30 min) still fits in the same slot.
    s = suggest([day('a', {duration: {amount: 30, unit: 'minute'}}), day('b', {duration: {amount: 30, unit: 'minute'}})],
        [meeting(2, 8)], at(8, 0), dayEnd);
    t.eq(s.map(x => [minutesOf(x.start), minutesOf(x.end)]), [[8 * 60, 8 * 60 + 30], [8 * 60 + 40, 9 * 60 + 10]],
        'a second task goes after the 10 minute break in the same slot');

    // --- Hours text ---
    t.eq([480, 90, 65, 45, 0, 60, 125].map(hoursText), ['8h', '1h30', '1h05', '0h45', '0h', '1h', '2h05'],
        'hoursText formats whole hours and hours with minutes');
    t.eq([59.6, 119.5, 29.4, 89.5].map(hoursText), ['1h', '2h', '0h29', '1h30'], 'hoursText rounds to whole minutes');

    // --- Join links ---
    t.eq(joinURL('https://us02web.zoom.us/j/1', ['https://meet.google.com/x']), 'https://us02web.zoom.us/j/1',
        'a meeting URL on the event wins over the notes');
    t.eq(joinURL('https://MEET.Google.com/abc', []), 'https://MEET.Google.com/abc', 'the URL host is compared in lower case');
    t.eq(joinURL('https://example.com/event', ['Join https://meet.google.com/abc-defg-hij']),
        'https://meet.google.com/abc-defg-hij', 'a non-meeting event URL gives way to a meeting link in the notes');
    t.eq(joinURL('https://example.com/event', ['nothing here', null]), 'https://example.com/event',
        'with no meeting link the original URL comes back, as in the Swift app');
    t.eq([joinURL(null, []), joinURL(undefined, undefined), joinURL('', ['no link']), joinURL(null, [null, undefined])],
        [null, null, null, null], 'no URL and no link gives null');
    t.eq(joinURL(null, ['See https://example.com/a then https://teams.microsoft.com/l/meetup-join/abc and more']),
        'https://teams.microsoft.com/l/meetup-join/abc', 'non-meeting links in the notes are skipped');
    t.eq(joinURL(null, ['Call <https://whereby.com/room>']), 'https://whereby.com/room', 'a link ends at an angle bracket');
    t.eq(joinURL(null, ['Link: "https://zoom.us/j/9" ok']), 'https://zoom.us/j/9', 'a link ends at a quote');
    t.eq(joinURL(null, ['https://zoom.us:8443/j/9']), 'https://zoom.us:8443/j/9', 'a port does not hide the host');
    t.eq(joinURL(null, ['https://meet.google.com@evil.example/x']), null, 'the host is what follows user info');
    t.eq(joinURL(null, ['https://evil.example/?next=https://zoom.us/j/1']), null, 'only the host decides, not the query');
    t.eq(joinURL(null, ['http://webex.com/meet/x']), 'http://webex.com/meet/x', 'plain http links count too');
    t.eq(joinURL(null, ['https://notzoom.us/x']), 'https://notzoom.us/x', 'the host suffix match is as loose as the Swift app');
    t.eq(joinURL(null, ['https://teams.live.com/meet/1']), 'https://teams.live.com/meet/1', 'teams.live.com is a meeting host');
    t.eq(joinURL(null, ['x', 'https://whereby.com/a https://zoom.us/b']), 'https://whereby.com/a', 'the first meeting link wins');
    t.eq(joinURL(null, ['room: https://zoom.us/j/1?pwd=a.b!']), 'https://zoom.us/j/1?pwd=a.b!',
        'trailing punctuation stays on the link, as in the Swift app');
    // Only web links: an invitation's URL must not open whatever handles another scheme (the final review).
    t.eq(joinURL('javascript:alert(1)', []), null, 'a javascript: event URL is no Join link');
    t.eq(joinURL('file:///etc/passwd', ['nothing here']), null, 'a file: event URL is no Join link');
    t.eq(joinURL('smb://server/share/x', []), null, 'an smb: event URL is no Join link');
    t.eq(joinURL('javascript://zoom.us/%0Aalert(1)', []), null, 'not even one whose "host" looks like a meeting host');
    t.eq(joinURL('smb://server/share', ['Join https://meet.google.com/abc']), 'https://meet.google.com/abc',
        'a meeting link in the notes still wins over a URL that is not a web link');
    t.eq(joinURL('HTTPS://Example.com/e', []), 'HTTPS://Example.com/e', 'the scheme is compared in any case');
    t.eq([isWebURL('https://zoom.us/j/1'), isWebURL('http://x.example'), isWebURL('https://'), isWebURL('javascript:alert(1)'),
        isWebURL('file:///tmp'), isWebURL('smb://host/share'), isWebURL(' https://zoom.us'), isWebURL(null)],
    [true, true, false, false, false, false, false, false], 'isWebURL: http and https with a host, nothing else');

    // --- Events from the calendar server ---
    const ev = eventsFromServer([['b', 'Sync', 1792908000, 1792909800, {}], ['a', 'Standup', 1792900000, 1792901800, {}],
        ['d', 'Holiday', Date.UTC(2026, 9, 24, 17) / 1000, Date.UTC(2026, 9, 25, 17) / 1000, {}]]);
    t.eq(ev.map(e => e.id), ['a', 'b'], 'server events sorted, all-day dropped');
    t.eq(ev.map(e => e.title), ['Standup', 'Sync'], 'server event titles');
    t.eq(ev[0].start.getTime(), 1792900000_000, 'server times are seconds');
    t.eq([ev[1].end.getTime(), ev[0].joinURL], [1792909800_000, null], 'server event end and no join link');
    t.check(ev.every(e => e.start instanceof Date && e.end instanceof Date), 'server events hold Dates');
    t.eq(eventsFromServer([]), [], 'no server events');
    const midnight = at(0, 0).getTime() / 1000;
    t.eq(eventsFromServer([['two', 'Trip', midnight, midnight + 2 * 86400, {}]]), [], 'a 2-day all-day event is dropped');
    t.eq(eventsFromServer([['half', 'Late', midnight, midnight + 12 * 3600, {}]]).map(e => e.id), ['half'],
        'a timed event that starts at midnight is kept');
    t.eq(eventsFromServer([['off', 'Early', midnight + 3600, midnight + 86400 + 3600, {}]]).map(e => e.id), ['off'],
        'a 24 hour event that does not start at midnight is kept');
    t.eq(eventsFromServer([['zero', 'Mark', midnight, midnight, {}]]).map(e => e.id), ['zero'],
        'an empty event at midnight is not all-day');
    t.eq(eventsFromServer([['x', 'Bad', 'soon', 5, {}], ['y', null, midnight + 3600, midnight + 7200, {}], null]).map(e => [e.id, e.title]),
        [['y', '']], 'malformed tuples are skipped and a missing title is empty');
    t.eq(eventsFromServer([['t1', 'One', midnight + 7200, midnight + 9000, {}], ['t2', 'Two', midnight + 7200, midnight + 8000, {}]]).map(e => e.id),
        ['t1', 't2'], 'events that start together keep their order');

    // --- Events from calendar components ---
    const soon = new Date();
    const comp = eventFromComp({
        uid: 'x', summary: 'Call', start: soon, end: new Date(soon.getTime() + 1800_000),
        description: 'Join https://meet.google.com/abc-defg-hij',
    });
    t.eq(comp.joinURL, 'https://meet.google.com/abc-defg-hij', 'join link from notes');
    t.eq(eventFromComp({uid: 'y', summary: 'Gone', start: new Date(), end: new Date(), cancelled: true}), null, 'cancelled dropped');
    const when = new Date(Date.UTC(2026, 9, 25, 3, 0, 0));
    const until = new Date(when.getTime() + HOUR);
    t.eq(eventFromComp({uid: 'u1', summary: 'S', start: when, end: until}).id, `u1@${when.getTime() / 1000}`,
        'event id is uid@start seconds');
    t.eq(eventFromComp({uid: 'u1', rid: '20261025T030000Z', summary: 'S', start: when, end: until}).id,
        `u1:20261025T030000Z@${when.getTime() / 1000}`, 'a recurrence id makes each occurrence unique');
    const full = eventFromComp({uid: 'u2', summary: 'Plan', start: when, end: until, location: 'Room 3'});
    t.eq([full.title, full.start, full.end, full.joinURL], ['Plan', when, until, null], 'event fields come from the component');
    t.eq(eventFromComp({uid: 'u3', start: when, end: until}).title, '', 'a missing summary is an empty title');
    for (const flag of ['allDay', 'cancelled', 'transparent', 'declined'])
        t.eq(eventFromComp({uid: 'f', summary: 'F', start: when, end: until, [flag]: true}), null, `${flag} events are dropped`);
    t.check(eventFromComp({uid: 'f', summary: 'F', start: when, end: until, allDay: false, cancelled: false,
        transparent: false, declined: false}) !== null, 'false flags keep the event');
    t.eq(eventFromComp({uid: 'u4', summary: 'V', start: when, end: until, url: 'https://zoom.us/j/5'}).joinURL,
        'https://zoom.us/j/5', 'join link from the event URL');
    t.eq(eventFromComp({uid: 'u5', summary: 'V', start: when, end: until, location: 'https://teams.microsoft.com/l/x',
        description: 'https://zoom.us/j/5'}).joinURL, 'https://teams.microsoft.com/l/x', 'the location is searched before the notes');
    t.eq(eventFromComp({uid: 'u6', summary: 'V', start: when, end: until, url: 'https://example.com/e'}).joinURL,
        'https://example.com/e', 'a plain event URL is kept as the link, as in the Swift app');
    t.eq(eventFromComp({uid: 'u8', summary: 'V', start: when, end: until, url: 'file:///home/me/x.desktop'}).joinURL,
        null, 'an event URL that is not a web link gives no Join link');
    t.eq(eventFromComp({uid: 'u7', summary: 'V', start: 'noon', end: until}), null, 'a component without a real start is dropped');

    // --- Postponed tasks (DevTools.swift "Postponed tasks") ---
    t.eq(stuckDays(1, '2026-10-22', '2026-10-25'), 4, 'overdue 3 days = 4 days on the list');
    const tracker = new StuckTracker({});
    const task = new Task({id: 's', content: 'S', due: {date: '2026-10-25'}});
    for (const d of [-2, -1, 0, 0])
        tracker.record([task], new Date(now.getTime() + d * DAY));
    t.eq(tracker.stuck([task], 3, now)[0]?.days, 3, 'tracker counts distinct days');

    // --- stuckDays ---
    t.eq([stuckDays(2, null, '2026-10-25'), stuckDays(2, '2026-10-25', '2026-10-25'), stuckDays(2, '2026-10-26', '2026-10-25')],
        [2, 2, 2], 'a task that is not overdue keeps the days we saw');
    t.eq(stuckDays(9, '2026-10-22', '2026-10-25'), 9, 'the larger of seen days and overdue days wins');
    t.eq(stuckDays(0, '2026-10-24', '2026-10-25'), 2, 'one day overdue is 2 days on the list');
    t.eq(stuckDays(0, '2026-09-30', '2026-10-02'), 3, 'overdue days count across months');

    // --- StuckTracker ---
    const T0 = now;
    const mk = (id, extra = {}) => new Task({id, content: id, due: {date: '2026-10-25'}, ...extra});
    const tr = new StuckTracker({});
    t.eq(tr.seenDays('nope'), 0, 'an unseen task was seen 0 days');
    tr.record([mk('a'), mk('b')], T0);
    tr.record([mk('a')], T0);
    t.eq([tr.seenDays('a'), tr.seenDays('b')], [1, 1], 'recording twice on the same day counts once');
    tr.record([mk('a')], new Date(T0.getTime() + DAY));
    t.eq([tr.seenDays('a'), tr.seenDays('b')], [2, 1], 'a new day counts again');

    const rec = new StuckTracker({});
    rec.record([mk('r', {due: {date: '2026-10-25', isRecurring: true}})], T0);
    t.eq(rec.seenDays('r'), 0, 'recurring tasks are never tracked');

    const old = new StuckTracker({});
    old.record([mk('old')], new Date(T0.getTime() - 22 * DAY));
    old.record([mk('mid')], new Date(T0.getTime() - 21 * DAY));
    old.record([mk('new')], T0);
    t.eq([old.seenDays('old'), old.seenDays('mid'), old.seenDays('new')], [0, 1, 1],
        'tasks not seen for more than 21 days are forgotten');

    const cap = new StuckTracker({});
    for (let i = 40; i >= 0; i--)
        cap.record([mk('cap')], new Date(T0.getTime() - i * DAY));
    t.eq(cap.seenDays('cap'), 30, 'a task seen every day keeps its last 30 days');
    const many = new StuckTracker({});
    many.pretend('many', 40, T0);
    many.record([mk('many')], new Date(T0.getTime() + DAY));
    t.eq(many.seenDays('many'), 30, 'at most 30 days are kept per task');

    const pre = new StuckTracker({});
    pre.pretend('p', 5, T0);
    t.eq(pre.seenDays('p'), 5, 'pretend fills the history');
    t.eq(pre.stuck([mk('p')], 5, T0).map(x => x.days), [5], 'pretended days make a task stuck');
    pre.record([mk('p')], T0);
    t.eq(pre.seenDays('p'), 5, 'pretend ends with today, so recording today adds nothing');
    pre.pretend('p', 0, T0);
    t.eq(pre.seenDays('p'), 0, 'pretend with 0 days clears the history');

    const sorted = new StuckTracker({});
    sorted.pretend('x1', 3, T0);
    sorted.pretend('x2', 6, T0);
    sorted.pretend('x3', 4, T0);
    sorted.pretend('x4', 3, T0);
    const list = [mk('x1'), mk('x2'), mk('x3'), mk('x4'), mk('x5'), mk('x6', {due: {date: '2026-10-25', isRecurring: true}})];
    t.eq(sorted.stuck(list, 3, T0).map(x => [x.task.id, x.days]), [['x2', 6], ['x3', 4], ['x1', 3], ['x4', 3]],
        'stuck tasks are sorted by days, longest first, and short or recurring ones are left out');
    t.eq(sorted.stuck(list, 1, T0).map(x => x.task.id), ['x2', 'x3', 'x1', 'x4'], 'a task never seen has 0 days, below minDays 1');
    t.eq(sorted.stuck(list, 0, T0).map(x => [x.task.id, x.days]),
        [['x2', 6], ['x3', 4], ['x1', 3], ['x4', 3], ['x5', 0]], 'minDays 0 includes tasks never seen, but not recurring ones');
    t.eq(sorted.stuck([mk('late', {due: {date: '2026-10-20'}})], 3, T0).map(x => x.days), [6],
        'an overdue task is stuck for as long as it has been overdue');

    // --- StuckTracker persistence ---
    const store = memoryStore();
    const saved = new StuckTracker({store});
    await saved.load();
    saved.record([mk('a'), mk('b')], T0);
    t.eq(store.saves.length, 1, 'recording a new day saves once');
    t.eq(store.saves[0][0], 'stuck', 'the tracker saves under the name stuck');
    const todayKey = dayKey(T0);
    t.eq(store.saves[0][1], {seen: {a: [todayKey], b: [todayKey]}}, 'the saved form lists the days seen per task');
    saved.record([mk('a')], T0);
    t.eq(store.saves.length, 1, 'recording nothing new does not save');
    saved.pretend('c', 2, T0);
    t.eq(store.saves.length, 1, 'pretend only changes memory, as in the Swift app');
    const loaded = new StuckTracker({store});
    await loaded.load();
    t.eq([loaded.seenDays('a'), loaded.seenDays('b'), loaded.seenDays('c')], [1, 1, 0], 'a new tracker loads what was saved');

    const junk = new StuckTracker({store: memoryStore({stuck: {seen: {ok: ['2026-10-25', 7, null], bad: 'x', worse: {a: 1}}}})});
    await junk.load();
    t.eq([junk.seenDays('ok'), junk.seenDays('bad'), junk.seenDays('worse')], [1, 0, 0], 'bad entries in the file are ignored');
    for (const value of [null, 'text', 5, [], {seen: 3}, {seen: null}, {other: {a: ['2026-10-25']}}]) {
        const tracker2 = new StuckTracker({store: memoryStore({stuck: value})});
        await tracker2.load();
        t.eq(tracker2.seenDays('a'), 0, `an unusable file ${JSON.stringify(value)} loads as empty`);
    }

    const proto = new StuckTracker({store: memoryStore()});
    proto.record([mk('__proto__'), mk('constructor')], T0);
    t.eq([proto.seenDays('__proto__'), proto.seenDays('constructor'), proto.seenDays('toString')], [1, 1, 0],
        'task ids that look like object keys are safe');
    const protoStore = memoryStore();
    const proto2 = new StuckTracker({store: protoStore});
    proto2.record([mk('__proto__')], T0);
    const proto3 = new StuckTracker({store: protoStore});
    await proto3.load();
    t.eq(proto3.seenDays('__proto__'), 1, 'a task id of __proto__ survives a save and load');

    const failing = {
        load: async () => null,
        save() {
            throw new Error('disk full');
        },
    };
    const errors = [];
    const unlucky = new StuckTracker({store: failing, onSaveError: e => errors.push(e.message)});
    unlucky.record([mk('a')], T0);
    t.eq([unlucky.seenDays('a'), errors], [1, ['disk full']], 'a store that cannot save does not break the tracker');
    const rejecting = {
        load: async () => null,
        save: async () => {
            throw new Error('async fail');
        },
    };
    const errors2 = [];
    const unlucky2 = new StuckTracker({store: rejecting, onSaveError: e => errors2.push(e.message)});
    unlucky2.record([mk('a')], T0);
    await Promise.resolve();
    await Promise.resolve();
    t.eq(errors2, ['async fail'], 'a rejected save is reported');
    await t.rejects(new StuckTracker({store: {load: async () => {
        throw new Error('unreadable');
    }}}).load(), e => e.message === 'unreadable', 'a store that cannot read fails the load');
    const bare = new StuckTracker({});
    await bare.load();
    t.eq(bare.seenDays('a'), 0, 'a tracker without a store loads nothing');

    // --- Distracting sites by window title ---
    const rules = ['youtube.com', 'x.com', 'vnexpress.net', 'youtube.com/shorts'];
    t.eq(matchTitle('Lofi beats - YouTube — Mozilla Firefox', ['youtube.com']), 'youtube.com', 'brand in title');
    t.eq(matchTitle('Home / X - Google Chrome', rules), 'x.com', 'X by its title suffix');
    t.eq(matchTitle('Tin mới - VnExpress — Mozilla Firefox', rules), 'vnexpress.net', 'unknown domain by its label');
    t.eq(matchTitle('YouTubers notes - Google Docs', ['youtube.com']), null, 'whole words only');
    t.eq(matchTitle('Cat #shorts - YouTube', ['youtube.com/shorts']), 'youtube.com/shorts', 'path rule needs the segment');
    t.eq(matchTitle('Lofi - YouTube', ['youtube.com/shorts']), null, 'path rule without the segment');
    t.check(isBrowser('firefox') && isBrowser('Google-chrome') && !isBrowser('gnome-terminal-server'), 'browser classes');

    t.eq(titleKeywords('youtube.com/shorts'), {words: ['YouTube'], path: 'shorts'}, 'keywords of a path rule');
    t.eq(titleKeywords('youtube.com'), {words: ['YouTube'], path: null}, 'a plain rule has no path');
    t.eq([
        'facebook.com', 'tiktok.com', 'instagram.com', 'x.com', 'reddit.com', 'netflix.com',
    ].map(r => titleKeywords(r).words), [
        ['Facebook'], ['TikTok'], ['Instagram'], ['/ X', 'Twitter'], ['Reddit'], ['Netflix'],
    ], 'known brands map to the names that appear in titles');
    t.eq(titleKeywords('vnexpress.net'), {words: ['vnexpress'], path: null}, 'an unknown domain uses its label before the TLD');
    t.eq(titleKeywords('tuoitre.vn').words, ['tuoitre'], 'a two-letter TLD');
    t.eq(titleKeywords('dantri.com.vn').words, ['dantri'], 'a compound TLD like com.vn uses the label before it');
    t.eq(titleKeywords('bbc.co.uk').words, ['bbc'], 'a compound TLD like co.uk uses the label before it');
    t.eq(titleKeywords('news.ycombinator.com').words, ['ycombinator'], 'subdomains of an unknown domain are ignored');
    t.eq(titleKeywords('old.reddit.com').words, ['Reddit'], 'subdomains of a known brand map to the brand');
    t.eq(titleKeywords('www.youtube.com').words, ['YouTube'], 'www is ignored');
    t.eq(titleKeywords('https://www.YouTube.com/Shorts/').path, 'shorts', 'the scheme, case and a closing slash are ignored');
    t.eq(titleKeywords('reddit.com/r/funny'), {words: ['Reddit'], path: 'funny'}, 'the last path segment is used');
    t.eq(titleKeywords('youtube.com/watch?v=1#t').path, 'watch', 'a query or fragment is not part of the path');
    t.eq(titleKeywords('localhost:3000').words, ['localhost'], 'a single label is used as it is');
    t.eq(titleKeywords('twitter.com').words, ['twitter'], 'a domain that is not in the brand list uses its label');
    t.eq([titleKeywords('').words, titleKeywords('/shorts').words, titleKeywords(null).words, titleKeywords('  ').words],
        [[], [], [], []], 'a rule without a domain has no words');
    t.eq(titleKeywords('constructor.com').words, ['constructor'], 'brand lookup ignores object prototype names');

    t.eq(matchTitle('LOFI - YOUTUBE', ['youtube.com']), 'youtube.com', 'matching ignores case');
    t.eq(matchTitle('Tin moi - vnexpress', ['VnExpress.net']), 'VnExpress.net', 'rules are matched in any case and returned as given');
    t.eq(matchTitle('Watch (YouTube)', ['youtube.com']), 'youtube.com', 'punctuation around the word is fine');
    t.eq(matchTitle('YouTube2', ['youtube.com']), null, 'a digit after the word breaks the whole-word match');
    t.eq(matchTitle('2YouTube', ['youtube.com']), null, 'a digit before the word breaks the whole-word match');
    t.eq(matchTitle('Món ăn - Món ăn ngon', ['ăn.vn']), 'ăn.vn', 'letters outside ASCII count as letters');
    t.eq(matchTitle('Box X marks the spot - Google Chrome', ['x.com']), null, 'x.com needs the slash before the X');
    t.eq(matchTitle('Elon on Twitter - Brave', ['x.com']), 'x.com', 'x.com also matches Twitter');
    t.eq(matchTitle('/ X', ['x.com']), 'x.com', 'the X title at the end of a window title');
    t.eq(matchTitle('Hello', ['x.com']), null, 'x.com does not match a lone letter x');
    t.eq(matchTitle('Fun (r) - Reddit', ['reddit.com/r/funny']), null, 'a path rule needs its segment as a word');
    t.eq(matchTitle('r/funny - Reddit', ['reddit.com/r/funny']), 'reddit.com/r/funny', 'a path rule with its segment');
    t.eq(matchTitle('Cat #shorts', ['youtube.com/shorts']), null, 'a path rule needs the domain name too');
    t.eq(matchTitle('YouTube Shorts', ['youtube.com/shorts']), 'youtube.com/shorts', 'path word in the title text');
    t.eq(matchTitle('Cat #shorts - YouTube', rules), 'youtube.com', 'the first rule that matches wins, in list order');
    t.eq(matchTitle('Cat #shorts - YouTube', ['youtube.com/shorts', 'youtube.com']), 'youtube.com/shorts',
        'list order decides between a path rule and a plain rule');
    t.eq(matchTitle('Cat #shorts - YouTube', ['youtube.com', 'youtube.com/shorts']), 'youtube.com',
        'the plain rule first matches first');
    t.eq(matchTitle('Hello', []), null, 'no rules, no match');
    t.eq([matchTitle('', ['youtube.com']), matchTitle(null, ['youtube.com']), matchTitle('YouTube', null)],
        [null, null, null], 'an empty title or no rules matches nothing');
    t.eq(matchTitle('YouTube', ['', '/shorts', 5, null, 'youtube.com']), 'youtube.com', 'unusable rules are skipped');
    t.eq(matchTitle('Sitee is here', ['site+.com']), null, 'regex characters in a rule are taken literally');
    t.eq(matchTitle('Site+ is here', ['site+.com']), 'site+.com', 'a rule with a plus matches the plus literally');

    // --- The browser's own name in the window title must not count as page text ---
    const ZW = '\u200B'; // Edge writes "Microsoft<ZWSP> Edge"
    const browserTitles = [
        ['Inbox (3) - Gmail - Google Chrome', 'mail.google.com'],
        ['Inbox - Google Chrome', 'google.com'],
        ['Inbox - Google Chrome', 'chrome.com'],
        ['Docs \u2014 Mozilla Firefox', 'mozilla.org'],
        ['Docs \u2014 Mozilla Firefox', 'firefox.com'],
        [`Chat - Microsoft${ZW} Edge`, 'teams.microsoft.com'],
        [`Chat - Microsoft${ZW} Edge`, 'edge.com'],
        ['Chat - Microsoft Edge', 'microsoft.com'],
        ['News - Opera', 'opera.com'],
        ['News - Brave', 'brave.com'],
        ['Docs - Chromium', 'chromium.org'],
        ['News - Vivaldi', 'vivaldi.com'],
        ['Inbox - Google Chrome - Work', 'google.com'],
        ['Inbox - Google Chrome \u2013 Person 1', 'google.com'],
        ['Docs \u2014 Mozilla Firefox Private Browsing', 'mozilla.org'],
        [`Page and 5 more pages - Personal - Microsoft${ZW} Edge`, 'microsoft.com'],
        ['Tin m\u1EDBi - C\u1ED1c C\u1ED1c', 'coc.vn'],
        ['Mozilla Firefox', 'mozilla.org'],
        ['Mozilla Firefox Private Browsing', 'firefox.com'],
        ['Google Chrome', 'google.com'],
    ];
    for (const [title, rule] of browserTitles)
        t.eq(matchTitle(title, [rule]), null, `the browser's own name in ${JSON.stringify(title)} is not matched by ${rule}`);
    t.eq(matchTitle('Tin m\u1EDBi - Co\u0302\u0301c Co\u0302\u0301c', ['c\u1ED1c.vn']), null,
        'the Coc Coc name is found in decomposed form too');

    t.eq(matchTitle('Lofi - YouTube - Google Chrome - Work', ['youtube.com']), 'youtube.com',
        'the page is still matched when the browser adds a profile name');
    t.eq(matchTitle(`Lofi - YouTube - Microsoft${ZW} Edge`, ['youtube.com']), 'youtube.com', 'the page is still matched in Edge');
    t.eq(matchTitle('Lofi \u2014 YouTube \u2014 Mozilla Firefox Private Browsing', ['youtube.com']), 'youtube.com',
        'the page is still matched in a private Firefox window');
    t.eq(matchTitle('Gin - Opera - YouTube \u2014 Mozilla Firefox', ['youtube.com']), 'youtube.com',
        'only the last browser name is cut, a page title with a browser name inside keeps its end');
    t.eq(matchTitle('Opera tickets - Ticketbox', ['opera.com']), 'opera.com', 'a page about Opera is still matched');
    t.eq(matchTitle('Brave New World trailer - YouTube', ['youtube.com']), 'youtube.com',
        'a title that starts like a browser name is left alone');
    t.eq(matchTitle('Watch Brave New World - YouTube - Brave', ['brave.com']), 'brave.com',
        'the page text is matched even when it says the browser name');
    t.eq(matchTitle('Calendar - Google Chrome', ['google.com', 'chrome.com']), null, 'no rule matches the name of the browser');
    t.eq(matchTitle('Mail - Google Chrome', ['mail.com']), 'mail.com', 'a rule that matches the page text still matches');

    t.eq([
        'Inbox - Google Chrome', 'Inbox - Google Chrome - Work', 'Inbox \u2014 Mozilla Firefox', 'Inbox \u2013 Firefox Developer Edition',
        `Inbox - Microsoft${ZW} Edge`, 'Inbox - Opera', 'Inbox - Brave', 'Inbox - Chromium', 'Inbox - Vivaldi', 'Inbox - C\u1ED1c C\u1ED1c',
        'Inbox - google chrome',
    ].map(stripBrowserName), new Array(11).fill('Inbox'), 'the browser name and what follows it are cut from the title');
    t.eq(['Mozilla Firefox', 'Google Chrome', 'Mozilla Firefox Private Browsing', 'Mozilla Firefox (Private Browsing)']
        .map(stripBrowserName), ['', '', '', ''], 'a title that is only the browser name becomes empty');
    t.eq(['Lofi - YouTube', 'Opera tickets', 'Brave New World', 'Inbox - Operatic', 'Inbox - Bravery', 'Google Docs', '']
        .map(stripBrowserName), ['Lofi - YouTube', 'Opera tickets', 'Brave New World', 'Inbox - Operatic', 'Inbox - Bravery',
        'Google Docs', ''], 'titles without a browser name stay as they are');
    t.eq(stripBrowserName('Gin - Opera - YouTube - Opera'), 'Gin - Opera - YouTube', 'only the last browser name is cut');
    t.eq(stripBrowserName('Inbox\u00A0- Google Chrome'), 'Inbox', 'a non-breaking space before the dash still counts as a separator');

    t.eq(['firefox', 'Firefox', 'org.mozilla.firefox', 'Google-chrome', 'google-chrome-beta', 'chromium', 'Chromium-browser',
        'brave-browser', 'Brave-browser', 'microsoft-edge', 'vivaldi-stable', 'opera', 'coccoc'].map(isBrowser),
    new Array(13).fill(true), 'browser classes match by lower-case prefix');
    t.eq(['gnome-terminal-server', 'code', 'org.gnome.Nautilus', '', null, undefined, 5, 'my-firefox'].map(isBrowser),
        new Array(8).fill(false), 'other windows are not browsers');
}
