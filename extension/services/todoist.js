// Todoist API v1 (https://developer.todoist.com/api/v1/): port of TodoistClient and TodoError from TodoService.swift.
// The brain talks to the TodoService interface that this class and services/demo.js both implement:
//   activeTasks(filter), completedTasks(since, until), stats(), addTask({content, dueString, priority, parentId}),
//   quickAdd(text), close(id), reopen(id), reschedule(id, dueString), delete(id)
// Every failure is a TodoError. Imports only gi:// modules and core/ files, so it also runs in the plain-gjs tests.
import GLib from 'gi://GLib';

import {utcString} from '../core/dates.js';
import {L} from '../core/l10n.js';
import {Task, statsFromApi} from '../core/models.js';
import {SoupTransport, redact} from './http.js';

const BASE = 'https://api.todoist.com/api/v1/';
const PAGE_LIMIT = 200;
const MAX_PAGES = 10;
const BODY_CHARS = 200;

function describe(kind, status, body, detail) {
    switch (kind) {
    case 'unauthorized':
        return L('Token Todoist không hợp lệ hoặc đã hết hạn.', 'The Todoist token is invalid or expired.');
    case 'rateLimited':
        return L('Todoist đang giới hạn tốc độ, thử lại sau ít phút.', 'Todoist is rate limiting, retrying in a few minutes.');
    case 'http':
        return `HTTP ${status}: ${body}`;
    default:
        return L('Lỗi mạng: ', 'Network error: ') + detail;
    }
}

export class TodoError extends Error {
    // kind: 'unauthorized' (401) | 'rateLimited' (429) | 'http' (any other status, or a reply that cannot be read;
    // `status` and the first 200 characters of the reply in `body`) | 'network' (`detail` is the cause).
    constructor(kind, {status = null, body = '', detail = ''} = {}) {
        super(describe(kind, status, body, detail));
        this.name = 'TodoError';
        this.kind = kind;
        this.status = status;
        this.body = body;
        this.detail = detail;
    }

    // The text to show the user, in the language that is current now.
    get userMessage() {
        return describe(this.kind, this.status, this.body, this.detail);
    }
}

// base + path + "?k=v&..." with the keys sorted and the values percent-encoded; no query, no "?".
function buildUrl(path, query) {
    const pairs = Object.keys(query).sort().map(key => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`);
    return BASE + path + (pairs.length > 0 ? `?${pairs.join('&')}` : '');
}

export class TodoistClient {
    // `warn(message)` receives the one-line notices (default: console.warn); tests pass their own.
    constructor(token, transport = new SoupTransport(), {warn = message => console.warn(message)} = {}) {
        this._token = token;
        this._transport = transport;
        this._warn = warn;
    }

    // Cancels requests in flight (call from disable()).
    abort() {
        this._transport.abort?.();
    }

    // Sends one request and returns {status, text} for a 2xx reply; anything else throws a TodoError.
    async _send(method, path, {query = {}, body = null} = {}) {
        const headers = {Authorization: `Bearer ${this._token}`};
        if (method !== 'GET')
            headers['X-Request-Id'] = GLib.uuid_string_random();
        let payload = null;
        if (body !== null) {
            payload = JSON.stringify(body);
            headers['Content-Type'] = 'application/json';
        }
        let response;
        try {
            response = await this._transport.request({method, url: buildUrl(path, query), headers, body: payload});
        } catch (e) {
            throw new TodoError('network', {detail: redact(e?.message ?? String(e), this._token)});
        }
        const {status} = response;
        if (status >= 200 && status < 300)
            return response;
        if (status === 401)
            throw new TodoError('unauthorized', {status});
        if (status === 429)
            throw new TodoError('rateLimited', {status});
        throw this._httpError(response);
    }

    _httpError({status, text}) {
        return new TodoError('http', {status, body: redact(text, this._token).slice(0, BODY_CHARS)});
    }

    // The reply as a JSON object; text that is not an object is a TodoError (Swift's decode would fail).
    _readObject(response) {
        let json;
        try {
            json = JSON.parse(response.text);
        } catch {
            throw this._httpError(response);
        }
        if (json === null || typeof json !== 'object' || Array.isArray(json))
            throw this._httpError(response);
        return json;
    }

    // Every page of a task list: `results` (or `items`), then `next_cursor`, at most 10 pages of 200.
    // A task the app cannot read (no string id or content) is skipped instead of failing the whole page.
    async _paged(path, query) {
        const all = [];
        let skipped = 0;
        let cursor = null;
        for (let page = 0; page < MAX_PAGES; page++) {
            const pageQuery = {...query, limit: String(PAGE_LIMIT)};
            if (cursor !== null)
                pageQuery.cursor = cursor;
            const response = await this._send('GET', path, {query: pageQuery});
            const json = this._readObject(response);
            const list = json.results ?? json.items ?? [];
            if (!Array.isArray(list))
                throw this._httpError(response);
            for (const item of list) {
                try {
                    all.push(Task.fromApi(item));
                } catch (e) {
                    if (!(e instanceof TypeError))
                        throw e;
                    skipped += 1;
                }
            }
            const next = json.next_cursor;
            if (typeof next !== 'string' || next === '')
                break;
            cursor = next;
        }
        if (skipped > 0)
            this._warn(`Todoist: skipped ${skipped} task(s) that could not be read`);
        return all;
    }

    async activeTasks(filter) {
        return this._paged('tasks/filter', {query: filter});
    }

    async completedTasks(since, until) {
        return this._paged('tasks/completed/by_completion_date', {since: utcString(since), until: utcString(until)});
    }

    async stats() {
        return statsFromApi(this._readObject(await this._send('GET', 'tasks/completed/stats')));
    }

    // The new Task, or null when Todoist's reply cannot be read as one (the task was still added).
    async addTask({content, dueString = null, priority, parentId = null}) {
        const body = {content, priority};
        if (dueString !== null && dueString !== undefined) {
            body.due_string = dueString;
            body.due_lang = 'en';
        }
        if (parentId !== null && parentId !== undefined)
            body.parent_id = parentId;
        const response = await this._send('POST', 'tasks', {body});
        try {
            return Task.fromApi(JSON.parse(response.text));
        } catch {
            return null;
        }
    }

    async quickAdd(text) {
        await this._send('POST', 'tasks/quick', {body: {text}});
    }

    async close(id) {
        await this._send('POST', `tasks/${encodeURIComponent(id)}/close`);
    }

    async reopen(id) {
        await this._send('POST', `tasks/${encodeURIComponent(id)}/reopen`);
    }

    async reschedule(id, dueString) {
        await this._send('POST', `tasks/${encodeURIComponent(id)}`, {body: {due_string: dueString, due_lang: 'en'}});
    }

    // Permanent: Todoist deletes the task and its sub-tasks, and the API can't restore them.
    async delete(id) {
        await this._send('DELETE', `tasks/${encodeURIComponent(id)}`);
    }
}
