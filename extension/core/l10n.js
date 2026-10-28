// UI language. The whole extension is bilingual; every user-facing string goes through L(vi, en).
import GLib from 'gi://GLib';

// 'vi' when the first system language is Vietnamese, otherwise 'en' (also for the plain 'C' locale).
export function systemLang() {
    const first = GLib.get_language_names()[0] ?? 'en';
    return first.toLowerCase().startsWith('vi') ? 'vi' : 'en';
}

// 'en' and 'vi' stay as they are; anything else (such as the empty "follow the system" value) becomes the system language.
export function resolveLang(lang) {
    return lang === 'en' || lang === 'vi' ? lang : systemLang();
}

let currentLang = systemLang();

export function setLang(lang) {
    currentLang = resolveLang(lang);
}

export function getLang() {
    return currentLang;
}

// Bilingual string: L('Xin chào', 'Hello').
export function L(vi, en) {
    return currentLang === 'vi' ? vi : en;
}

// Picks one random bilingual variant from [[vi, en], ...].
export function pick(pairs, random = Math.random) {
    if (pairs.length === 0)
        return L('', '');
    const index = Math.min(Math.floor(random() * pairs.length), pairs.length - 1);
    return L(pairs[index][0], pairs[index][1]);
}
