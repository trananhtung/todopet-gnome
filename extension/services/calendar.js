// Today's meetings (replaces CalendarWatcher.swift / EventKit). Three sources, picked in this order:
//
//   demo    `demo-mode` on: the two sample meetings of services/demo.js; no D-Bus at all.
//   ecal    gir1.2-ecal-2.0 installed: Evolution Data Server through gi://ECal (async calls only). Events
//           keep their location, notes and URL, so join links are found (hasJoinLinks = true).
//   server  otherwise: the shell's own org.gnome.Shell.CalendarServer over D-Bus (the source of the top bar
//           calendar). It sends only titles and times (hasJoinLinks = false).
//
// With `use-calendar` off nothing is read and events() is empty. Events are refreshed every 10 minutes and at
// local midnight; the server source also follows the server's signals live. Emits 'changed' when the events
// may have changed.
//
// The calendar server has a single time window for all of its clients (properties Since/Until), and the top
// bar calendar sets it to the month grid it shows. So this source never sends a window that drops any part of
// the current one (planTimeRange): it widens it to also cover today when that stays small, and otherwise
// leaves it alone and keeps what it has (the top bar calendar asks for the current month again when it opens).
//
// Imports only GLib, Gio and plain-JS files (ECal is imported dynamically), so plain gjs can load it.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {eventFromComp, eventsFromServer} from '../core/calendarMath.js';
import {Emitter} from '../core/emitter.js';
import {dayKey} from '../core/dates.js';
import {demoEvents} from './demo.js';

const REFRESH_SECONDS = 10 * 60;
const DAY_MS = 86_400_000;
// The window is widened to cover today only while the result spans at most this many days; further away
// (the top bar calendar showing some month far from now) no call is made at all.
const MAX_WINDOW_DAYS = 100;
// ECal: how long a calendar backend may take to come online, and when to give up waiting for instances.
const ECAL_CONNECT_SECONDS = 10;
const ECAL_GIVE_UP_SECONDS = 30;
// ECal: registry changes (a calendar added, removed, switched off) are batched for this long.
const ECAL_SOURCES_SETTLE_SECONDS = 2;

// Values of the E_SOURCE_EXTENSION_* macros of libedataserver.
const EXTENSION_NAMES = Object.freeze({
    CALENDAR: 'Calendar', MAIL_IDENTITY: 'Mail Identity', WEBDAV_BACKEND: 'WebDAV Backend',
    AUTHENTICATION: 'Authentication', COLLECTION: 'Collection',
});

const SERVER_NAME = 'org.gnome.Shell.CalendarServer';
const SERVER_PATH = '/org/gnome/Shell/CalendarServer';
const SERVER_XML = `<node>
  <interface name="${SERVER_NAME}">
    <method name="SetTimeRange">
      <arg type="x" name="since" direction="in"/>
      <arg type="x" name="until" direction="in"/>
      <arg type="b" name="force_reload" direction="in"/>
    </method>
    <signal name="EventsAddedOrUpdated"><arg type="a(ssxxa{sv})" name="events"/></signal>
    <signal name="EventsRemoved"><arg type="as" name="ids"/></signal>
    <signal name="ClientDisappeared"><arg type="s" name="source_uid"/></signal>
    <property name="Since" type="x" access="read"/>
    <property name="Until" type="x" access="read"/>
    <property name="HasCalendars" type="b" access="read"/>
  </interface>
</node>`;

let serverInfo = null;
const serverInterface = () => (serverInfo ??= Gio.DBusNodeInfo.new_for_xml(SERVER_XML).interfaces[0]);

const isCancelled = e => e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

// [start, end) of the local calendar day of `date`, as Dates (daylight-saving safe).
export function dayBounds(date) {
    return [
        new Date(date.getFullYear(), date.getMonth(), date.getDate()),
        new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1),
    ];
}

const overlapsDay = (e, [start, end]) => e.start.getTime() < end.getTime() && e.end.getTime() > start.getTime();
const byStart = (a, b) => a.start.getTime() - b.start.getTime();

// The SetTimeRange call that gets us `today`'s events ([since, until] in epoch seconds) from the calendar
// server, or null for no call. `current` is the server's window ([Since, Until]; null or [0, 0] when nobody
// asked yet); `needsLoad` says we hold nothing yet. A planned window always contains all of `current`.
//   - no window yet: no call. The top bar calendar asks for its month as soon as the server appears, and
//     the reload that causes reaches us too.
//   - the window covers today: no call, unless nothing was loaded yet; then the same window, force_reload,
//     because the server sent its events before we listened.
//   - otherwise the union of both, when it spans at most MAX_WINDOW_DAYS (a new window makes the server send
//     everything, no force needed); no call when it would be wider.
export function planTimeRange(today, current, needsLoad) {
    if (!current || !(current[1] > current[0]))
        return null;
    const [since, until] = today;
    if (current[0] <= since && current[1] >= until)
        return needsLoad ? {since: current[0], until: current[1], force: true} : null;
    const union = {since: Math.min(since, current[0]), until: Math.max(until, current[1])};
    if ((union.until - union.since) * 1000 > MAX_WINDOW_DAYS * DAY_MS)
        return null;
    return {...union, force: false};
}

// The events the calendar server sent, by id. Ids are "<source uid>\n<event uid>\n<recurrence id>"; the
// update and removal rules are those of the shell's own DBusEventSource (ui/calendar.js): an update of one
// instance of a recurring event replaces the whole series, and removals match by id prefix.
export class ServerEvents {
    constructor() {
        this._events = new Map();
    }

    get size() {
        return this._events.size;
    }

    // `tuples` as in EventsAddedOrUpdated: [id, summary, startSeconds, endSeconds, extras]. Returns whether
    // anything changed.
    add(tuples) {
        if (tuples.length === 0)
            return false;
        const replaced = new Set();
        for (const tuple of tuples) {
            if (!Array.isArray(tuple))
                continue;
            const text = String(tuple[0]);
            if (text.endsWith('\n'))
                continue;
            const parent = text.slice(0, text.lastIndexOf('\n') + 1);
            if (!replaced.has(parent)) {
                replaced.add(parent);
                this._removeMatching(parent);
            }
        }
        // All-day events are dropped here, after their series was cleared above.
        for (const event of eventsFromServer(tuples))
            this._events.set(event.id, event);
        return true;
    }

    remove(ids) {
        let changed = false;
        for (const id of ids)
            changed = this._removeMatching(String(id)) || changed;
        return changed;
    }

    clientDisappeared(sourceUid) {
        return this._removeMatching(`${sourceUid}\n`);
    }

    clear() {
        this._events.clear();
    }

    // Drops the events that ended before `time`, so the cache does not grow day after day.
    prune(time) {
        for (const [id, event] of this._events) {
            if (event.end.getTime() < time.getTime())
                this._events.delete(id);
        }
    }

    forDay(day) {
        const bounds = dayBounds(day);
        return [...this._events.values()].filter(e => overlapsDay(e, bounds)).sort(byStart);
    }

    _removeMatching(prefix) {
        let changed = false;
        for (const id of [...this._events.keys()]) {
            if (id.startsWith(prefix))
                changed = this._events.delete(id) || changed;
        }
        return changed;
    }
}

// Loads gi://ECal and gi://EDataServer; null when gir1.2-ecal-2.0 is not installed.
async function loadEcal() {
    try {
        const [ECal, EDataServer, ICalGLib] = await Promise.all([
            import('gi://ECal?version=2.0'),
            import('gi://EDataServer?version=1.2'),
            import('gi://ICalGLib?version=3.0'),
        ]).then(modules => modules.map(m => m.default));
        return {ECal, EDataServer, ICalGLib};
    } catch {
        return null;
    }
}

// --- Source: org.gnome.Shell.CalendarServer ---

class ServerBackend {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._events = new ServerEvents();
        this._cancellable = new Gio.Cancellable();
        this._proxy = null;
        this._proxyIds = [];
        // True until we asked the server for its events once since it appeared (see planTimeRange).
        this._needsLoad = true;
    }

    start() {
        const cancellable = this._cancellable;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START, serverInterface(),
            SERVER_NAME, SERVER_PATH, SERVER_NAME, cancellable, (_source, result) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (e) {
                    if (!isCancelled(e))
                        console.warn(`TodoPet: no calendar server proxy: ${e.message}`);
                    return;
                }
                if (cancellable.is_cancelled())
                    return;
                this._proxy = proxy;
                this._proxyIds = [
                    proxy.connect('g-signal', (_p, _sender, name, params) => this._onSignal(name, params)),
                    proxy.connect('notify::g-name-owner', () => this._onOwner()),
                    // Someone else (the top bar calendar) moved the window: make sure it still covers today.
                    proxy.connect('g-properties-changed', () => this.refresh()),
                ];
                this.refresh();
            });
    }

    stop() {
        this._cancellable.cancel();
        for (const id of this._proxyIds)
            this._proxy.disconnect(id);
        this._proxyIds = [];
        this._proxy = null;
        this._events.clear();
        // A module outlives disable(): do not keep the interface description.
        serverInfo = null;
    }

    events(day) {
        return this._events.forDay(day);
    }

    info() {
        const proxy = this._proxy;
        if (!proxy)
            return null;
        const prop = name => proxy.get_cached_property(name)?.unpack() ?? null;
        return {owner: proxy.g_name_owner !== null, since: prop('Since'), until: prop('Until'), hasCalendars: prop('HasCalendars')};
    }

    // Asks the server for today's events when needed, never dropping any of its current window (planTimeRange).
    // Also runs whenever the window changes (g-properties-changed) and when the server appears.
    refresh() {
        const proxy = this._proxy;
        if (!proxy || proxy.g_name_owner === null)
            return;
        const today = dayBounds(new Date());
        this._events.prune(today[0]);
        const info = this.info();
        const current = info.since !== null && info.until !== null ? [info.since, info.until] : null;
        const plan = planTimeRange(today.map(d => Math.floor(d.getTime() / 1000)), current, this._needsLoad);
        if (!plan)
            return;
        this._needsLoad = false;
        const cancellable = this._cancellable;
        proxy.call('SetTimeRange', new GLib.Variant('(xxb)', [plan.since, plan.until, plan.force]),
            Gio.DBusCallFlags.NONE, -1, cancellable, (p, result) => {
                try {
                    p.call_finish(result);
                } catch (e) {
                    if (isCancelled(e))
                        return;
                    console.warn(`TodoPet: calendar server SetTimeRange failed: ${e.message}`);
                    this._needsLoad = true;
                }
            });
    }

    _onOwner() {
        // The server (re)started or went away: what we hold is stale either way. The proxy has already read the
        // new server's properties; while it has no window yet, refresh() waits for g-properties-changed.
        this._events.clear();
        this._needsLoad = true;
        this._onChanged();
        this.refresh();
    }

    _onSignal(name, params) {
        let changed = false;
        switch (name) {
        case 'EventsAddedOrUpdated':
            changed = this._events.add(params.deepUnpack()[0]);
            break;
        case 'EventsRemoved':
            changed = this._events.remove(params.deepUnpack()[0]);
            break;
        case 'ClientDisappeared':
            changed = this._events.clientDisappeared(params.deepUnpack()[0]);
            break;
        }
        if (changed)
            this._onChanged();
    }
}

// --- Source: Evolution Data Server through gi://ECal (gir1.2-ecal-2.0) ---
// Written against libecal 2.0 / libedataserver 1.2. Every call that talks to the backends is the async one;
// the instances of recurring events are expanded by ECal.Client.generate_instances.
// Exported for the tests, which run it with stand-ins (gir1.2-ecal-2.0 may not be installed).

export class EcalBackend {
    constructor({ECal, EDataServer, ICalGLib}, onChanged) {
        this._ECal = ECal;
        this._EDS = EDataServer;
        this._ICal = ICalGLib;
        this._onChanged = onChanged;
        this._cancellable = new Gio.Cancellable();
        this._registry = null;
        this._registryIds = [];
        this._clients = new Map(); // source uid -> ECal.Client
        this._connecting = new Map(); // source uid -> Promise<ECal.Client|null>
        this._warned = new Set(); // keys of the warnings already logged (one per calendar and kind)
        this._events = new Map(); // source uid -> CalEvent[] of the day asked for last
        this._sources = new Set(); // GLib source ids
        this._settleId = 0;
        this._generation = 0;
    }

    // Resolves once the registry is there; rejects when it cannot be created (the caller falls back to the server).
    async start() {
        const EDS = this._EDS;
        const registry = await new Promise((resolve, reject) => {
            EDS.SourceRegistry.new(this._cancellable, (_source, result) => {
                try {
                    resolve(EDS.SourceRegistry.new_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
        });
        if (this._cancellable.is_cancelled())
            return;
        this._registry = registry;
        for (const signal of ['source-added', 'source-removed', 'source-changed', 'source-enabled', 'source-disabled'])
            this._registryIds.push(this._registry.connect(signal, () => this._settle()));
        this.refresh();
    }

    stop() {
        this._cancellable.cancel();
        this._generation++;
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
        this._settleId = 0;
        for (const id of this._registryIds)
            this._registry.disconnect(id);
        this._registryIds = [];
        this._registry = null;
        this._clients.clear();
        this._connecting.clear();
        this._events.clear();
    }

    events(day) {
        const bounds = dayBounds(day);
        return [...this._events.values()].flat().filter(e => overlapsDay(e, bounds)).sort(byStart);
    }

    info() {
        return {calendars: this._clients.size};
    }

    refresh() {
        if (!this._registry || this._cancellable.is_cancelled())
            return;
        const generation = ++this._generation;
        const sources = this._registry.list_enabled(this._ext('CALENDAR'))
            .filter(s => s.get_extension(this._ext('CALENDAR')).get_selected());
        const uids = new Set(sources.map(s => s.get_uid()));
        let dropped = false;
        for (const uid of [...this._events.keys(), ...this._clients.keys()]) {
            if (!uids.has(uid)) {
                dropped = this._events.delete(uid) || dropped;
                this._clients.delete(uid);
            }
        }
        if (dropped)
            this._onChanged();
        const emails = this._myAddresses(sources);
        const [start, end] = dayBounds(new Date());
        for (const source of sources) {
            const uid = source.get_uid();
            this._client(source).then(client => {
                if (client && generation === this._generation)
                    this._generate(uid, client, start, end, emails, generation);
            }).catch(e => this._warnOnce(`${uid}:refresh`,
                `TodoPet: could not read calendar '${source.get_display_name()}': ${e?.message ?? e}`));
        }
    }

    // A registry change usually comes in bursts; refresh once it has settled.
    _settle() {
        if (this._settleId !== 0)
            return;
        this._settleId = this._addSource(GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, ECAL_SOURCES_SETTLE_SECONDS, () => {
            this._sources.delete(this._settleId);
            this._settleId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _addSource(id) {
        this._sources.add(id);
        return id;
    }

    // The connected client of `source` (connecting once), or null when it cannot connect (logged once).
    _client(source) {
        const uid = source.get_uid();
        if (this._clients.has(uid))
            return Promise.resolve(this._clients.get(uid));
        if (this._connecting.has(uid))
            return this._connecting.get(uid);
        const ECal = this._ECal;
        const cancellable = this._cancellable;
        const promise = new Promise(resolve => {
            ECal.Client.connect(source, ECal.ClientSourceType.EVENTS, ECAL_CONNECT_SECONDS, cancellable, (_s, result) => {
                try {
                    resolve(ECal.Client.connect_finish(result));
                } catch (e) {
                    if (!isCancelled(e))
                        this._warnOnce(uid, `TodoPet: calendar '${source.get_display_name()}' is unavailable: ${e.message}`);
                    resolve(null);
                }
            });
        }).then(client => {
            if (cancellable.is_cancelled())
                return null;
            this._connecting.delete(uid);
            if (client) {
                try {
                    client.set_default_timezone(ECal.util_get_system_timezone());
                } catch {
                    // Floating times are then read as UTC; nothing worse.
                }
                this._clients.set(uid, client);
            }
            return client;
        });
        this._connecting.set(uid, promise);
        return promise;
    }

    // Collects the day's instances of one calendar. generate_instances calls `cb` for every instance from one
    // callback on the main loop and gives no "done" signal, so the result is committed from an idle callback
    // after the first instance, or, when there is no instance at all, after ECAL_GIVE_UP_SECONDS.
    _generate(uid, client, start, end, emails, generation) {
        const found = [];
        let idleId = 0;
        let giveUpId = 0;
        let committed = false;
        const commit = () => {
            if (generation !== this._generation)
                return;
            committed = true;
            if (giveUpId !== 0) {
                GLib.source_remove(giveUpId);
                this._sources.delete(giveUpId);
                giveUpId = 0;
            }
            this._events.set(uid, [...found]);
            this._onChanged();
        };
        giveUpId = this._addSource(GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, ECAL_GIVE_UP_SECONDS, () => {
            this._sources.delete(giveUpId);
            giveUpId = 0;
            if (!committed && idleId === 0)
                commit();
            return GLib.SOURCE_REMOVE;
        }));
        const toSeconds = d => Math.floor(d.getTime() / 1000);
        client.generate_instances(toSeconds(start), toSeconds(end), this._cancellable, (icomp, instanceStart, instanceEnd) => {
            if (generation !== this._generation)
                return false;
            try {
                const event = this._instance(icomp, instanceStart, instanceEnd, emails);
                if (event)
                    found.push(event);
            } catch (e) {
                this._warnOnce(`${uid}:instance`, `TodoPet: skipped a calendar event: ${e.message}`);
            }
            if (idleId === 0) {
                idleId = this._addSource(GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._sources.delete(idleId);
                    idleId = 0;
                    commit();
                    return GLib.SOURCE_REMOVE;
                }));
            }
            return true;
        });
    }

    // One instance -> CalEvent (or null), through eventFromComp.
    _instance(icomp, instanceStart, instanceEnd, emails) {
        const ECal = this._ECal;
        const ICal = this._ICal;
        const comp = ECal.Component.new_from_icalcomponent(icomp.clone());
        if (!comp)
            return null;
        const zone = this._systemZone();
        const seconds = t => t.as_timet_with_zone(t.get_timezone() ?? zone);
        const declined = (comp.get_attendees() ?? []).some(a =>
            emails.has(String(a.get_value() ?? '').replace(/^mailto:/i, '').toLowerCase()) &&
            a.get_partstat() === ICal.ParameterPartstat.DECLINED);
        const recurrence = comp.get_recurid_as_string();
        return eventFromComp({
            uid: comp.get_uid(),
            rid: recurrence || null,
            summary: comp.get_summary()?.get_value() ?? '',
            start: new Date(seconds(instanceStart) * 1000),
            end: new Date(seconds(instanceEnd) * 1000),
            allDay: instanceStart.is_date(),
            cancelled: comp.get_status() === ICal.PropertyStatus.CANCELLED,
            transparent: comp.get_transparency() === ECal.ComponentTransparency.TRANSPARENT,
            declined,
            url: comp.get_url() ?? null,
            location: comp.get_location() ?? null,
            description: (comp.get_descriptions() ?? []).map(text => text.get_value()).join('\n'),
        });
    }

    _systemZone() {
        try {
            return this._ECal.util_get_system_timezone();
        } catch {
            return null;
        }
    }

    // The user's own addresses, to find their attendee entry: mail identities, plus the account e-mail and
    // user name of each calendar and of its account.
    _myAddresses(sources) {
        const emails = new Set();
        const add = value => {
            if (typeof value === 'string' && value.includes('@'))
                emails.add(value.toLowerCase());
        };
        const read = (source, extension, getter) => {
            try {
                if (source?.has_extension(extension))
                    add(source.get_extension(extension)[getter]());
            } catch {
                // An extension without that field: one address less to recognize.
            }
        };
        for (const identity of this._registry.list_sources(this._ext('MAIL_IDENTITY')))
            read(identity, this._ext('MAIL_IDENTITY'), 'get_address');
        for (const source of sources) {
            const parentUid = source.get_parent();
            const parent = parentUid ? this._registry.ref_source(parentUid) : null;
            for (const s of [source, parent]) {
                read(s, this._ext('WEBDAV_BACKEND'), 'get_email_address');
                read(s, this._ext('AUTHENTICATION'), 'get_user');
                read(s, this._ext('COLLECTION'), 'get_identity');
            }
        }
        return emails;
    }

    // EDataServer.SOURCE_EXTENSION_<name>, or its documented value should the constant not be in the typelib.
    _ext(name) {
        return this._EDS[`SOURCE_EXTENSION_${name}`] ?? EXTENSION_NAMES[name];
    }

    _warnOnce(key, message) {
        if (this._warned.has(key))
            return;
        this._warned.add(key);
        console.warn(message);
    }
}

export class CalendarSource extends Emitter {
    constructor(prefs) {
        super();
        this._prefs = prefs;
        this._prefsId = 0;
        this._sources = new Set(); // GLib source ids: the 10-minute refresh and the midnight one
        this._midnightId = 0;
        this._backend = null;
        this._backendKind = null; // 'ecal' | 'server' once a backend was started
        this._ecal = undefined; // the loaded ECal modules, null when not installed, undefined before trying
        this._demo = null; // {day, events}
        this._day = dayKey(new Date());
        this._generation = 0;
    }

    // 'demo', 'ecal', 'server', or 'off' (use-calendar is off).
    get kind() {
        if (!this._prefs.useCalendar)
            return 'off';
        if (this._prefs.demoMode)
            return 'demo';
        return this._backendKind ?? 'server';
    }

    // Whether events can carry a join link (the board hides the Join button otherwise).
    get hasJoinLinks() {
        return this.kind === 'demo' || this.kind === 'ecal';
    }

    async start() {
        if (this._prefsId !== 0)
            return;
        const generation = ++this._generation;
        this._prefsId = this._prefs.onChanged(name => {
            if (name === 'useCalendar' || name === 'demoMode')
                this._configure(generation).catch(e => console.error(`TodoPet: calendar setup failed: ${e.stack ?? e}`));
        });
        this._addSource(GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        }));
        this._scheduleMidnight();
        await this._configure(generation);
    }

    stop() {
        this._generation++;
        if (this._prefsId !== 0)
            this._prefs.disconnect(this._prefsId);
        this._prefsId = 0;
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
        this._midnightId = 0;
        this._stopBackend();
        this._demo = null;
    }

    // Timed, busy, not declined events overlapping the local day of `day`, sorted by start.
    // Demo events are returned whatever the day, like CalendarWatcher.demoEvents.
    events(day) {
        if (!this._prefs.useCalendar)
            return [];
        if (this._prefs.demoMode) {
            this._demo ??= {day: dayKey(new Date()), events: demoEvents(new Date())};
            return this._demo.events.map(e => ({...e}));
        }
        return this._backend?.events(day) ?? [];
    }

    // Reloads what the active source needs reloading; also called every 10 minutes and at midnight.
    refresh() {
        const today = dayKey(new Date());
        const newDay = today !== this._day;
        this._day = today;
        if (newDay && this._demo?.day !== today)
            this._demo = null;
        try {
            this._backend?.refresh();
        } catch (e) {
            // Runs from timers: a throw would remove the timer behind our back.
            console.error(`TodoPet: calendar refresh failed: ${e.stack ?? e}`);
        }
        if (newDay)
            this.emit('changed');
    }

    // Calendar server or ECal state, for diagnostics; null when no backend runs.
    serverInfo() {
        return this._backend ? {kind: this._backendKind, ...this._backend.info()} : null;
    }

    // Starts the backend the preferences ask for (none for demo or off), stopping the previous one.
    async _configure(generation) {
        this._stopBackend();
        this._demo = null;
        if (this._prefs.useCalendar && !this._prefs.demoMode) {
            if (this._ecal === undefined)
                this._ecal = await loadEcal();
            // stop(), or a newer _configure() that already did the work, may have run during the await.
            if (generation !== this._generation || this._backend || !this._prefs.useCalendar || this._prefs.demoMode)
                return;
            this._startBackend();
        }
        this.emit('changed');
    }

    _startBackend() {
        const onChanged = () => this.emit('changed');
        if (this._ecal) {
            const backend = new EcalBackend(this._ecal, onChanged);
            this._backend = backend;
            this._backendKind = 'ecal';
            backend.start().catch(e => {
                if (isCancelled(e) || this._backend !== backend)
                    return;
                console.warn(`TodoPet: Evolution Data Server is unavailable, using the calendar server: ${e.message}`);
                backend.stop();
                this._ecal = null;
                this._backend = null;
                this._startBackend();
                this.emit('changed');
            });
            return;
        }
        this._backend = new ServerBackend(onChanged);
        this._backendKind = 'server';
        this._backend.start();
    }

    _stopBackend() {
        this._backend?.stop();
        this._backend = null;
        this._backendKind = null;
    }

    _addSource(id) {
        this._sources.add(id);
        return id;
    }

    // One second past the next local midnight, then again every night.
    _scheduleMidnight() {
        const now = new Date();
        const next = dayBounds(now)[1];
        const seconds = Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000) + 1);
        this._midnightId = this._addSource(GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._sources.delete(this._midnightId);
            this._midnightId = 0;
            this.refresh();
            this._scheduleMidnight();
            return GLib.SOURCE_REMOVE;
        }));
    }
}
