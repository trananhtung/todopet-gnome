// Draws "Mochi", the pet (port of PetArt.swift), and the sign it drags during a parade (SignView in Antics.swift)
// with Cairo. Shapes, colors and timings follow the Swift code in its 120×120 design space. Imports only Cairo,
// Pango and core/, so tests and tools/snapshot.js can load it outside GNOME Shell, and an St.DrawingArea can call
// drawPet(cr, width, height, pose) or drawSign(cr, width, height, text) on repaint.
import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {L} from '../core/l10n.js';
import {shortText} from '../core/dates.js';
import {Mood} from '../core/mood.js';
import {isHungry, lifeStage, stageScale, stageSprouts, wornAccessories} from '../core/life.js';

// --- Poses ---

// Everything needed to draw one frame of the pet, with the defaults of Swift's PetPose.
export function defaultPose(mood, t) {
    return {
        mood,
        t,
        facing: 1,
        walking: false,
        walkPhase: 0,
        lookX: 0,
        hovered: false,
        held: false,
        prevMood: Mood.normal,
        // 0 → colors of prevMood, 1 → colors of mood.
        blend: 1,
        // You're typing or in the zone: keep movements small.
        calm: false,
        // Life: growth, hunger, dirt, accessories.
        stageScale: 1,
        sprouts: 0,
        hungry: false,
        dirt: 0,
        wearing: [],
        // Celebration after a finished task.
        celebration: 'jump',
        golden: false,
        food: null,
        // Seconds since the food started falling.
        foodT: 0,
    };
}

// The pose with the pet's long-term state applied (stage, hunger, dirt, accessories). Returns a new pose.
export function decoratePose(pose, life) {
    const stage = lifeStage(life);
    return {
        ...pose,
        stageScale: stageScale(stage),
        sprouts: stageSprouts(stage),
        hungry: isHungry(life),
        dirt: life.dirt,
        wearing: wornAccessories(life),
    };
}

// --- Colors ---

function rgba(hex, a = 1) {
    return {r: ((hex >> 16) & 0xFF) / 255, g: ((hex >> 8) & 0xFF) / 255, b: (hex & 0xFF) / 255, a};
}

function mixRGBA(c, o, k) {
    return {r: c.r + (o.r - c.r) * k, g: c.g + (o.g - c.g) * k, b: c.b + (o.b - c.b) * k, a: c.a + (o.a - c.a) * k};
}

const withAlpha = (c, a) => ({...c, a: c.a * a});

const WHITE = rgba(0xFFFFFF);
const BLACK = rgba(0x000000);
const INK = rgba(0x2B1B14);
const MOUTH_DARK = rgba(0x5A2A1E);
const TONGUE = rgba(0xFF7A8A);
const INNER_EAR = rgba(0xFF9FB2, 0.7);
const HEADBAND = rgba(0xE53935);
const SPARKLE = rgba(0xFFC93C);
const STEAM_EDGE = rgba(0x8E8E93);
const CONFETTI = [0xFF5C8A, 0xFFC93C, 0x4FC3F7, 0x66BB6A, 0xAB47BC].map(hex => rgba(hex));
const GOLD_SPARKLE = rgba(0xFFD700);
const LEAF = rgba(0x6CC04A);
const STEM = rgba(0x3E8E2A);
const SMUDGE = rgba(0x6B5544, 0.32);
const SCARF = rgba(0xD84343);
const SHADES = rgba(0x000000, 0.88);

const palette = (top, bottom, line, cheek) => Object.freeze({top, bottom, line, cheek});

const PALETTES = Object.freeze({
    happy: palette(rgba(0xFFE9CC), rgba(0xFFBA8A), rgba(0x8A4B2A), rgba(0xFF6F96, 0.55)),
    normal: palette(rgba(0xFFF0DE), rgba(0xF4C69C), rgba(0x7A4A30), rgba(0xFF8FA3, 0.40)),
    annoyed: palette(rgba(0xEFE6DC), rgba(0xC4B09E), rgba(0x5E4A3E), rgba(0xC98F8F, 0.20)),
    angry: palette(rgba(0xFFB49C), rgba(0xEA5A45), rgba(0x6E1D12), rgba(0xB02A1E, 0.0)),
    sleeping: palette(rgba(0xEAE7F8), rgba(0xB9B2DE), rgba(0x4D4775), rgba(0xFF9FB8, 0.28)),
});

// The rare golden pet, celebrating a lucky finished task.
const GOLDEN_PALETTE = palette(rgba(0xFFF6C2), rgba(0xFFC531), rgba(0x8A5A00), rgba(0xFF7F9E, 0.55));

// Body colors per mood: gradient top and bottom, outline, cheeks. Unknown moods get the normal colors.
export function petPalette(mood) {
    switch (mood) {
    case Mood.happy:
    case Mood.celebrating:
        return PALETTES.happy;
    case Mood.annoyed:
        return PALETTES.annoyed;
    case Mood.angry:
        return PALETTES.angry;
    case Mood.sleeping:
        return PALETTES.sleeping;
    default:
        return PALETTES.normal;
    }
}

export function mixPalette(a, b, k) {
    return {
        top: mixRGBA(a.top, b.top, k),
        bottom: mixRGBA(a.bottom, b.bottom, k),
        line: mixRGBA(a.line, b.line, k),
        cheek: mixRGBA(a.cheek, b.cheek, k),
    };
}

// --- Paths ---

// Bézier circle constant: four cubic quarter arcs, as CoreGraphics builds ellipses.
const KAPPA = 0.5522847498307936;

// A reusable vector path, like SwiftUI's Path: built once, then filled, stroked or used as a clip.
class Path {
    constructor() {
        this._ops = [];
        this._x = 0;
        this._y = 0;
        this._startX = 0;
        this._startY = 0;
    }

    moveTo(x, y) {
        this._ops.push(['M', x, y]);
        this._x = this._startX = x;
        this._y = this._startY = y;
        return this;
    }

    lineTo(x, y) {
        this._ops.push(['L', x, y]);
        this._x = x;
        this._y = y;
        return this;
    }

    curveTo(x1, y1, x2, y2, x, y) {
        this._ops.push(['C', x1, y1, x2, y2, x, y]);
        this._x = x;
        this._y = y;
        return this;
    }

    // Quadratic curve, written as the equivalent cubic (Cairo has no quadratic curves).
    quadTo(cx, cy, x, y) {
        return this.curveTo(
            this._x + (cx - this._x) * 2 / 3, this._y + (cy - this._y) * 2 / 3,
            x + (cx - x) * 2 / 3, y + (cy - y) * 2 / 3,
            x, y);
    }

    close() {
        this._ops.push(['Z']);
        this._x = this._startX;
        this._y = this._startY;
        return this;
    }

    // Ellipse inscribed in the rectangle, like Path(ellipseIn:).
    ellipse(x, y, w, h) {
        const rx = w / 2, ry = h / 2, mx = x + rx, my = y + ry, kx = rx * KAPPA, ky = ry * KAPPA;
        return this.moveTo(mx + rx, my)
            .curveTo(mx + rx, my + ky, mx + kx, my + ry, mx, my + ry)
            .curveTo(mx - kx, my + ry, mx - rx, my + ky, mx - rx, my)
            .curveTo(mx - rx, my - ky, mx - kx, my - ry, mx, my - ry)
            .curveTo(mx + kx, my - ry, mx + rx, my - ky, mx + rx, my)
            .close();
    }

    rect(x, y, w, h) {
        return this.moveTo(x, y).lineTo(x + w, y).lineTo(x + w, y + h).lineTo(x, y + h).close();
    }

    roundedRect(x, y, w, h, radius) {
        const r = Math.min(radius, w / 2, h / 2), k = r * (1 - KAPPA);
        return this.moveTo(x + r, y)
            .lineTo(x + w - r, y).curveTo(x + w - k, y, x + w, y + k, x + w, y + r)
            .lineTo(x + w, y + h - r).curveTo(x + w, y + h - k, x + w - k, y + h, x + w - r, y + h)
            .lineTo(x + r, y + h).curveTo(x + k, y + h, x, y + h - k, x, y + h - r)
            .lineTo(x, y + r).curveTo(x, y + k, x + k, y, x + r, y)
            .close();
    }

    // A copy rotated by `angle` around the origin, then moved by (dx, dy).
    rotated(angle, dx = 0, dy = 0) {
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const out = new Path();
        out._ops = this._ops.map(([op, ...xy]) => {
            const moved = [];
            for (let i = 0; i < xy.length; i += 2)
                moved.push(xy[i] * cos - xy[i + 1] * sin + dx, xy[i] * sin + xy[i + 1] * cos + dy);
            return [op, ...moved];
        });
        return out;
    }

    // Replaces the context's current path with this one.
    apply(cr) {
        cr.newPath();
        for (const [op, ...v] of this._ops) {
            if (op === 'M')
                cr.moveTo(v[0], v[1]);
            else if (op === 'L')
                cr.lineTo(v[0], v[1]);
            else if (op === 'C')
                cr.curveTo(v[0], v[1], v[2], v[3], v[4], v[5]);
            else
                cr.closePath();
        }
    }
}

const ellipse = (x, y, w, h) => new Path().ellipse(x, y, w, h);
const line = (x0, y0, x1, y1) => new Path().moveTo(x0, y0).lineTo(x1, y1);

function setColor(cr, c) {
    cr.setSourceRGBA(c.r, c.g, c.b, c.a);
}

function fill(cr, path, color) {
    path.apply(cr);
    setColor(cr, color);
    cr.fill();
}

function stroke(cr, path, color, width, {cap = Cairo.LineCap.BUTT, join = Cairo.LineJoin.MITER, dash = null} = {}) {
    path.apply(cr);
    setColor(cr, color);
    cr.setLineWidth(width);
    cr.setLineCap(cap);
    cr.setLineJoin(join);
    if (dash)
        cr.setDash(dash, 0);
    cr.stroke();
    if (dash)
        cr.setDash([], 0);
}

const ROUND = {cap: Cairo.LineCap.ROUND, join: Cairo.LineJoin.ROUND};

// Draws inside `path` only, like SwiftUI's drawLayer { $0.clip(to:) }.
function clipped(cr, path, draw) {
    cr.save();
    try {
        path.apply(cr);
        cr.clip();
        draw();
    } finally {
        cr.restore();
    }
}

// Glyph outlines at GLYPH_SIZE design units, centered on (0, 0), by text and weight. Laying text out is slow,
// so each glyph is laid out once and its outline replayed, scaled, on every frame.
const GLYPH_SIZE = 100;
const glyphs = new Map();

function glyphOutline(text, weight) {
    const key = `${weight} ${text}`;
    let outline = glyphs.get(key);
    if (!outline) {
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1);
        const cr = new Cairo.Context(surface);
        try {
            const layout = PangoCairo.create_layout(cr);
            const font = Pango.FontDescription.from_string('Sans');
            font.set_weight(weight);
            font.set_absolute_size(GLYPH_SIZE * Pango.SCALE);
            layout.set_font_description(font);
            layout.set_text(text, -1);
            const [, logical] = layout.get_extents();
            cr.moveTo(-(logical.x + logical.width / 2) / Pango.SCALE, -(logical.y + logical.height / 2) / Pango.SCALE);
            PangoCairo.layout_path(cr, layout);
            outline = cr.copyPath();
        } finally {
            cr.$dispose();
            surface.finish();
        }
        glyphs.set(key, outline);
    }
    return outline;
}

// Text centered on (x, y), like GraphicsContext.draw(Text, at:). `size` is in design units. The glyphs are
// filled as paths: they scale smoothly and never get subpixel color fringes on the transparent pet. `outline`
// (a fraction of the size) thickens them with round joins, standing in for SF Rounded's heavy, round letters.
function drawText(cr, text, x, y, size, color, {weight = Pango.Weight.NORMAL, outline = 0} = {}) {
    if (!(size > 0) || color.a <= 0)
        return;
    const glyph = glyphOutline(text, weight);
    // Opaque inside a group, then faded as a whole, so the outline doesn't darken where it overlaps the fill.
    // The group is always popped, so a failure never leaves the caller drawing into it.
    cr.pushGroup();
    try {
        cr.newPath();
        cr.save();
        cr.translate(x, y);
        cr.scale(size / GLYPH_SIZE, size / GLYPH_SIZE);
        cr.appendPath(glyph);
        cr.restore();
        cr.setSourceRGB(color.r, color.g, color.b);
        if (outline > 0) {
            cr.fillPreserve();
            cr.setLineWidth(outline * size);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            cr.stroke();
        } else {
            cr.fill();
        }
    } finally {
        cr.popGroupToSource();
    }
    cr.paintWithAlpha(color.a);
}

// Emoji (the falling treat) centered on (x, y) at a font size of `size` design units, in the system's color emoji
// font when there is one. Layouts are kept per text and size and only re-targeted to the context on each frame.
const emojiLayouts = new Map();

function drawEmoji(cr, text, x, y, size) {
    const key = `${size} ${text}`;
    let layout = emojiLayouts.get(key);
    if (layout) {
        PangoCairo.update_layout(cr, layout);
    } else {
        if (emojiLayouts.size >= 32)
            emojiLayouts.clear();
        layout = PangoCairo.create_layout(cr);
        const font = Pango.FontDescription.from_string('Sans');
        font.set_absolute_size(size * Pango.SCALE);
        layout.set_font_description(font);
        layout.set_text(text, -1);
        emojiLayouts.set(key, layout);
    }
    const [, logical] = layout.get_extents();
    cr.newPath();
    cr.moveTo(x - (logical.x + logical.width / 2) / Pango.SCALE, y - (logical.y + logical.height / 2) / Pango.SCALE);
    setColor(cr, INK);
    PangoCairo.show_layout(cr, layout);
    cr.newPath();
}

// Four-pointed star with curved sides.
function sparkle(cx, cy, r) {
    return new Path().moveTo(cx, cy - r)
        .quadTo(cx, cy, cx + r, cy)
        .quadTo(cx, cy, cx, cy + r)
        .quadTo(cx, cy, cx - r, cy)
        .quadTo(cx, cy, cx, cy - r);
}

// Sweat drop, pointed at the top.
function drop(cx, cy) {
    return new Path().moveTo(cx, cy - 6)
        .curveTo(cx + 2, cy - 2, cx + 5, cy + 4, cx, cy + 4)
        .curveTo(cx - 5, cy + 4, cx - 2, cy - 2, cx, cy - 6);
}

// The round mochi body: flat-ish top, wide hips, flat bottom.
function bodyPath(cx, top, bottom, w, h) {
    const l = cx - w / 2, r = cx + w / 2;
    return new Path().moveTo(cx, top)
        .curveTo(cx + w * 0.40, top, r, top + h * 0.22, r, bottom - h * 0.38)
        .curveTo(r, bottom - h * 0.04, cx + w * 0.36, bottom, cx, bottom)
        .curveTo(cx - w * 0.36, bottom, l, bottom - h * 0.04, l, bottom - h * 0.38)
        .curveTo(l, top + h * 0.22, cx - w * 0.40, top, cx, top)
        .close();
}

// The 💢 anger mark: four red crescents bulging towards the middle, about `size` across like the emoji Swift draws.
// Drawn as shapes so it looks the same everywhere, even without a color emoji font.
function drawAngerMark(cr, x, y, size) {
    const red = rgba(0xE00A0A);
    // The crescent on the right, pointed ends away from the middle; the others are it turned by quarters.
    const crescent = new Path().moveTo(size * 0.54, -size * 0.39)
        .quadTo(-size * 0.06, 0, size * 0.54, size * 0.39)
        .quadTo(size * 0.28, 0, size * 0.54, -size * 0.39)
        .close();
    // The emoji's glyph sits a little left of the point it is drawn at.
    for (let q = 0; q < 4; q++)
        fill(cr, crescent.rotated(q * Math.PI / 2, x - size * 0.06, y), red);
}

// --- Drawing ---

const clamp01 = v => Math.max(0, Math.min(1, v));

// Body moves for a celebration: a jump, a spin in the air, a back-flip or a dance.
function celebrationMoves(p) {
    const t = p.t;
    const ph = (t * 2.2) % 1;
    const h = Math.sin(ph * Math.PI);
    let jump, shakeX = 0, spinX = 1, flipAngle = 0;
    switch (p.celebration) {
    case 'dance':
        shakeX = Math.sin(t * 8) * 7;
        jump = Math.abs(Math.sin(t * 8)) * 4;
        break;
    case 'flip':
        jump = h * 26;
        if (ph > 0.12 && ph < 0.88)
            flipAngle = (ph - 0.12) / 0.76 * 2 * Math.PI;
        break;
    case 'spin':
        jump = h * 14;
        spinX = Math.cos(t * 9);
        break;
    default:
        jump = h * 20;
    }
    const squash = p.celebration === 'dance' ? 0 : (ph < 0.1 || ph > 0.9 ? 0.12 : -0.06 * h);
    return {jump, squash, shakeX, spinX, flipAngle};
}

// How the body bounces, squashes, shakes and breathes this frame.
function bodyMoves(p, mood) {
    const t = p.t;
    let jump = 0, squash = 0, shakeX = 0, breathe = 0, spinX = 1, flipAngle = 0;
    switch (mood) {
    case Mood.celebrating:
        ({jump, squash, shakeX, spinX, flipAngle} = celebrationMoves(p));
        break;
    case Mood.happy:
        if (p.walking) {
            jump = Math.abs(Math.sin(p.walkPhase)) * 5;
        } else {
            const b = Math.abs(Math.sin(t * 3.2));
            jump = b * 6;
            squash = (1 - b) * 0.08 - 0.03;
        }
        break;
    case Mood.annoyed:
        if (p.walking)
            jump = Math.abs(Math.sin(p.walkPhase)) * 1.5;
        else
            breathe = Math.sin(t * 1.2) * 0.015;
        break;
    case Mood.angry:
        shakeX = Math.sin(t * 47) * (Math.sin(t * 1.7) > 0.2 ? 1.6 : 0.3);
        if (p.walking) {
            jump = Math.abs(Math.sin(p.walkPhase)) * 2;
            squash = 0.05 * Math.abs(Math.cos(p.walkPhase));
        } else {
            const st = Math.abs(Math.sin(t * 5));
            jump = st * 2.5;
            squash = (1 - st) * 0.06;
        }
        break;
    case Mood.sleeping:
        breathe = Math.sin(t * 1.3) * 0.04;
        squash = 0.06;
        break;
    default: // normal, focus
        if (p.walking)
            jump = Math.abs(Math.sin(p.walkPhase)) * 3;
        else
            breathe = Math.sin(t * 2) * 0.02;
    }
    if (p.calm && mood !== Mood.celebrating) {
        // Motion at the edge of your vision pulls attention: tone it down while you work.
        jump *= 0.3;
        squash *= 0.5;
        shakeX *= 0.2;
    }
    if (p.held) {
        jump = 0;
        squash = -0.12;
        shakeX = Math.sin(t * 9) * 1.2;
    }
    return {jump, squash, shakeX, breathe, spinX, flipAngle};
}

const EAR_LIFT = Object.freeze({
    happy: 1, celebrating: 1, normal: 0.92, focus: 0.92, annoyed: 0.7, angry: 0.5, sleeping: 0.55,
});

function drawFeet(cr, f) {
    const {p, mood, pal, cx, by} = f, t = p.t;
    let liftL = 0, liftR = 0;
    if (p.walking && !p.held) {
        liftL = Math.max(0, Math.sin(p.walkPhase)) * 5;
        liftR = Math.max(0, -Math.sin(p.walkPhase)) * 5;
    } else if (mood === Mood.annoyed) {
        liftR = Math.sin(t * 0.9) > 0 ? Math.max(0, Math.sin(t * 9)) * 3 : 0; // impatient tapping
    } else if (mood === Mood.angry) {
        liftL = Math.max(0, Math.sin(t * 5)) * 3;
        liftR = Math.max(0, -Math.sin(t * 5)) * 3;
    }
    const dangle = p.held ? 4 : 0;
    const footFill = mixRGBA(pal.bottom, pal.line, 0.12);
    for (const [dx, lift] of [[-17, liftL], [17, liftR]]) {
        const swing = p.held ? Math.sin(t * 10 + dx) * 2 : 0;
        const foot = ellipse(cx + dx - 8.5 + swing, by - 3 - lift + dangle, 17, 9);
        fill(cr, foot, footFill);
        stroke(cr, foot, pal.line, 2);
    }
}

// Ears, behind the body: lower and wider apart in bad moods.
function drawEars(cr, f) {
    const {p, mood, pal, cx, top, bw, bh} = f;
    const earLift = EAR_LIFT[mood] ?? EAR_LIFT.normal;
    for (const side of [-1, 1]) {
        const twitch = mood === Mood.happy && side > 0 && Math.sin(p.t * 1.3) > 0.95 ? -3 : 0;
        const b1 = [cx + side * bw * 0.08, top + bh * 0.12];
        const b2 = [cx + side * bw * 0.42, top + bh * 0.32];
        const tip = [cx + side * bw * (0.30 + (1 - earLift) * 0.32),
            top - bh * 0.22 * earLift + (1 - earLift) * 8 + twitch];
        const ear = new Path().moveTo(...b1).lineTo(...tip).lineTo(...b2).close();
        fill(cr, ear, pal.top);
        stroke(cr, ear, pal.line, 2.2, {join: Cairo.LineJoin.ROUND});
        const c = [(b1[0] + b2[0] + tip[0]) / 3, (b1[1] + b2[1] + tip[1]) / 3];
        const inward = q => [c[0] + (q[0] - c[0]) * 0.5, c[1] + (q[1] - c[1]) * 0.5 + 2];
        fill(cr, new Path().moveTo(...inward(b1)).lineTo(...inward(tip)).lineTo(...inward(b2)).close(), INNER_EAR);
    }
}

function drawBody(cr, f) {
    const {pal, cx, top, by, bw, bh, body} = f;
    const gradient = new Cairo.LinearGradient(cx, top, cx, by);
    gradient.addColorStopRGBA(0, pal.top.r, pal.top.g, pal.top.b, pal.top.a);
    gradient.addColorStopRGBA(1, pal.bottom.r, pal.bottom.g, pal.bottom.b, pal.bottom.a);
    body.apply(cr);
    cr.setSource(gradient);
    cr.fill();
    fill(cr, ellipse(cx - bw * 0.30, top + bh * 0.10, bw * 0.26, bh * 0.16), withAlpha(WHITE, 0.45));
    stroke(cr, body, pal.line, 2.4);
}

// Red headband with a white dot on the forehead, its knot's tails waving behind.
function drawHeadband(cr, f) {
    const {p, cx, top, bw, bh, body} = f, t = p.t;
    clipped(cr, body, () => {
        const band = new Path().moveTo(cx - bw * 0.55, top + bh * 0.30)
            .quadTo(cx, top + bh * 0.08, cx + bw * 0.55, top + bh * 0.30);
        stroke(cr, band, HEADBAND, 7);
        fill(cr, ellipse(cx - 4, top + bh * 0.13, 8, 8), WHITE);
        fill(cr, ellipse(cx - 2.2, top + bh * 0.13 + 1.8, 4.4, 4.4), HEADBAND);
    });
    const kx = cx - p.facing * bw * 0.47;
    const ky = top + bh * 0.28;
    for (let i = 0; i < 2; i++) {
        const wave = Math.sin(t * 6 + i) * 3;
        const tail = new Path().moveTo(kx, ky)
            .quadTo(kx - p.facing * 7, ky - 3 + i * 4, kx - p.facing * 14, ky + 4 + i * 5 + wave);
        stroke(cr, tail, HEADBAND, 3.2, {cap: Cairo.LineCap.ROUND});
    }
}

function drawCheeks(cr, f) {
    const {p, pal, fx, ey, bw} = f;
    const cheekA = pal.cheek.a > 0 ? pal.cheek.a + (p.hovered ? 0.25 : 0) : 0;
    if (cheekA <= 0.01)
        return;
    for (const side of [-1, 1])
        fill(cr, ellipse(fx + side * bw * 0.31 - 6, ey + 3, 12, 6.5), {...pal.cheek, a: Math.min(1, cheekA)});
}

function drawEyes(cr, f) {
    const {p, mood, fx, ey, ex, petted} = f;
    const blink = p.t % 4.3 < 0.13;

    const roundEye = (x, w = 8, h = 10) => {
        if (blink) {
            stroke(cr, line(x - w / 2, ey, x + w / 2, ey), INK, 2.4, ROUND);
            return;
        }
        fill(cr, ellipse(x - w / 2, ey - h / 2, w, h), INK);
        fill(cr, ellipse(x - w / 2 + 1.2, ey - h / 2 + 1.4, 3.4, 3.4), WHITE);
    };
    const arcEye = (x, up) => {
        const end = ey + (up ? 2 : -1);
        stroke(cr, new Path().moveTo(x - 5, end).quadTo(x, ey + (up ? -6 : 4), x + 5, end), INK, 2.6, ROUND);
    };
    const brow = (x, side, inner, outer, width) => {
        stroke(cr, line(x - side * 6, ey - outer, x + side * 4, ey - inner), INK, width, ROUND);
    };

    for (const side of [-1, 1]) {
        const x = fx + side * ex;
        if (p.held) {
            // Startled: wide white eyes with small pupils.
            const eye = ellipse(x - 5.5, ey - 6, 11, 12);
            fill(cr, eye, WHITE);
            stroke(cr, eye, INK, 1.8);
            fill(cr, ellipse(x - 2, ey - 1.5, 4, 4), INK);
            continue;
        }
        switch (mood) {
        case Mood.happy:
            arcEye(x, true);
            break;
        case Mood.celebrating:
            fill(cr, ellipse(x - 5.5, ey - 7, 11, 13), INK);
            fill(cr, ellipse(x - 4, ey - 5.5, 4.5, 4.5), WHITE);
            fill(cr, ellipse(x + 0.8, ey + 1.5, 2.2, 2.2), WHITE);
            break;
        case Mood.focus:
            roundEye(x, 8, 8);
            brow(x, -side, 7.5, 9.5, 2.4);
            break;
        case Mood.annoyed:
            // Half-closed eyes under a flat lid.
            clipped(cr, new Path().rect(x - 6, ey - 0.5, 12, 8), () => {
                fill(cr, ellipse(x - 4, ey - 5, 8, 10), INK);
            });
            stroke(cr, line(x - 5.5, ey - 0.5 - side * 0.8, x + 5.5, ey - 0.5 + side * 0.8), INK, 2.4, ROUND);
            brow(x, -side, 7, 9, 2);
            break;
        case Mood.angry:
            fill(cr, ellipse(x - 3.5, ey - 3, 7, 8), INK);
            brow(x, -side, 4.5, 11, 3.2);
            break;
        case Mood.sleeping:
            arcEye(x, false);
            break;
        default: // normal
            if (petted)
                arcEye(x, true);
            else
                roundEye(x);
        }
    }
}

function drawMouth(cr, f) {
    const {p, mood, pal, fx, my, petted} = f;
    if (p.held) {
        fill(cr, ellipse(fx - 3, my - 1, 6, 7), MOUTH_DARK);
        return;
    }
    if (mood === Mood.focus || (mood === Mood.normal && !petted)) {
        // Little cat mouth.
        const w = new Path().moveTo(fx - 6, my)
            .quadTo(fx - 3, my + 4, fx, my + 0.5)
            .quadTo(fx + 3, my + 4, fx + 6, my);
        stroke(cr, w, pal.line, 2, ROUND);
    } else if (mood === Mood.happy || mood === Mood.normal || mood === Mood.celebrating) {
        // Open smile with a tongue.
        const big = mood === Mood.celebrating ? 1.35 : 1;
        const m = new Path().moveTo(fx - 7 * big, my - 1).quadTo(fx, my + 12 * big, fx + 7 * big, my - 1).close();
        fill(cr, m, MOUTH_DARK);
        clipped(cr, m, () => fill(cr, ellipse(fx - 4 * big, my + 2.5 * big, 8 * big, 6 * big), TONGUE));
        stroke(cr, m, pal.line, 1.6, {join: Cairo.LineJoin.ROUND});
    } else if (mood === Mood.annoyed) {
        const frown = new Path().moveTo(fx - 6, my + 3).curveTo(fx - 2, my - 1.5, fx + 2, my + 5, fx + 6, my + 2);
        stroke(cr, frown, pal.line, 2.2, {cap: Cairo.LineCap.ROUND});
    } else if (mood === Mood.angry) {
        // Gritted teeth.
        const x = fx - 8, y = my - 1.5, w = 16, h = 8;
        const mouth = new Path().roundedRect(x, y, w, h, 3);
        fill(cr, mouth, WHITE);
        const teeth = line(x + 1, y + h / 2, x + w - 1, y + h / 2);
        for (let i = 1; i <= 3; i++)
            teeth.moveTo(x + w * i / 4, y + 0.5).lineTo(x + w * i / 4, y + h - 0.5);
        stroke(cr, teeth, withAlpha(pal.line, 0.6), 1);
        stroke(cr, mouth, pal.line, 1.8);
    } else if (mood === Mood.sleeping) {
        fill(cr, ellipse(fx - 2, my, 4, 3.5), MOUTH_DARK);
        const r = 2 + 3 * Math.abs(Math.sin(p.t * 1.3));
        const bubble = ellipse(fx + 7 - r, my - 5 - r, r * 2, r * 2);
        fill(cr, bubble, rgba(0xBFE6FF, 0.55));
        stroke(cr, bubble, rgba(0x7CB8E0), 1);
    }
}

function drawArms(cr, f) {
    const {p, mood, pal, cx, top, by, bw, bh} = f, t = p.t;
    const armFill = mixRGBA(pal.top, pal.bottom, 0.6);
    const arm = (x, y, angle, w = 11, h = 16) => {
        const e = ellipse(-w / 2, -h / 2, w, h).rotated(angle, x, y);
        fill(cr, e, armFill);
        stroke(cr, e, pal.line, 2);
    };
    const shoulderY = by - bh * 0.36;
    if (p.held) {
        // Arms up in surprise.
        for (const side of [-1, 1])
            arm(cx + side * bw * 0.52, top + bh * 0.32, side * (2.4 + Math.sin(t * 14) * 0.3));
        return;
    }
    if (mood === Mood.celebrating && p.celebration === 'dance') {
        // Disco: one arm up, then the other.
        const up = Math.sin(t * 8) > 0;
        arm(cx - bw * 0.5, up ? top + bh * 0.18 : shoulderY, up ? -2.6 : 0.35);
        arm(cx + bw * 0.5, up ? shoulderY : top + bh * 0.18, up ? -0.35 : 2.6);
    } else if (mood === Mood.celebrating) {
        for (const side of [-1, 1])
            arm(cx + side * bw * 0.5, top + bh * 0.18, side * (2.6 + Math.sin(t * 12) * 0.25));
    } else if (mood === Mood.happy && !p.walking) {
        // Waving.
        arm(cx - bw * 0.5, shoulderY, 0.35);
        arm(cx + bw * 0.52, top + bh * 0.3, -2.3 + Math.sin(t * 8) * 0.45);
    } else if (mood === Mood.annoyed && !p.walking) {
        // Crossed arms.
        for (const [a, b] of [
            [[cx - bw * 0.38, by - bh * 0.14], [cx + bw * 0.14, by - bh * 0.05]],
            [[cx + bw * 0.38, by - bh * 0.14], [cx - bw * 0.14, by - bh * 0.05]],
        ]) {
            const l = line(...a, ...b);
            stroke(cr, l, pal.line, 12, {cap: Cairo.LineCap.ROUND});
            stroke(cr, l, armFill, 8, {cap: Cairo.LineCap.ROUND});
        }
    } else if (mood === Mood.angry) {
        // Shaking fists.
        for (const side of [-1, 1]) {
            const shake = Math.sin(t * 20 + side) * 2;
            const fist = ellipse(cx + side * bw * 0.5 - 6, top + bh * 0.52 + shake - 6, 12, 12);
            fill(cr, fist, armFill);
            stroke(cr, fist, pal.line, 2);
        }
    } else if (mood !== Mood.sleeping) {
        const swing = p.walking ? Math.sin(p.walkPhase) * 0.5 : Math.sin(t * 2) * 0.06;
        arm(cx - bw * 0.5, shoulderY, 0.35 + swing);
        arm(cx + bw * 0.5, shoulderY, -0.35 + swing);
    }
}

// Mood effects around the pet, drawn upright even while the body spins.
function drawEffects(cr, f) {
    const {p, mood, pal, cx, top, bw, bh} = f, t = p.t;
    switch (mood) {
    case Mood.happy:
        [[cx - 42, top + 4], [cx + 43, top - 4], [cx + 30, top - 18]].forEach(([x, y], i) => {
            const sc = 0.45 + 0.55 * Math.abs(Math.sin(t * 3 + i * 2.1));
            fill(cr, sparkle(x, y, 6 * sc), withAlpha(SPARKLE, 0.9));
        });
        break;
    case Mood.celebrating:
        for (let i = 0; i < 16; i++) {
            const seed = i * 7.31;
            const speed = 38 + (seed % 5) * 9;
            const y = (t * speed + seed * 37) % 125 - 8;
            const x = (seed * 53) % 116 + 2 + Math.sin(t * 2 + seed) * 6;
            const piece = new Path().rect(-2, -3.5, 4, 7).rotated(t * 3 + seed, x, y);
            fill(cr, piece, withAlpha(CONFETTI[i % CONFETTI.length], Math.max(0, 1 - y / 125)));
        }
        fill(cr, sparkle(cx - 40, top + 2, 7), SPARKLE);
        fill(cr, sparkle(cx + 40, top - 6, 5), SPARKLE);
        if (p.celebration === 'fireworks')
            drawFireworks(cr, t);
        if (p.golden) {
            for (let i = 0; i < 6; i++) {
                const a = t * 1.5 + i / 6 * 2 * Math.PI;
                const r = 4 + 2 * Math.abs(Math.sin(t * 5 + i));
                fill(cr, sparkle(cx + Math.cos(a) * bw * 0.75, f.by - bh * 0.5 + Math.sin(a) * bh * 0.8, r), GOLD_SPARKLE);
            }
        }
        break;
    case Mood.annoyed: {
        const slide = (t * 5) % 9;
        const sweat = drop(cx + bw * 0.40, top + bh * 0.12 + slide);
        fill(cr, sweat, rgba(0x9ED8FF));
        stroke(cr, sweat, rgba(0x3A8DC7), 1.2);
        break;
    }
    case Mood.angry:
        drawAngerMark(cr, cx + bw * 0.36, top + 2, 15 * (1 + 0.15 * Math.sin(t * 8)));
        // Steam puffs rising from both sides of the head.
        for (let i = 0; i < 3; i++) {
            const ph = (t * 0.9 + i / 3) % 1;
            const r = 3 + ph * 6;
            for (const side of [-1, 1]) {
                const puff = ellipse(cx + side * (bw * 0.42 + ph * 10) - r, top + 10 - ph * 26 - r, r * 2, r * 2);
                fill(cr, puff, withAlpha(WHITE, (1 - ph) * 0.85));
                stroke(cr, puff, withAlpha(STEAM_EDGE, (1 - ph) * 0.5), 1);
            }
        }
        break;
    case Mood.sleeping:
        for (let i = 0; i < 3; i++) {
            const ph = (t * 0.35 + i / 3) % 1;
            drawText(cr, 'Z', cx + 24 + ph * 18, top - 2 - ph * 24, 9 + ph * 7,
                withAlpha(pal.line, Math.sin(ph * Math.PI)), {weight: Pango.Weight.HEAVY, outline: 0.03});
        }
        break;
    default:
        break;
    }
    if (f.petted) {
        const ph = (t * 0.6) % 1;
        drawText(cr, '♥', cx - 30, top - ph * 18, 12 + ph * 4, rgba(0xFF5C8A, 1 - ph),
            {weight: Pango.Weight.BOLD, outline: 0.1});
    }
}

// --- Life: growth, dirt, accessories, flies, hunger, treats ---

// Young pets have little leaves on their head: one points up-right, a second one up-left.
function drawSprouts(cr, f) {
    const {p, cx, top} = f;
    stroke(cr, new Path().moveTo(cx, top + 1).quadTo(cx - 2, top - 3, cx + 1, top - 7), STEM, 1.8,
        {cap: Cairo.LineCap.ROUND});
    const sway = Math.sin(p.t * 2.5) * 0.15;
    for (const angle of p.sprouts >= 2 ? [Math.PI + 0.6, -0.6] : [-0.6]) {
        const leaf = ellipse(0, -2.6, 9, 5.2).rotated(angle + sway, cx + 1, top - 7);
        fill(cr, leaf, LEAF);
        stroke(cr, leaf, STEM, 1);
    }
}

// Smudges on the body after lazy days: three more for each day of dirt.
function drawDirt(cr, f) {
    const {p, cx, by, bw, bh, body} = f;
    clipped(cr, body, () => {
        for (let i = 0; i < p.dirt * 3; i++) {
            const a = i * 2.39996, r = 0.25 + 0.2 * (i % 3);
            const x = cx + Math.cos(a) * r * bw * 0.9, y = by - bh * 0.45 + Math.sin(a) * r * bh * 0.8;
            const w = 4 + (i % 3) * 2;
            fill(cr, ellipse(x - w / 2, y - w / 3, w, w * 0.66), SMUDGE);
        }
    });
}

// Red knitted scarf around the neck, one end hanging down.
function drawScarf(cr, f) {
    const {p, cx, by, bw, bh, body} = f;
    clipped(cr, body, () => {
        const band = new Path().moveTo(cx - bw * 0.55, by - bh * 0.40)
            .quadTo(cx, by - bh * 0.26, cx + bw * 0.55, by - bh * 0.40);
        stroke(cr, band, SCARF, 7);
        stroke(cr, band, withAlpha(WHITE, 0.5), 7, {dash: [2, 5]});
    });
    const tail = new Path().roundedRect(-3, 0, 6, 13, 2)
        .rotated(0.25 + Math.sin(p.t * 4) * 0.08, cx + bw * 0.22, by - bh * 0.33);
    fill(cr, tail, SCARF);
}

function drawSunglasses(cr, f) {
    const {fx, ey, ex} = f;
    for (const side of [-1, 1]) {
        const x = fx + side * ex - 7, y = ey - 4.5;
        fill(cr, new Path().roundedRect(x, y, 14, 9, 3.5), SHADES);
        stroke(cr, line(x + 3, y + 2.5, x + 6, y + 2.5), withAlpha(WHITE, 0.7), 1.4, {cap: Cairo.LineCap.ROUND});
    }
    stroke(cr, line(fx - ex + 7, ey - 1.5, fx + ex - 7, ey - 1.5), SHADES, 1.6);
}

// Swift draws the bow, top hat, crown and grad cap as emoji (🎀 🎩 👑 🎓). They are drawn as shapes here, shaped,
// sized and placed like the Apple Color Emoji pictures in docs/life.png, so they look the same on every system
// and never depend on an emoji font. Each one is drawn in units of the emoji's font size, around the point where
// Swift draws the emoji.
function inEmojiBox(cr, x, y, size, draw) {
    cr.save();
    try {
        cr.translate(x, y);
        cr.scale(size, size);
        draw();
    } finally {
        cr.restore();
    }
}

// A gradient in emoji-box units from [offset, hex] stops. Built once when the module loads and only read after.
function gradient(x0, y0, x1, y1, stops) {
    const g = new Cairo.LinearGradient(x0, y0, x1, y1);
    for (const [offset, hex] of stops) {
        const c = rgba(hex);
        g.addColorStopRGBA(offset, c.r, c.g, c.b, c.a);
    }
    return g;
}

function paintPath(cr, path, pattern) {
    path.apply(cr);
    cr.setSource(pattern);
    cr.fill();
}

const BOW = {
    tail: gradient(0, 0, 0, 0.5, [[0, 0xD5628C], [1, 0xE67FA8]]),
    left: gradient(-0.64, 0, -0.08, 0, [[0, 0xF98AAF], [0.5, 0xDD6B94], [1, 0xC9567F]]),
    right: gradient(0.08, 0, 0.64, 0, [[0, 0xF98AAF], [0.5, 0xF07EA6], [1, 0xCB5B85]]),
    knot: gradient(0, -0.3, 0, 0.06, [[0, 0xF890B4], [1, 0xDC6A92]]),
    crease: rgba(0xA3405A, 0.9),
};

function drawBow(cr, x, y, size) {
    inEmojiBox(cr, x, y, size, () => {
        // Tails with notched ends, behind the loops.
        paintPath(cr, new Path().moveTo(-0.3, 0.02).lineTo(-0.48, 0.43).lineTo(-0.36, 0.38).lineTo(-0.2, 0.47)
            .lineTo(-0.04, 0.04).close(), BOW.tail);
        paintPath(cr, new Path().moveTo(0.04, 0.02).lineTo(0.12, 0.5).lineTo(0.26, 0.42).lineTo(0.4, 0.49)
            .lineTo(0.28, 0.02).close(), BOW.tail);
        // Puffy loops, the right one a little higher, lit from the upper left.
        paintPath(cr, new Path().moveTo(-0.08, -0.12).curveTo(-0.25, -0.32, -0.45, -0.56, -0.58, -0.5)
            .curveTo(-0.69, -0.45, -0.69, 0.08, -0.58, 0.13).curveTo(-0.45, 0.17, -0.2, 0.08, -0.08, 0.02).close(),
        BOW.left);
        paintPath(cr, new Path().moveTo(0.08, -0.14).curveTo(0.25, -0.36, 0.45, -0.6, 0.57, -0.54)
            .curveTo(0.68, -0.48, 0.69, 0.09, 0.58, 0.14).curveTo(0.45, 0.18, 0.2, 0.08, 0.08, 0.02).close(), BOW.right);
        // The knot and the shadow it casts where the tails start.
        fill(cr, ellipse(-0.18, -0.04, 0.36, 0.12), BOW.crease);
        paintPath(cr, new Path().roundedRect(-0.14, -0.3, 0.28, 0.34, 0.12), BOW.knot);
    });
}

const TOP_HAT = {
    brim: rgba(0x2A2A2E),
    brimTop: rgba(0x4A4A4E),
    crown: gradient(-0.37, 0, 0.37, 0, [[0, 0x55575A], [0.12, 0x34353A], [0.55, 0x0E0E16], [0.85, 0x2A2D32],
        [1, 0x6E7275]]),
    top: rgba(0x77797C, 0.8),
    band: gradient(-0.37, 0, 0.37, 0, [[0, 0x936F15], [0.07, 0xE8D25A], [0.2, 0xFEFCAE], [0.36, 0xF9EE81],
        [0.43, 0xC8A32B], [0.5, 0x936004], [0.6, 0x643500], [0.7, 0x8A5400], [0.8, 0xB98900], [1, 0x9F6E02]]),
};

function drawTopHat(cr, x, y, size) {
    inEmojiBox(cr, x, y, size, () => {
        // A thick, upturned brim with round ends, then the crown standing on it with its gold band.
        stroke(cr, new Path().moveTo(-0.5, 0.25).quadTo(0, 0.57, 0.5, 0.25), TOP_HAT.brim, 0.2, ROUND);
        stroke(cr, new Path().moveTo(-0.5, 0.2).quadTo(0, 0.5, 0.5, 0.2), TOP_HAT.brimTop, 0.06, ROUND);
        paintPath(cr, new Path().moveTo(-0.37, -0.32).quadTo(-0.37, -0.36, -0.33, -0.36).lineTo(0.33, -0.36)
            .quadTo(0.37, -0.36, 0.37, -0.32).lineTo(0.37, 0.31).quadTo(0, 0.38, -0.37, 0.31).close(), TOP_HAT.crown);
        fill(cr, new Path().moveTo(-0.35, -0.35).lineTo(0.35, -0.35).lineTo(0.37, -0.32).lineTo(-0.37, -0.32).close(),
            TOP_HAT.top);
        paintPath(cr, new Path().moveTo(-0.37, 0.13).quadTo(0, 0.18, 0.37, 0.13).lineTo(0.37, 0.31)
            .quadTo(0, 0.38, -0.37, 0.31).close(), TOP_HAT.band);
    });
}

const CROWN = {
    back: gradient(-0.5, 0, 0.44, 0, [[0, 0xC4920F], [0.5, 0xB98A1E], [1, 0xA0700E]]),
    front: gradient(-0.56, 0, 0.5, 0, [[0, 0xCD9A0F], [0.2, 0xD7A50C], [0.42, 0xF2CA44], [0.55, 0xF9D846],
        [0.68, 0xD9AD34], [0.85, 0xA37A0D], [1, 0x9B6600]]),
    rim: rgba(0xC79A1C, 0.5),
    frontBall: rgba(0xF6DC5A),
    backBall: rgba(0xC9A030),
    green: rgba(0x12A877),
    pink: rgba(0xD547A8),
    teal: rgba(0x0E9873),
    shine: rgba(0xFFFFFF, 0.55),
};

function drawCrown(cr, x, y, size) {
    inEmojiBox(cr, x, y, size, () => {
        // Two spikes at the back, seen between the three at the front.
        const back = [[-0.25, -0.38], [0.19, -0.38]];
        paintPath(cr, new Path().moveTo(-0.44, 0.12).lineTo(...back[0]).lineTo(-0.1, 0.02).lineTo(0.04, 0.02)
            .lineTo(...back[1]).lineTo(0.38, 0.12).close(), CROWN.back);
        const front = [[-0.53, -0.22], [-0.02, -0.3], [0.44, -0.22]];
        paintPath(cr, new Path().moveTo(-0.45, 0.42).lineTo(-0.56, 0.12).lineTo(...front[0])
            .quadTo(-0.42, 0.06, -0.3, 0.1).quadTo(-0.18, 0.1, -0.1, 0.0).lineTo(...front[1])
            .lineTo(0.08, 0.0).quadTo(0.16, 0.1, 0.27, 0.1).quadTo(0.38, 0.06, front[2][0], front[2][1])
            .lineTo(0.5, 0.12).lineTo(0.42, 0.42).quadTo(0, 0.5, -0.45, 0.42).close(), CROWN.front);
        fill(cr, new Path().moveTo(-0.45, 0.42).lineTo(-0.5, 0.3).quadTo(0, 0.38, 0.46, 0.3).lineTo(0.42, 0.42)
            .quadTo(0, 0.5, -0.45, 0.42).close(), CROWN.rim);
        for (const [bx, by] of back)
            fill(cr, ellipse(bx - 0.06, by - 0.07, 0.12, 0.12), CROWN.backBall);
        for (const [fx, fy] of front)
            fill(cr, ellipse(fx - 0.065, fy - 0.075, 0.13, 0.13), CROWN.frontBall);
        // Gems: green in the middle, pink beside it, teal on the sides.
        for (const [gx, gy, rx, ry, color] of [[0.02, 0.27, 0.085, 0.1, CROWN.green], [-0.2, 0.24, 0.06, 0.065, CROWN.pink],
            [0.3, 0.25, 0.055, 0.06, CROWN.pink], [-0.55, 0.17, 0.05, 0.08, CROWN.teal], [0.49, 0.18, 0.045, 0.075, CROWN.teal]]) {
            fill(cr, ellipse(gx - rx, gy - ry, 2 * rx, 2 * ry), color);
            fill(cr, ellipse(gx - rx * 0.55, gy - ry * 0.65, rx * 0.6, ry * 0.5), CROWN.shine);
        }
    });
}

const GRAD_CAP = {
    skull: gradient(-0.22, 0, 0.3, 0, [[0, 0x1E1C1A], [0.45, 0x4A4948], [0.75, 0x3A3939], [1, 0x1E1E1E]]),
    edge: rgba(0x45444A),
    board: gradient(-0.52, -0.5, 0.47, 0, [[0, 0x2F2F2F], [1, 0x1B1B1B]]),
    button: rgba(0x424242),
    cord: rgba(0xD99A33),
    tassel: gradient(-0.4, 0, -0.27, 0, [[0, 0xF2B04A], [1, 0xD48A22]]),
};

function drawGradCap(cr, x, y, size) {
    inEmojiBox(cr, x, y, size, () => {
        paintPath(cr, new Path().moveTo(-0.24, -0.1).lineTo(0.3, -0.12).lineTo(0.3, 0.14)
            .curveTo(0.3, 0.3, 0.15, 0.36, 0.03, 0.36).curveTo(-0.1, 0.36, -0.24, 0.3, -0.24, 0.16).close(), GRAD_CAP.skull);
        // The mortarboard, its thickness showing along the lower edges.
        const board = [[-0.04, -0.52], [0.48, -0.22], [0.02, 0.02], [-0.53, -0.19]];
        const lower = new Path().moveTo(board[0][0], board[0][1] + 0.05);
        board.slice(1).forEach(([bx, by]) => lower.lineTo(bx, by + 0.06));
        fill(cr, lower.close(), GRAD_CAP.edge);
        const top = new Path().moveTo(...board[0]);
        board.slice(1).forEach(b => top.lineTo(...b));
        paintPath(cr, top.close(), GRAD_CAP.board);
        fill(cr, ellipse(-0.09, -0.27, 0.1, 0.09), GRAD_CAP.button);
        // The tassel's cord runs to the left corner and hangs down.
        for (const dx of [0, 0.045]) {
            stroke(cr, new Path().moveTo(-0.05 + dx, -0.22).lineTo(-0.33 + dx, -0.06).lineTo(-0.33 + dx, 0.2),
                GRAD_CAP.cord, 0.035, ROUND);
        }
        paintPath(cr, new Path().moveTo(-0.35, 0.14).lineTo(-0.27, 0.14).lineTo(-0.25, 0.47).lineTo(-0.39, 0.47).close(),
            GRAD_CAP.tassel);
    });
}

// What the pet wears, in the order it put things on.
function drawAccessories(cr, f) {
    const {p, mood, cx, top, bw} = f;
    for (const accessory of p.wearing) {
        switch (accessory) {
        case 'scarf':
            drawScarf(cr, f);
            break;
        case 'sunglasses':
            if (mood !== Mood.sleeping && !p.held)
                drawSunglasses(cr, f);
            break;
        case 'bow':
            drawBow(cr, cx + bw * 0.30, top + 5, 15);
            break;
        case 'tophat':
            drawTopHat(cr, cx, top - 6, 23);
            break;
        case 'crown':
            drawCrown(cr, cx, top - 3, 20);
            break;
        case 'gradcap':
            drawGradCap(cr, cx, top - 6, 23);
            break;
        default:
            break;
        }
    }
}

// Three bursts of colored dots in the sky, each growing and fading in turn.
function drawFireworks(cr, t) {
    // Swift: x = 60 + [-32, 30, 2], y = [22, 14, 6].
    const centers = [[28, 22], [90, 14], [62, 6]];
    for (let k = 0; k < 3; k++) {
        const ph = (t * 1.1 + k / 3) % 1;
        const radius = 4 + ph * 18;
        for (let j = 0; j < 10; j++) {
            const a = j / 10 * 2 * Math.PI;
            const x = centers[k][0] + Math.cos(a) * radius, y = centers[k][1] + Math.sin(a) * radius;
            fill(cr, ellipse(x - 1.6, y - 1.6, 3.2, 3.2), withAlpha(CONFETTI[(j + k) % CONFETTI.length], 1 - ph));
        }
    }
}

// Flies buzz around a pet left dirty for days: one on the second day, two on the third.
function drawFlies(cr, f) {
    const {p, cx, top, bw} = f, t = p.t;
    const wing = Math.abs(Math.sin(t * 40)) * 2.5 + 1;
    for (let i = 0; i < p.dirt - 1; i++) {
        const a = t * (3 + i) + i * 2.5;
        const x = cx + Math.cos(a) * bw * 0.72, y = top - 6 + Math.sin(a * 1.7) * 7;
        fill(cr, ellipse(x - 2.5, y - wing - 1, 3, wing), withAlpha(WHITE, 0.8));
        fill(cr, ellipse(x - 0.5, y - wing - 1, 3, wing), withAlpha(WHITE, 0.8));
        fill(cr, ellipse(x - 2, y - 1.5, 4, 3), withAlpha(BLACK, 0.85));
    }
}

// A hungry tummy rumbles: two squiggles by the belly.
function drawRumble(cr, f) {
    const {pal, cx, by, bw, bh} = f;
    for (let i = 0; i < 2; i++) {
        const x0 = cx + bw * 0.48 + i * 4, y0 = by - bh * 0.28 + i * 6;
        const squiggle = new Path().moveTo(x0, y0).curveTo(x0 + 2, y0 - 3, x0 + 6, y0 + 3, x0 + 8, y0);
        stroke(cr, squiggle, withAlpha(pal.line, 0.7), 1.4, {cap: Cairo.LineCap.ROUND});
    }
}

// The treat for a finished task falls into the pet's mouth, then a "nom!" floats up and fades.
function drawFood(cr, f) {
    const {p, pal, fx, my} = f;
    if (p.foodT < 0.7) {
        const k = p.foodT / 0.7;
        drawEmoji(cr, p.food, fx, my * k * k, 17);
    } else {
        const fade = 1 - (p.foodT - 0.7) / 0.9;
        drawText(cr, L('măm!', 'nom!'), fx + 24, my - 10 - (1 - fade) * 8, 10, withAlpha(pal.line, fade),
            {weight: Pango.Weight.HEAVY, outline: 0.03});
    }
}

// Draws the pet for `pose` (see defaultPose) in a width × height area: the 120×120 design space is scaled to
// fit and centered, as PetArt.draw does. Leaves the context's saved state (transform, clip, source, line style)
// as it found it, even when drawing throws. Like any Cairo drawing it clears the current path, which save()
// does not keep: a path the caller was still building is dropped, never used as part of the pet's clip.
export function drawPet(cr, width, height, pose) {
    const s = Math.min(width, height) / 120;
    if (!(s > 0) || !Number.isFinite(s))
        return;
    cr.save();
    try {
        // Confetti, steam and Zz never spill onto whatever is drawn next to the pet.
        cr.newPath();
        cr.rectangle(0, 0, width, height);
        cr.clip();
        cr.translate((width - 120 * s) / 2, (height - 120 * s) / 2);
        cr.scale(s, s);

        // Growth stage: smaller when young, scaled around the point where the feet touch the ground.
        const g = pose.stageScale > 0 ? pose.stageScale : 1;
        cr.translate(60, 113);
        cr.scale(g, g);
        cr.translate(-60, -113);
        drawFrame(cr, pose);
    } finally {
        cr.restore();
    }
}

function drawFrame(cr, p) {
    const k = clamp01(p.blend);
    const mood = p.held ? Mood.normal : p.mood;
    const celebrating = mood === Mood.celebrating;
    const pal = celebrating && p.golden
        ? GOLDEN_PALETTE
        : mixPalette(petPalette(p.prevMood), petPalette(p.mood), k * k * (3 - 2 * k));

    const {jump, squash, shakeX, breathe, spinX, flipAngle} = bodyMoves(p, mood);
    const cx = 60 + shakeX;
    const ground = 113;
    const bw = 72 * (1 + squash) * (p.hungry && !celebrating ? 0.9 : 1);
    const bh = 60 * (1 - squash) * (1 + breathe);
    const by = ground - 5 - jump;
    const top = by - bh;

    // Shadow on the ground.
    const shW = 56 * (1 - Math.min(jump, 30) / 60);
    fill(cr, ellipse(60 - shW / 2, ground - 3.5, shW, 7), withAlpha(BLACK, p.held ? 0.06 : 0.16));

    // The face looks where the pet walks or where it is told to look.
    const look = p.walking ? p.facing * 0.8 : p.lookX;
    const fx = cx + look * bw * 0.07;
    const ey = top + bh * 0.48;
    const f = {
        p, mood, pal, cx, by, bw, bh, top, fx, ey,
        ex: bw * 0.185,
        my: ey + bh * 0.21,
        petted: p.hovered && (mood === Mood.normal || mood === Mood.happy),
        body: bodyPath(cx, top, by, bw, bh),
    };

    // Spins and back-flips turn the whole body around its middle; effects drawn after restore() stay put.
    cr.save();
    try {
        if (spinX !== 1 || flipAngle !== 0) {
            const midY = by - bh / 2;
            cr.translate(cx, midY);
            if (flipAngle !== 0)
                cr.rotate(flipAngle * -p.facing);
            if (spinX !== 1)
                cr.scale(Math.max(Math.abs(spinX), 0.12) * (spinX < 0 ? -1 : 1), 1);
            cr.translate(-cx, -midY);
        }
        drawFeet(cr, f);
        drawEars(cr, f);
        drawBody(cr, f);
        if (mood === Mood.focus)
            drawHeadband(cr, f);
        drawCheeks(cr, f);
        drawEyes(cr, f);
        drawMouth(cr, f);
        drawArms(cr, f);
        if (p.sprouts > 0)
            drawSprouts(cr, f);
        if (p.dirt > 0 && !celebrating)
            drawDirt(cr, f);
        drawAccessories(cr, f);
    } finally {
        cr.restore();
    }

    drawEffects(cr, f);
    if (p.dirt >= 2 && !celebrating)
        drawFlies(cr, f);
    if (p.hungry && !celebrating && mood !== Mood.sleeping && Math.sin(p.t * 1.6) > 0.3)
        drawRumble(cr, f);
    if (p.food && p.foodT < 1.6)
        drawFood(cr, f);
}

// --- The sign the pet drags during a parade (SignView in Antics.swift) ---

// Sizes in pixels, as SwiftUI points: an outer margin, the board's padding, its widest text and corner radius.
const SIGN_MARGIN = 6;
const SIGN_PAD_X = 12;
const SIGN_PAD_Y = 8;
const SIGN_TEXT_WIDTH = 240;
const SIGN_RADIUS = 7;
const SIGN_ROPE = {width: 22, height: 3};
const SIGN_FONT_SIZE = 14;
// SF Rounded's line height at 14 pt; the system Sans font would make the board taller.
const SIGN_LINE_HEIGHT = 17;
// Extra stroke around the letters, standing in for SF Rounded Heavy's weight.
const SIGN_TEXT_OUTLINE = 0.6;
const SIGN_TOP = {r: 0.62, g: 0.40, b: 0.22, a: 1};
const SIGN_BOTTOM = {r: 0.45, g: 0.27, b: 0.13, a: 1};
const SIGN_EDGE = {r: 0.30, g: 0.17, b: 0.08, a: 1};
const SIGN_ROPE_COLOR = {r: 0.55, g: 0.42, b: 0.25, a: 1};
// SwiftUI's .shadow(color: .black.opacity(0.25), radius: 3, y: 2).
const SIGN_SHADOW = {alpha: 0.25, sigma: 3, y: 2};

// Graphemes drawn from the color emoji font: emoji-style characters, flags and keycaps.
const COLOR_EMOJI = /\p{Emoji_Presentation}|\p{Regional_Indicator}|\u{FE0F}|\u{20E3}/u;
const signGraphemes = new Intl.Segmenter('und', {granularity: 'grapheme'});
const utf8 = new TextEncoder();

// Standard normal cumulative distribution (Abramowitz and Stegun 7.1.26, error below 1.5e-7).
function normalCDF(x) {
    const z = Math.abs(x) / Math.SQRT2;
    const k = 1 / (1 + 0.3275911 * z);
    const erf = 1 - k * (0.254829592 + k * (-0.284496736 + k * (1.421413741 + k * (-1.453152027 + k * 1.061405429)))) *
        Math.exp(-z * z);
    return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

const signFont = (() => {
    const font = Pango.FontDescription.from_string('Sans');
    font.set_weight(Pango.Weight.HEAVY);
    font.set_absolute_size(SIGN_FONT_SIZE * Pango.SCALE);
    return font;
})();

function signLayout(context, label, attrs) {
    const layout = Pango.Layout.new(context);
    layout.set_font_description(signFont);
    layout.set_alignment(Pango.Alignment.CENTER);
    layout.set_wrap(Pango.WrapMode.WORD_CHAR);
    layout.set_ellipsize(Pango.EllipsizeMode.END);
    layout.set_text(label, -1);
    layout.set_attributes(attrs);
    return layout;
}

const lineHeight = () => Pango.attr_line_height_new_absolute(SIGN_LINE_HEIGHT * Pango.SCALE);

function attrRange(attr, start, end) {
    attr.start_index = start;
    attr.end_index = end;
    return attr;
}

// The sign's text, laid out once at 1× like SwiftUI's Text: "📌 TITLE" in heavy white capitals, centered, wrapped
// at 240 px, at most two lines, with an ellipsis. Two layouts of it break into the same lines:
// - `letters` has every color emoji replaced by an empty box just as wide, so its outlines are the letters alone;
// - `emoji` is the whole text with the letters made transparent (Pango ignores that alpha for color emoji), so
//   showing it draws only the emoji, in color.
// `plain` is the whole text as is, the fallback should the two ever break differently.
function signText(text) {
    const title = shortText(String(text ?? '').replace(/[\r\n\u2028\u2029]+/g, ' '), 48).toUpperCase();
    const label = `📌 ${title}`;
    const context = PangoCairo.FontMap.get_default().create_context();
    const letterAttrs = new Pango.AttrList(), emojiAttrs = new Pango.AttrList(), plainAttrs = new Pango.AttrList();
    for (const list of [letterAttrs, emojiAttrs, plainAttrs])
        list.insert(lineHeight());
    const measure = signLayout(context, '', new Pango.AttrList());
    let start = 0;
    for (const {segment} of signGraphemes.segment(label)) {
        const end = start + utf8.encode(segment).length;
        if (COLOR_EMOJI.test(segment)) {
            // Its first character becomes a box as wide and tall as the emoji, the rest boxes of no width.
            measure.set_text(segment, -1);
            const [, size] = measure.get_extents();
            const box = new Pango.Rectangle({x: 0, y: -measure.get_baseline(), width: size.width, height: size.height});
            const none = new Pango.Rectangle({x: 0, y: box.y, width: 0, height: box.height});
            const first = start + utf8.encode(String.fromCodePoint(segment.codePointAt(0))).length;
            letterAttrs.insert(attrRange(Pango.AttrShape.new(box, box), start, first));
            if (first < end)
                letterAttrs.insert(attrRange(Pango.AttrShape.new(none, none), first, end));
        } else {
            // Alpha 0 means "unset" to Pango, so the hidden letters get the lowest real alpha.
            emojiAttrs.insert(attrRange(Pango.attr_foreground_alpha_new(1), start, end));
        }
        start = end;
    }
    const plain = signLayout(context, label, plainAttrs);
    // Like .frame(maxWidth: 240): as wide as one line of text, up to 240, where it wraps.
    const [, natural] = plain.get_extents();
    const textWidth = Math.min(SIGN_TEXT_WIDTH, Math.ceil(natural.width / Pango.SCALE));
    const layouts = [plain, signLayout(context, label, letterAttrs), signLayout(context, label, emojiAttrs)];
    for (const layout of layouts) {
        layout.set_width(SIGN_TEXT_WIDTH * Pango.SCALE);
        layout.set_height(-2);
    }
    const [, logical] = plain.get_extents();
    const lines = layout => Array.from({length: layout.get_line_count()}, (_, i) => {
        const line = layout.get_line_readonly(i);
        return `${line.start_index}+${line.length}`;
    }).join(' ');
    const [, letters, emoji] = layouts;
    // Each line is as tall as one of SF's, as in SwiftUI; the laid-out text is centered in that height.
    const textHeight = plain.get_line_count() * SIGN_LINE_HEIGHT;
    return {
        plain, letters, emoji,
        split: lines(letters) === lines(plain) && lines(emoji) === lines(plain),
        textWidth, textHeight,
        textY: (textHeight - logical.height / Pango.SCALE) / 2 - logical.y / Pango.SCALE,
    };
}

// The last sign laid out: {text, geometry}. Laying the text out takes about 1.6 ms and the parade sizes and draws the
// same sign again and again; one entry is enough, as one sign is on screen at a time.
let signCache = null;

// The sign for `text`, laid out: its layouts, the board's size and the whole sign's size (with the margin and the
// rope). The same text gives back the same (shared, read-only) object until another text is laid out.
export function signGeometry(text) {
    const key = String(text ?? '');
    if (signCache?.text === key)
        return signCache.geometry;
    const t = signText(key);
    const boardWidth = t.textWidth + 2 * SIGN_PAD_X;
    const boardHeight = t.textHeight + 2 * SIGN_PAD_Y;
    const geometry = Object.freeze({
        ...t, boardWidth, boardHeight,
        width: 2 * SIGN_MARGIN + boardWidth + SIGN_ROPE.width,
        height: 2 * SIGN_MARGIN + boardHeight,
    });
    signCache = {text: key, geometry};
    return geometry;
}

// The size the sign wants for `text`, in pixels (the panel's fittingSize in Swift).
export function signSize(text) {
    const {width, height} = signGeometry(text);
    return {width, height};
}

// Soft drop shadow under the board: rings of the board's shape, each a little larger and fainter, add up to a
// Gaussian blur of the edge. Inside the board it is hidden, so it starts just under the border.
function drawSignShadow(cr, x, y, w, h) {
    const {alpha, sigma} = SIGN_SHADOW;
    const step = 0.75, from = -1, to = 3 * sigma;
    // Shadow opacity at `d` px outside the board's edge.
    const target = d => alpha * (1 - normalCDF(d / sigma));
    for (let d = from; d < to; d += step) {
        // This ring and the larger ones drawn over it must add up to target(d).
        const outer = Math.min(target(d + step), 0.999);
        const a = 1 - (1 - target(d)) / (1 - outer);
        if (a <= 0)
            continue;
        const e = d + step;
        const ring = new Path().roundedRect(x - e, y + SIGN_SHADOW.y - e, w + 2 * e, h + 2 * e, Math.max(0, SIGN_RADIUS + e));
        fill(cr, ring, {r: 0, g: 0, b: 0, a});
    }
}

function drawSignBoard(cr, g, x, y) {
    const w = g.boardWidth, h = g.boardHeight;
    const board = new Path().roundedRect(x, y, w, h, SIGN_RADIUS);
    drawSignShadow(cr, x, y, w, h);
    const gradient = new Cairo.LinearGradient(0, y, 0, y + h);
    gradient.addColorStopRGBA(0, SIGN_TOP.r, SIGN_TOP.g, SIGN_TOP.b, 1);
    gradient.addColorStopRGBA(1, SIGN_BOTTOM.r, SIGN_BOTTOM.g, SIGN_BOTTOM.b, 1);
    board.apply(cr);
    cr.setSource(gradient);
    cr.fill();

    // The 240 px text box is centered on the board.
    const tx = x + w / 2 - SIGN_TEXT_WIDTH / 2, ty = y + SIGN_PAD_Y + g.textY;
    setColor(cr, WHITE);
    cr.newPath();
    if (g.split) {
        // Letters as filled outlines: grayscale antialiasing (no colored subpixel fringes on the white text),
        // thickened a little with round joins to come closer to SF Rounded Heavy. Then the emoji, in color.
        cr.moveTo(tx, ty);
        PangoCairo.layout_path(cr, g.letters);
        cr.fillPreserve();
        cr.setLineWidth(SIGN_TEXT_OUTLINE);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.stroke();
        cr.moveTo(tx, ty);
        PangoCairo.show_layout(cr, g.emoji);
    } else {
        cr.moveTo(tx, ty);
        PangoCairo.show_layout(cr, g.plain);
    }
    cr.newPath();

    stroke(cr, board, SIGN_EDGE, 2);
}

function drawSignRope(cr, x, boardY, boardHeight) {
    const {width, height} = SIGN_ROPE;
    fill(cr, new Path().roundedRect(x, boardY + (boardHeight - height) / 2, width, height, height / 2), SIGN_ROPE_COLOR);
}

// Draws the parade sign for the task `text` in a width × height area: a wooden board with the title and a rope on
// the side facing the pet (`ropeOnRight` when the pet walks right, ahead of the sign). The sign keeps its natural
// size (signSize) when it fits, shrinks to fit otherwise, and is centered. Leaves the context's state as it found it.
export function drawSign(cr, width, height, text, {ropeOnRight = true} = {}) {
    const g = signGeometry(text);
    const k = Math.min(1, width / g.width, height / g.height);
    if (!(k > 0) || !Number.isFinite(k))
        return;
    cr.save();
    try {
        cr.newPath();
        cr.translate((width - g.width * k) / 2, (height - g.height * k) / 2);
        cr.scale(k, k);
        const y = SIGN_MARGIN;
        // Drawn in HStack order: [rope] board [rope].
        if (!ropeOnRight)
            drawSignRope(cr, SIGN_MARGIN, y, g.boardHeight);
        const boardX = SIGN_MARGIN + (ropeOnRight ? 0 : SIGN_ROPE.width);
        drawSignBoard(cr, g, boardX, y);
        if (ropeOnRight)
            drawSignRope(cr, boardX + g.boardWidth, y, g.boardHeight);
    } finally {
        cr.restore();
    }
}
