// Asks Claude to split a task you keep postponing into small first steps (port of ClaudeClient.swift).
// There is no SDK here: this calls the Messages API over HTTPS directly (libsoup, via services/http.js).
// Imports only gi:// modules and core/ files, so it also runs in the plain-gjs tests.
import {L} from '../core/l10n.js';
import {SoupTransport, redact} from './http.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS = 4000;
const MAX_STEPS = 6;
const BODY_CHARS = 300;
// The answer is one JSON object, which can take a while to write: wait longer than for Todoist.
const TIMEOUT_SECONDS = 90;

const SCHEMA = {
    type: 'object',
    properties: {steps: {type: 'array', items: {type: 'string'}}},
    required: ['steps'],
    additionalProperties: false,
};

function describe(kind, status, body, detail) {
    switch (kind) {
    case 'noKey':
        return L('Chưa có API key của Claude (thêm trong Cài đặt).', 'No Claude API key yet (add one in Settings).');
    case 'refused':
        return L('Claude từ chối yêu cầu này.', 'Claude declined this request.');
    case 'http':
        return `Claude API ${status}: ${body}`;
    case 'network':
        return L('Lỗi mạng: ', 'Network error: ') + detail;
    default:
        return L('Claude trả về dữ liệu không đọc được.', "Couldn't read Claude's answer.");
    }
}

export class ClaudeError extends Error {
    // kind: 'noKey' | 'refused' | 'http' (`status`, and the first 300 characters of the reply in `body`) |
    // 'network' (`detail` is the cause) | 'decoding' (the answer was not the expected JSON).
    constructor(kind, {status = null, body = '', detail = ''} = {}) {
        super(describe(kind, status, body, detail));
        this.name = 'ClaudeError';
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

// The request exactly as ClaudeClient.swift sends it: {method, url, headers, body (a JSON string)}.
export function buildBreakdownRequest({key, model, title, notes}) {
    const system = L(
        'Bạn giúp người dùng bắt đầu một việc họ cứ trì hoãn. Chia việc thành 3–5 bước cụ thể, mỗi bước làm xong trong 15–30 phút, bắt đầu bằng động từ, dưới 70 ký tự. Bước đầu tiên phải là bước dễ nhất để bắt tay vào ngay. Viết bằng tiếng Việt.',
        'You help someone start a task they keep postponing. Split it into 3–5 concrete steps, each doable in 15–30 minutes, starting with a verb, under 70 characters. The first step must be the easiest one to start right away. Write in English.');
    let prompt = L('Việc: ', 'Task: ') + title;
    if (notes)
        prompt += `\n${L('Ghi chú: ', 'Notes: ')}${notes}`;

    const body = {
        model,
        max_tokens: MAX_TOKENS,
        // On a safety decline, let the API retry on its recommended fallback model.
        fallbacks: 'default',
        output_config: {effort: 'low', format: {type: 'json_schema', schema: SCHEMA}},
        system,
        messages: [{role: 'user', content: prompt}],
    };
    return {
        method: 'POST',
        url: MESSAGES_URL,
        headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'server-side-fallback-2026-07-01',
        },
        body: JSON.stringify(body),
    };
}

// Swift's whitespacesAndNewlines: Unicode spaces, tab to carriage return, and NEL.
const trimSpace = s => s.replace(/^[\p{Z}\t-\r\u0085]+|[\p{Z}\t-\r\u0085]+$/gu, '');

// Reads `{"steps": [...]}` from the first text block of a Messages API response (`text` is the whole
// response body). At most 6 steps; blank ones are dropped. Throws ClaudeError 'refused' when Claude declined
// and 'decoding' for anything else that is not the expected shape.
export function parseSteps(text) {
    const bad = () => new ClaudeError('decoding');
    const isText = v => v === undefined || v === null || typeof v === 'string';
    let response;
    try {
        response = JSON.parse(text);
    } catch {
        throw bad();
    }
    if (response === null || typeof response !== 'object' || !Array.isArray(response.content) || !isText(response.stop_reason))
        throw bad();
    if (!response.content.every(block => block !== null && typeof block === 'object' && typeof block.type === 'string' && isText(block.text)))
        throw bad();
    if (response.stop_reason === 'refusal')
        throw new ClaudeError('refused');

    const block = response.content.find(b => b.type === 'text');
    if (typeof block?.text !== 'string')
        throw bad();
    let answer;
    try {
        answer = JSON.parse(block.text);
    } catch {
        throw bad();
    }
    if (answer === null || typeof answer !== 'object' || !Array.isArray(answer.steps) || !answer.steps.every(s => typeof s === 'string'))
        throw bad();
    const clean = answer.steps.map(trimSpace).filter(step => step !== '');
    if (clean.length === 0)
        throw bad();
    return clean.slice(0, MAX_STEPS);
}

export class ClaudeClient {
    constructor(key, model, transport = new SoupTransport({timeout: TIMEOUT_SECONDS})) {
        this._key = typeof key === 'string' ? key.trim() : '';
        this._model = model || DEFAULT_CLAUDE_MODEL;
        this._transport = transport;
    }

    // Cancels a request in flight (call from disable()).
    abort() {
        this._transport.abort?.();
    }

    // 3-5 first steps for the task. Throws ClaudeError (never with the API key in its message).
    async breakdown(title, notes = null) {
        if (this._key === '')
            throw new ClaudeError('noKey');
        const request = buildBreakdownRequest({key: this._key, model: this._model, title, notes});
        let response;
        try {
            response = await this._transport.request(request);
        } catch (e) {
            throw new ClaudeError('network', {detail: redact(e?.message ?? String(e), this._key)});
        }
        if (response.status < 200 || response.status >= 300)
            throw new ClaudeError('http', {status: response.status, body: redact(response.text, this._key).slice(0, BODY_CHARS)});
        return parseSteps(response.text);
    }
}
