// Minimal test harness. Each check prints one line right away and counts failures.

// Stable, comparable text for any JSON-like value: object keys are sorted at every level.
// Non-finite numbers would otherwise all collapse to null, so they are spelled out.
function canonical(value) {
    const sortKeys = v => {
        if (Array.isArray(v))
            return v.map(sortKeys);
        if (v !== null && typeof v === 'object' && typeof v.toJSON !== 'function') {
            const out = {};
            for (const key of Object.keys(v).sort())
                out[key] = sortKeys(v[key]);
            return out;
        }
        return v;
    };
    const text = JSON.stringify(sortKeys(value), (_key, v) =>
        typeof v === 'number' && !Number.isFinite(v) ? `<${v}>` : v);
    return text === undefined ? 'undefined' : text;
}

export class T {
    constructor() {
        this.failures = 0;
    }

    // Records one failed check (also used by run.js for modules that throw).
    fail(name, got) {
        print(`❌ ${name} (got ${got})`);
        this.failures += 1;
        return false;
    }

    _report(ok, name, got) {
        if (!ok)
            return this.fail(name, got);
        print(`✅ ${name}`);
        return true;
    }

    check(ok, name) {
        return this._report(Boolean(ok), name, ok);
    }

    eq(actual, expected, name) {
        const got = canonical(actual);
        const want = canonical(expected);
        return this._report(got === want, name, `${got}, expected ${want}`);
    }

    near(actual, expected, eps, name) {
        const ok = Math.abs(actual - expected) <= eps;
        return this._report(ok, name, `${actual}, expected ${expected} ± ${eps}`);
    }

    // Passes when `promise` rejects and `predicate(error)` is true.
    // Without a predicate, any rejection passes.
    async rejects(promise, predicate, name) {
        let value;
        try {
            value = await promise;
        } catch (e) {
            const ok = typeof predicate === 'function' ? Boolean(predicate(e)) : true;
            return this._report(ok, name, `rejection ${e?.message ?? e}`);
        }
        return this._report(false, name, `a resolved promise (${canonical(value)})`);
    }
}
