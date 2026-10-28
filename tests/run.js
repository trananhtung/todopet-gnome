import System from 'system';

import {T} from './harness.js';

// Append new test modules here. Each one exports `default async function (t)`.
const TESTS = [
    './smoke.test.js',
    './core-basics.test.js',
    './models.test.js',
    './mood-calm.test.js',
    './life.test.js',
    './planning.test.js',
    './diary-lines.test.js',
    './store.test.js',
];

const t = new T();

for (const path of TESTS) {
    try {
        const mod = await import(path);
        await mod.default(t);
    } catch (e) {
        const detail = e?.stack ? `${e.message}\n${e.stack}` : (e?.message ?? e);
        t.fail(`${path} ran without throwing`, detail);
    }
}

if (t.failures === 0) {
    print('All good 🎉');
} else {
    print(`${t.failures} failure(s)`);
    System.exit(1);
}
