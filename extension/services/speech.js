// Speaking a line out loud with speech-dispatcher's `spd-say` (replaces AVSpeechSynthesizer). Imports only
// GLib and Gio, so plain gjs can load it.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// `--` ends the options, so a line that starts with "-" is spoken instead of read as an option.
export function speechArgs(text, lang) {
    return ['spd-say', '-l', lang, '--', text];
}

// False when speech-dispatcher is not installed; the voice switch then shows a hint and only turns off.
export function hasSpeech() {
    return GLib.find_program_in_path('spd-say') !== null;
}

// Starts `spd-say` and returns at once; nobody waits for it (GSubprocess reaps it when it exits).
export function speak(text, lang) {
    try {
        Gio.Subprocess.new(speechArgs(text, lang), Gio.SubprocessFlags.NONE);
    } catch (e) {
        console.warn(`TodoPet: could not start spd-say: ${e.message}`);
    }
}
