// Where the pet may stand: pure helpers for ui/pet.js and ui/walker.js (no Shell imports, so plain gjs tests load
// them). A work area is {x, y, width, height} in stage pixels, like Main.layoutManager.getWorkAreaForMonitor().

// The pet's window in PetWindow.swift is 124 points square at scale 1.
export const PET_BASE_SIZE = 124;
const MIN_SCALE = 0.6;
const MAX_SCALE = 2.0;

// The pet's x, moved so the whole pet (`petWidth` wide) is inside the work area. A pet wider than the work area
// sticks to its left edge.
export function clampToWorkArea(x, petWidth, workArea) {
    const max = Math.max(workArea.x, workArea.x + workArea.width - petWidth);
    return Math.min(Math.max(x, workArea.x), max);
}

// The y that puts a pet `petHeight` tall on the bottom edge of the work area.
export function groundY(workArea, petHeight) {
    return workArea.y + workArea.height - petHeight;
}

// The pet's side in stage pixels (Swift: 124 × petScale clamped to 0.6–2.0), times the stage scale factor.
export function petSize(petScale, scaleFactor) {
    const scale = Number.isFinite(petScale) ? Math.min(Math.max(petScale, MIN_SCALE), MAX_SCALE) : 1;
    return Math.round(PET_BASE_SIZE * scale * scaleFactor);
}
