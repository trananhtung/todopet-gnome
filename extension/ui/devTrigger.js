// The `dev-trigger` setting (Developer page of the settings window, and the dev scenes): writing a command there makes
// the extension act on it; App resets the key to '' afterwards. Pure: it reads the value and calls the brain's hooks.
//
//   parade | block | grumble    a stunt now             brain.devAntic(kind)
//   celebrate:<kind>            a celebration           brain.devCelebrate({kind})   (jump spin flip dance fireworks)
//   golden                      a golden treat          brain.devCelebrate({kind: 'jump', golden: true})
//   bubble                      a test speech bubble    brain.say(...)
//   prefs:<page>                not ours: the settings window reads and resets it (Task 23)
//   ''                          nothing
import {L} from '../core/l10n.js';

const ANTICS = new Set(['parade', 'block', 'grumble']);

// -> {kind: 'none'} | {kind: 'prefs'} | {kind: 'antic', antic} | {kind: 'celebrate', options} | {kind: 'bubble'} |
//    {kind: 'unknown', value}
export function parseDevTrigger(value) {
    const text = String(value ?? '');
    if (text === '')
        return {kind: 'none'};
    if (text.startsWith('prefs:'))
        return {kind: 'prefs'};
    if (ANTICS.has(text))
        return {kind: 'antic', antic: text};
    if (text === 'golden')
        return {kind: 'celebrate', options: {kind: 'jump', golden: true}};
    if (text.startsWith('celebrate:'))
        return {kind: 'celebrate', options: {kind: text.slice('celebrate:'.length)}};
    if (text === 'bubble')
        return {kind: 'bubble'};
    return {kind: 'unknown', value: text};
}

// Plays the command in `value` on `brain`. Returns whether it ran a command: false for '' and prefs:<page>, which are
// not ours. Throws for a value that is no command and when the brain refuses it (an unknown celebration).
export function runDevTrigger(brain, value) {
    const command = parseDevTrigger(value);
    switch (command.kind) {
    case 'none':
    case 'prefs':
        return false;
    case 'antic':
        brain.devAntic(command.antic);
        return true;
    case 'celebrate':
        brain.devCelebrate(command.options);
        return true;
    case 'bubble':
        brain.say({
            text: L('Đây là bong bóng thử 💬', 'This is a test bubble 💬'),
            seconds: 8,
            urgent: true,
        });
        return true;
    default:
        throw new Error(`dev-trigger: unknown command '${command.value}'`);
    }
}
