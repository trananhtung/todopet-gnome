// Distracting websites by window title. Browsers put the page title in the window title
// ("Watch later - YouTube — Mozilla Firefox"), so a rule such as "youtube.com" is matched by the brand name
// that appears in titles. Approximate by design; replaces the macOS URL reading of BrowserWatcher.swift.

// Window classes (WM_CLASS / app id) of browsers, matched in lower case by prefix.
const BROWSER_CLASSES = Object.freeze([
    'firefox', 'org.mozilla.firefox', 'google-chrome', 'chromium', 'brave-browser', 'microsoft-edge', 'vivaldi',
    'opera', 'coccoc',
]);

// Words by which a known domain shows up in window titles.
const BRANDS = new Map([
    ['youtube.com', ['YouTube']],
    ['facebook.com', ['Facebook']],
    ['tiktok.com', ['TikTok']],
    ['instagram.com', ['Instagram']],
    ['x.com', ['/ X', 'Twitter']],
    ['reddit.com', ['Reddit']],
    ['netflix.com', ['Netflix']],
]);

// Second-level labels of country domains such as "com.vn" and "co.uk".
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

// How browsers name themselves in the window title ("Page - Google Chrome", "Page — Mozilla Firefox").
// Edge puts a zero-width space inside "Microsoft Edge". Cốc Cốc is spelled with escapes (composed form).
const TITLE_NAMES = 'Google Chrome|Chromium|Mozilla Firefox|Firefox|Brave|Microsoft[\\s\\u200B]*Edge|Vivaldi|Opera|C\\u1ED1c C\\u1ED1c';
// A separator, then a browser name, then anything (a profile name, "Private Browsing", ...).
const BROWSER_SUFFIX = new RegExp(`\\s+[-\\u2013\\u2014]\\s+(?:${TITLE_NAMES})(?![\\p{L}\\p{N}])`, 'giu');
// A window whose title is only the browser name (no page yet, or a private window).
const BROWSER_ONLY = new RegExp(`^(?:${TITLE_NAMES})(?:\\s+\\(?Private Browsing\\)?)?$`, 'iu');

export function isBrowser(wmClass) {
    if (typeof wmClass !== 'string')
        return false;
    const lower = wmClass.toLowerCase();
    return BROWSER_CLASSES.some(prefix => lower.startsWith(prefix));
}

// The label that names a site: "vnexpress.net" -> "vnexpress", "dantri.com.vn" -> "dantri".
function mainLabel(domain) {
    const labels = domain.split('.').filter(label => label !== '');
    if (labels.length < 2)
        return labels[0] ?? '';
    if (labels.length >= 3 && labels.at(-1).length === 2 && SECOND_LEVEL.has(labels.at(-2)))
        return labels.at(-3);
    return labels.at(-2);
}

// The page part of a window title: the last " - <browser name>" and whatever the browser adds after it are cut,
// so a rule such as "mail.google.com" cannot match every "... - Google Chrome" window.
// A title without a browser name stays as it is.
export function stripBrowserName(title) {
    const text = title.normalize('NFC');
    let cut = -1;
    for (const match of text.matchAll(BROWSER_SUFFIX))
        cut = match.index;
    if (cut >= 0)
        return text.slice(0, cut);
    return BROWSER_ONLY.test(text) ? '' : text;
}

// What to look for in a title for this rule: any one of `words` names the site, and when the rule has a path
// ("youtube.com/shorts") its last segment must appear too. `path` is null for plain rules.
export function titleKeywords(rule) {
    const text = String(rule ?? '').trim().toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
        .split(/[?#]/)[0];
    const slash = text.indexOf('/');
    const domain = (slash < 0 ? text : text.slice(0, slash)).replace(/^www\./, '').replace(/:\d*$/, '');
    const segments = slash < 0 ? [] : text.slice(slash + 1).split('/').filter(segment => segment !== '');
    const brand = [...BRANDS].find(([name]) => domain === name || domain.endsWith(`.${name}`));
    const label = mainLabel(domain);
    return {
        words: brand ? [...brand[1]] : (label === '' ? [] : [label]),
        path: segments.at(-1) ?? null,
    };
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// True when `word` is in `title` as a whole word, ignoring case.
function hasWord(title, word) {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'iu').test(title);
}

// The first rule (in the given order) that matches the page part of the window title, or null.
export function matchTitle(title, rules) {
    if (typeof title !== 'string')
        return null;
    const page = stripBrowserName(title);
    if (page === '')
        return null;
    for (const rule of rules ?? []) {
        if (typeof rule !== 'string')
            continue;
        const {words, path} = titleKeywords(rule);
        if (words.length === 0 || !words.some(word => hasWord(page, word)))
            continue;
        if (path !== null && !hasWord(page, path))
            continue;
        return rule;
    }
    return null;
}
