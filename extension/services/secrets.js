// The Todoist token and the Anthropic key live in GNOME Keyring (through libsecret), never in GSettings or a file.
// Each secret is one keyring item with the attribute item=<name>, in the default keyring. All calls are async.
// They fail (the promise rejects) when the Secret Service cannot be reached or the keyring is refused, so the caller
// can tell "no secret" (null) from "keyring not available".
//
// This file needs gir1.2-secret-1, which GNOME Shell does not depend on: the extension (ui/app.js) and the settings
// window load it with import() on first use, and the item names live in core/secretNames.js. Importing it makes no
// libsecret object; the schema is made by the first call.
import Gio from 'gi://Gio';
import Secret from 'gi://Secret';

import {SECRET_ANTHROPIC, SECRET_TODOIST} from '../core/secretNames.js';

// libsecret's functions are plain functions of the module, so their `_finish` is found there.
Gio._promisify(Secret, 'password_store', 'password_store_finish');
Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
Gio._promisify(Secret, 'password_clear', 'password_clear_finish');

let schema = null;

// The keyring schema of TodoPet's items, made on first use.
export function secretSchema() {
    schema ??= new Secret.Schema(
        'org.gnome.shell.extensions.todopet.Secret',
        Secret.SchemaFlags.NONE,
        {item: Secret.SchemaAttributeType.STRING});
    return schema;
}

// For the tests: whether secretSchema() has made the schema yet (importing this file must not).
export const _schemaCreated = () => schema !== null;

// What the keyring shows for an item (in Seahorse, for example).
const LABELS = {
    [SECRET_TODOIST]: 'TodoPet: Todoist token',
    [SECRET_ANTHROPIC]: 'TodoPet: Anthropic key',
};

function checkItem(item) {
    if (typeof item !== 'string' || item === '')
        throw new TypeError(`Not a secret name: ${JSON.stringify(item)}`);
}

// The secret stored under `item`, or null when there is none.
export async function lookupSecret(item) {
    checkItem(item);
    return await Secret.password_lookup(secretSchema(), {item}, null) ?? null;
}

// Stores `value` under `item`, replacing the one that was there. An empty value is refused: use clearSecret().
export async function storeSecret(item, value) {
    checkItem(item);
    if (typeof value !== 'string' || value === '')
        throw new TypeError('A secret is a non-empty string; use clearSecret() to remove one');
    await Secret.password_store(secretSchema(), {item}, Secret.COLLECTION_DEFAULT,
        LABELS[item] ?? `TodoPet: ${item}`, value, null);
}

// Removes the secret stored under `item` (fine when there is none).
export async function clearSecret(item) {
    checkItem(item);
    await Secret.password_clear(secretSchema(), {item}, null);
}
