// Which repaint loop the pet needs (spec "Animation budget"): about 30 fps while it moves or animates, at most 4 fps
// while it sits still, nothing while it is hidden. Pure, so the tests can check the budget; ui/pet.js runs the loop.

// After the pointer comes onto the pet, the petted look (the blush, one rise of the heart, the eyes turning) plays at
// the full rate for this long. A pet under a parked pointer is sitting still: it then drops to the slow loop.
export const HOVER_FAST_SECONDS = 2;

// 'off', 'fast' or 'slow'. `shown`: on screen (in the chrome and mapped); `moving`: walking, falling, held or in a
// moving antic; `hoveredFor`: seconds since the pointer came onto the pet, or null; `paintedMood` and `blend`: the
// mood of the last frame drawn and how far its colors had blended in (0–1).
export function loopMode({shown, moving, hoveredFor = null, mood, paintedMood, blend}) {
    if (!shown)
        return 'off';
    if (moving)
        return 'fast';
    if (hoveredFor !== null && hoveredFor < HOVER_FAST_SECONDS)
        return 'fast';
    if (mood === 'celebrating' || mood !== paintedMood || blend < 1)
        return 'fast';
    return 'slow';
}
