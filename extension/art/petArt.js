// Draws "Mochi", the pet (port of PetArt.swift), with Cairo. Shapes, colors and timings follow the Swift code
// in its 120×120 design space. Imports only Cairo, Pango and core/, so tests and tools/snapshot.js can load it
// outside GNOME Shell, and an St.DrawingArea can call drawPet(cr, width, height, pose) on repaint.
import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

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

const palette = (top, bottom, line, cheek) => Object.freeze({top, bottom, line, cheek});

const PALETTES = Object.freeze({
    happy: palette(rgba(0xFFE9CC), rgba(0xFFBA8A), rgba(0x8A4B2A), rgba(0xFF6F96, 0.55)),
    normal: palette(rgba(0xFFF0DE), rgba(0xF4C69C), rgba(0x7A4A30), rgba(0xFF8FA3, 0.40)),
    annoyed: palette(rgba(0xEFE6DC), rgba(0xC4B09E), rgba(0x5E4A3E), rgba(0xC98F8F, 0.20)),
    angry: palette(rgba(0xFFB49C), rgba(0xEA5A45), rgba(0x6E1D12), rgba(0xB02A1E, 0.0)),
    sleeping: palette(rgba(0xEAE7F8), rgba(0xB9B2DE), rgba(0x4D4775), rgba(0xFF9FB8, 0.28)),
});

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

function stroke(cr, path, color, width, {cap = Cairo.LineCap.BUTT, join = Cairo.LineJoin.MITER} = {}) {
    path.apply(cr);
    setColor(cr, color);
    cr.setLineWidth(width);
    cr.setLineCap(cap);
    cr.setLineJoin(join);
    cr.stroke();
}

const ROUND = {cap: Cairo.LineCap.ROUND, join: Cairo.LineJoin.ROUND};

// Draws inside `path` only, like SwiftUI's drawLayer { $0.clip(to:) }.
function clipped(cr, path, draw) {
    cr.save();
    path.apply(cr);
    cr.clip();
    draw();
    cr.restore();
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
    // Opaque inside a group, then faded as a whole, so the outline doesn't darken where it overlaps the fill.
    cr.pushGroup();
    cr.newPath();
    cr.save();
    cr.translate(x, y);
    cr.scale(size / GLYPH_SIZE, size / GLYPH_SIZE);
    cr.appendPath(glyphOutline(text, weight));
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
    cr.popGroupToSource();
    cr.paintWithAlpha(color.a);
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

// Body moves for a celebration (jump by default). Spin, flip and dance add their own moves with the life visuals.
function celebrationMoves(t) {
    const ph = (t * 2.2) % 1;
    const h = Math.sin(ph * Math.PI);
    return {jump: h * 20, squash: ph < 0.1 || ph > 0.9 ? 0.12 : -0.06 * h, shakeX: 0, spinX: 1, flipAngle: 0};
}

// How the body bounces, squashes, shakes and breathes this frame.
function bodyMoves(p, mood) {
    const t = p.t;
    let jump = 0, squash = 0, shakeX = 0, breathe = 0, spinX = 1, flipAngle = 0;
    switch (mood) {
    case Mood.celebrating:
        ({jump, squash, shakeX, spinX, flipAngle} = celebrationMoves(t));
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
    if (mood === Mood.celebrating) {
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

// Draws the pet for `pose` (see defaultPose) in a width × height area: the 120×120 design space is scaled to
// fit and centered, as PetArt.draw does. Leaves the context's state as it found it.
export function drawPet(cr, width, height, pose) {
    const s = Math.min(width, height) / 120;
    if (!(s > 0) || !Number.isFinite(s))
        return;
    cr.save();
    try {
        // Confetti, steam and Zz never spill onto whatever is drawn next to the pet.
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
    const pal = mixPalette(petPalette(p.prevMood), petPalette(p.mood), k * k * (3 - 2 * k));
    const mood = p.held ? Mood.normal : p.mood;
    const celebrating = mood === Mood.celebrating;

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
    // Life visuals on the body (sprouts, dirt, accessories) go here, in PetArt.swift's order.
    cr.restore();

    drawEffects(cr, f);
    // Life visuals around the body (flies, rumbling tummy, falling treat) go here, in PetArt.swift's order.
}
