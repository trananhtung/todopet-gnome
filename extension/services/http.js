// HTTP for the clients, over libsoup 3 and never blocking GNOME Shell: every request is an async Soup call.
// The clients (todoist.js, claude.js) only need `request({method, url, headers, body}) -> {status, text}`,
// so tests hand them a scripted stand-in instead (tests/helpers.js FakeTransport).
// Imports only gi:// modules, so it also runs in the plain-gjs tests.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const DEFAULT_TIMEOUT_SECONDS = 20;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function networkError(message) {
    const error = new Error(message);
    error.name = 'NetworkError';
    return error;
}

// `text` with every copy of `secret` replaced, so an error message can carry a server's reply without
// ever carrying the token or API key the server may have echoed back.
export function redact(text, secret) {
    return secret ? text.split(secret).join('***') : text;
}

export class SoupTransport {
    // One Soup.Session per transport. `timeout` is libsoup's socket timeout in seconds (connecting, and
    // waiting for the next bytes of a reply).
    constructor({timeout = DEFAULT_TIMEOUT_SECONDS} = {}) {
        this._session = new Soup.Session({timeout});
    }

    // Sends one request; resolves with {status, text} for any HTTP status (the caller decides what an
    // error status means). `body` is a JSON string or null. A failure to reach the server, a TLS failure,
    // a timeout, an invalid url or an abort() rejects with an Error named 'NetworkError'.
    async request({method, url, headers = {}, body = null}) {
        const message = Soup.Message.new(method, url);
        if (message === null)
            throw networkError(`Invalid URL: ${url}`);
        for (const [name, value] of Object.entries(headers))
            message.request_headers.append(name, value);
        if (body !== null)
            message.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(body)));

        let bytes;
        try {
            bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        } catch (e) {
            throw networkError(e?.message ?? String(e));
        }
        return {status: message.get_status(), text: decoder.decode(bytes.get_data() ?? new Uint8Array())};
    }

    // Cancels every request in flight (they reject with a NetworkError). For disable(): nothing may
    // still be running once the extension is off.
    abort() {
        this._session.abort();
    }
}
