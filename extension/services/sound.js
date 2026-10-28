// Soft chimes from the freedesktop sound theme (replaces NSSound). Port of Brain.Chime and the sound-mode gate of
// Brain.play() in Brain.swift. GNOME's sound player has no volume control, so the Swift volumes are dropped.
// Imports nothing; `global` is only read inside playChime(), so plain gjs can load this file.

// Theme sound per chime (Swift: Pop, Tink, Glass, Hero, Basso).
export const CHIME_SOUNDS = Object.freeze({
    chatter: 'message', // an ordinary bubble
    important: 'bell', // a meeting or task time, the end of a focus session
    celebrate: 'complete', // a finished task
    big: 'complete', // a golden treat or growing up
    grumble: 'dialog-warning', // mischief
});

// Off is silent; "important only" skips ordinary bubbles and grumbles; "all" plays every chime.
export function shouldPlay(chime, soundMode) {
    if (!Object.hasOwn(CHIME_SOUNDS, chime))
        return false;
    switch (soundMode) {
    case 'all': return true;
    case 'important': return chime !== 'chatter' && chime !== 'grumble';
    default: return false;
    }
}

// Plays the chime when the sound mode allows it. Returns whether it asked the player to play.
export function playChime(chime, soundMode) {
    if (!shouldPlay(chime, soundMode))
        return false;
    global.display.get_sound_player().play_from_theme(CHIME_SOUNDS[chime], 'TodoPet', null);
    return true;
}
