// Draws the effects around the pet (ui/antics.js puts them on screen): the confetti or fireworks and the combo badge of
// a celebration, and the sigh and the stomping dust of a grumble. The numbers come from ui/anticsLogic.js; this file
// only paints them with Cairo and Pango, so plain gjs can load it (tests, tools).
//
//   drawCelebration(cr, {box, plan, pieces, bursts, side}, t)   box: effectBox(); plan: celebrationPlan();
//                                                              pieces: confettiPieces(); bursts: fireworkBursts();
//                                                              side: badgeSide()
//   drawGrumble(cr, {box, side}, t)
// `t` is seconds since the effect started. The context's transform, source and path are left as they were.
import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {badgeLook, burstAt, confettiAt, dustPuffs, grumbleAt, sighPuffs} from './anticsLogic.js';

// The badge beside the pet, in pet units: its center, height and text size.
const BADGE = Object.freeze({x: 1.12, y: 0.55, height: 0.22, text: 0.13, pad: 0.075, tilt: 0.08});
const BADGE_TOP = [1, 0.62, 0.11];
const BADGE_BOTTOM = [1, 0.31, 0.47];
const FLAME = '🔥';
const DUST = [0.78, 0.73, 0.66];

function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) / 255, ((n >> 8) & 0xFF) / 255, (n & 0xFF) / 255];
}

const rgbCache = new Map();
function colorOf(hex) {
    let c = rgbCache.get(hex);
    if (!c) {
        c = rgb(hex);
        rgbCache.set(hex, c);
    }
    return c;
}

function circle(cr, x, y, r) {
    cr.newSubPath();
    cr.arc(x, y, r, 0, Math.PI * 2);
}

// --- Celebration ---

function drawConfetti(cr, pieces, t) {
    for (const piece of pieces) {
        const p = confettiAt(piece, t);
        if (!p || p.alpha <= 0)
            continue;
        cr.save();
        cr.translate(p.x, p.y);
        cr.rotate(p.angle);
        cr.rectangle(-p.w / 2, -p.h / 2, p.w, p.h);
        const [r, g, b] = colorOf(p.color);
        cr.setSourceRGBA(r, g, b, p.alpha);
        cr.fill();
        cr.restore();
    }
}

function drawFireworks(cr, bursts, t, golden) {
    const head = golden ? colorOf('#FFF6C2') : [1, 1, 1];
    for (const [i, burst] of bursts.entries()) {
        const state = burstAt(burst, t, i);
        if (!state)
            continue;
        if (state.rocket) {
            for (const [j, p] of state.trail.entries()) {
                circle(cr, p.x, p.y, 0.012 - j * 0.002);
                cr.setSourceRGBA(...colorOf(burst.colors[0]), 0.6 - j * 0.18);
                cr.fill();
            }
            circle(cr, state.rocket.x, state.rocket.y, 0.017);
            cr.setSourceRGBA(...head, 1);
            cr.fill();
            continue;
        }
        if (state.flash > 0) {
            circle(cr, burst.x, burst.y, 0.09 * state.flash + 0.02);
            cr.setSourceRGBA(...head, 0.8 * state.flash);
            cr.fill();
        }
        cr.setLineCap(Cairo.LineCap.ROUND);
        for (const s of state.sparks) {
            const [r, g, b] = colorOf(s.color);
            cr.moveTo(s.tail.x, s.tail.y);
            cr.lineTo(s.x, s.y);
            cr.setLineWidth(s.r * 1.3);
            cr.setSourceRGBA(r, g, b, s.alpha * 0.55);
            cr.stroke();
            circle(cr, s.x, s.y, s.r * 2.2);
            cr.setSourceRGBA(r, g, b, s.alpha * 0.25);
            cr.fill();
            circle(cr, s.x, s.y, s.r);
            cr.setSourceRGBA(r, g, b, s.alpha);
            cr.fill();
        }
    }
}

// Laying text out is the slow part of the badge: the last one is kept (one badge on screen at a time).
let badgeCache = null; // {key, flame, number}

function badgeLayouts(text, px) {
    const key = `${text}|${px}`;
    if (badgeCache?.key === key)
        return badgeCache;
    const context = PangoCairo.FontMap.get_default().create_context();
    const font = Pango.FontDescription.from_string('Sans');
    font.set_weight(Pango.Weight.HEAVY);
    font.set_absolute_size(px * Pango.SCALE);
    const make = s => {
        const layout = Pango.Layout.new(context);
        layout.set_font_description(font);
        layout.set_text(s, -1);
        const [, logical] = layout.get_extents();
        return {layout, width: logical.width / Pango.SCALE, height: logical.height / Pango.SCALE};
    };
    badgeCache = {key, flame: make(FLAME), number: make(text)};
    return badgeCache;
}

function pill(cr, x, y, w, h) {
    const r = h / 2;
    cr.newPath();
    cr.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    cr.closePath();
}

// "🔥 ×3" in white on an orange-to-pink pill, tilted, popping in and fading out.
function drawBadge(cr, scene, t) {
    const {box, plan, side} = scene;
    const look = badgeLook(t, plan.seconds);
    if (look.scale <= 0 || look.alpha <= 0)
        return;
    const s = box.size;
    const px = Math.max(8, Math.round(BADGE.text * s));
    const {flame, number} = badgeLayouts(plan.badge, px);
    const pad = BADGE.pad * s;
    const height = BADGE.height * s;
    const gap = px * 0.15;
    const width = pad * 2 + flame.width + gap + number.width;
    const cx = box.petX + s * (side > 0 ? BADGE.x : 1 - BADGE.x);
    const cy = box.petY + s * (BADGE.y + look.dy);

    cr.save();
    try {
        cr.translate(cx, cy);
        cr.rotate(-BADGE.tilt * side);
        cr.scale(look.scale, look.scale);
        cr.pushGroup();
        const x = -width / 2, y = -height / 2;
        pill(cr, x, y + s * 0.015, width, height);
        cr.setSourceRGBA(0, 0, 0, 0.22);
        cr.fill();
        pill(cr, x, y, width, height);
        const gradient = new Cairo.LinearGradient(0, y, 0, y + height);
        gradient.addColorStopRGBA(0, ...BADGE_TOP, 1);
        gradient.addColorStopRGBA(1, ...BADGE_BOTTOM, 1);
        cr.setSource(gradient);
        cr.fillPreserve();
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.setLineWidth(Math.max(1.5, s * 0.016));
        cr.stroke();
        // The flame in its own colors, then the number as filled outlines (no colored fringes on white text).
        let tx = x + pad;
        cr.moveTo(tx, -flame.height / 2);
        PangoCairo.show_layout(cr, flame.layout);
        tx += flame.width + gap;
        cr.newPath();
        cr.moveTo(tx, -number.height / 2);
        PangoCairo.layout_path(cr, number.layout);
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.fill();
        cr.popGroupToSource();
        cr.paintWithAlpha(look.alpha);
    } finally {
        cr.restore();
    }
}

export function drawCelebration(cr, scene, t) {
    const {box, plan} = scene;
    cr.save();
    try {
        cr.newPath();
        cr.save();
        try {
            cr.translate(box.petX, box.petY);
            cr.scale(box.size, box.size);
            if (plan.effect === 'confetti')
                drawConfetti(cr, scene.pieces, t);
            else
                drawFireworks(cr, scene.bursts, t, plan.golden);
        } finally {
            cr.restore();
        }
        if (plan.badge)
            drawBadge(cr, scene, t);
    } finally {
        cr.newPath();
        cr.restore();
    }
}

// --- Grumble ---

export function drawGrumble(cr, scene, t) {
    const {box, side} = scene;
    const g = grumbleAt(t);
    cr.save();
    try {
        cr.newPath();
        cr.translate(box.petX, box.petY);
        cr.scale(box.size, box.size);
        // The sigh: puffs of breath like the angry pet's steam (white, a gray outline).
        if (g.sigh !== null) {
            cr.setLineWidth(1 / box.size);
            for (const p of sighPuffs(g.sigh, side)) {
                circle(cr, p.x, p.y, p.r);
                cr.setSourceRGBA(1, 1, 1, p.alpha);
                cr.fillPreserve();
                cr.setSourceRGBA(0.5, 0.5, 0.5, p.alpha * 0.6);
                cr.stroke();
            }
        }
        for (const p of dustPuffs(g.dust)) {
            circle(cr, p.x, p.y, p.r);
            cr.setSourceRGBA(...DUST, p.alpha);
            cr.fill();
        }
    } finally {
        cr.newPath();
        cr.restore();
    }
}
