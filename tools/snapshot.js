// Renders the pet art to PNG sheets for docs and visual checks (port of MoodSheet in DevTools.swift).
// Usage: gjs -m tools/snapshot.js <outDir>   (make snapshot writes to out/)
import Cairo from 'cairo';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import System from 'system';

import {Mood, moodEmoji} from '../extension/core/mood.js';
import {defaultPose, drawPet} from '../extension/art/petArt.js';

// Sizes in points, drawn at 2× like the screenshots in the Swift repo's docs/.
const SCALE = 2;
const PADDING = 10;
const GAP = 4;
const ROW_GAP = 6;
const PET = 120;
const LABEL_HEIGHT = 14;

const pose = (mood, t, change = {}) => ({...defaultPose(mood, t), ...change});

function drawLabel(cr, text, x, y) {
    const layout = PangoCairo.create_layout(cr);
    const font = Pango.FontDescription.from_string('Sans');
    font.set_weight(Pango.Weight.SEMIBOLD);
    font.set_absolute_size(11 * Pango.SCALE);
    layout.set_font_description(font);
    layout.set_text(text, -1);
    const [, logical] = layout.get_extents();
    cr.setSourceRGB(0, 0, 0);
    cr.moveTo(x - (logical.x + logical.width / 2) / Pango.SCALE, y - (logical.y + logical.height / 2) / Pango.SCALE);
    PangoCairo.show_layout(cr, layout);
    cr.newPath();
}

// A sheet is rows of cells; a cell is a column of poses with an optional label underneath.
function renderSheet(rows, file) {
    const rowWidth = row => row.length * PET + (row.length - 1) * GAP;
    const cellHeight = cell => cell.poses.length * PET + (cell.label ? LABEL_HEIGHT : 0);
    const rowHeight = row => Math.max(...row.map(cellHeight));
    const width = 2 * PADDING + Math.max(...rows.map(rowWidth));
    const height = 2 * PADDING + rows.reduce((sum, row) => sum + rowHeight(row), 0) + (rows.length - 1) * ROW_GAP;

    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, Math.ceil(width * SCALE), Math.ceil(height * SCALE));
    const cr = new Cairo.Context(surface);
    try {
        cr.scale(SCALE, SCALE);
        cr.setSourceRGB(1, 1, 1);
        cr.paint();
        let y = PADDING;
        for (const row of rows) {
            let x = PADDING;
            for (const cell of row) {
                // Cells shorter than the row are centered vertically, like an HStack.
                let cy = y + (rowHeight(row) - cellHeight(cell)) / 2;
                for (const p of cell.poses) {
                    cr.save();
                    cr.translate(x, cy);
                    drawPet(cr, PET, PET, p);
                    cr.restore();
                    cy += PET;
                }
                if (cell.label)
                    drawLabel(cr, cell.label, x + PET / 2, cy + LABEL_HEIGHT / 2);
                x += PET + GAP;
            }
            y += rowHeight(row) + ROW_GAP;
        }
    } finally {
        cr.$dispose();
    }
    surface.writeToPNG(file);
    surface.finish();
    print(`wrote ${file}`);
}

// Every mood, standing (t = 0.4) and walking, then held and petted.
function moodSheet() {
    const moods = [Mood.happy, Mood.normal, Mood.annoyed, Mood.angry, Mood.sleeping, Mood.focus, Mood.celebrating];
    return [[
        ...moods.map(m => ({
            poses: [pose(m, 0.4), pose(m, 1.25, {facing: 1, walking: true, walkPhase: 1.2})],
            label: `${moodEmoji(m)} ${m}`,
        })),
        {
            poses: [pose(Mood.normal, 0.6, {held: true}), pose(Mood.normal, 0.6, {hovered: true})],
            label: 'held / petted',
        },
    ]];
}

const outDir = System.programArgs[0] ?? 'out';
GLib.mkdir_with_parents(outDir, 0o755);
renderSheet(moodSheet(), GLib.build_filenamev([outDir, 'moods.png']));
