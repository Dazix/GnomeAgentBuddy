import Cairo from 'cairo';

import {Mood} from '../model/sessionStore.js';

/** Body colour per mood, as [r, g, b]. */
const BODY = {
    [Mood.SLEEPY]: [0.55, 0.78, 0.68],
    [Mood.IDLE]: [0.50, 0.84, 0.66],
    [Mood.WORKING]: [0.50, 0.84, 0.66],
    [Mood.ALERT]: [1.00, 0.72, 0.30],
    [Mood.HAPPY]: [0.55, 0.90, 0.62],
    [Mood.SAD]: [0.55, 0.68, 0.88],
};
const INK = [0.09, 0.11, 0.14];

/**
 * The body is not a circle but a wobbling blob whose shape follows the mood.
 * `sx`/`sy` stretch it, `wobbleA`/`wobbleB` ripple its outline (2 and 3 lobes,
 * at a fixed speed), `droop` melts the bottom flat and wide. All numbers, so the
 * widget can ease from one mood's shape to the next.
 */
export const SHAPES = {
    [Mood.SLEEPY]: {sx: 1.025, sy: 0.93, wobbleA: 0.025, wobbleB: 0.015, droop: 0.35, armAngle: 0.7, armBend: -0.3, armSwing: 0.03, armPhase: 0, bounce: 0, squashBase: 1, breath: 0.03},
    [Mood.IDLE]: {sx: 1.00, sy: 1.00, wobbleA: 0.035, wobbleB: 0.020, droop: 0.1, armAngle: 0.85, armBend: -0.4, armSwing: 0.08, armPhase: 0, bounce: 0, squashBase: 1, breath: 0.04},
    [Mood.WORKING]: {sx: 1.00, sy: 1.00, wobbleA: 0.035, wobbleB: 0.020, droop: 0.1, armAngle: 1.0, armBend: -1.0, armSwing: 0.18, armPhase: 3.14, bounce: 0, squashBase: 1, breath: 0.04},
    [Mood.ALERT]: {sx: 0.96, sy: 1.03, wobbleA: 0.042, wobbleB: 0.040, droop: 0.05, armAngle: 2.5, armBend: 0.3, armSwing: 0.35, armPhase: 0, bounce: 0.10, squashBase: 1, breath: 0},
    [Mood.HAPPY]: {sx: 1.04, sy: 0.98, wobbleA: 0.050, wobbleB: 0.025, droop: 0.05, armAngle: 2.7, armBend: 0.2, armSwing: 0.2, armPhase: 0, bounce: 0.11, squashBase: 1, breath: 0},
    [Mood.SAD]: {sx: 1.05, sy: 0.92, wobbleA: 0.025, wobbleB: 0.018, droop: 0.5, armAngle: 0.5, armBend: -0.6, armSwing: 0.03, armPhase: 0, bounce: 0, squashBase: 0.92, breath: 0.02},
};

const OUTLINE_POINTS = 48;

// Speeds are fixed, not part of the shape: easing a speed would sweep the phase (speed x time) wildly.
// Moods differ by amplitude, which eases smoothly.
const OUTLINE_SPEED = 3;
const ARM_SPEED = 9;
const BOUNCE_SPEED = 7;
const BREATH_SPEED = 1.8;

/** The body's outline in unit coordinates: a circle, rippled by the mood's wobble and melted by its droop. */
function bodyOutline(t, shape) {
    return Array.from({length: OUTLINE_POINTS}, (_, i) => {
        const a = (i / OUTLINE_POINTS) * 2 * Math.PI;
        const wobble = 1 + shape.wobbleA * Math.sin(2 * a + t * OUTLINE_SPEED) +
            shape.wobbleB * Math.sin(3 * a - t * OUTLINE_SPEED * 1.3);
        let x = Math.sin(a) * wobble;
        let y = -Math.cos(a) * wobble;
        if (y > 0) {
            // Melting: the bottom flattens and spreads, like a puddle.
            x *= 1 + shape.droop * 0.14 * y;
            y *= 1 - shape.droop * 0.25;
        }
        return [x, y];
    });
}

function bodyPath(cr, cx, cy, rx, ry, outline) {
    outline.forEach(([x, y], i) => {
        if (i === 0)
            cr.moveTo(cx + x * rx, cy + y * ry);
        else
            cr.lineTo(cx + x * rx, cy + y * ry);
    });
    cr.closePath();
}

const WAVE_PERIOD_S = 9;
const WAVE_LENGTH_S = 1.2;

/**
 * Shoulder angle of one arm, measured from straight down, outwards (pi/2 is
 * horizontal, pi straight up). The mood sets the rest angle and a swing; an idle
 * blob also waves hello with its right arm now and then.
 */
function armAngle(mood, t, shape, side) {
    let angle = shape.armAngle + shape.armSwing * Math.sin(t * ARM_SPEED + (side > 0 ? shape.armPhase : 0));
    if (mood === Mood.IDLE && side > 0 && t % WAVE_PERIOD_S < WAVE_LENGTH_S) {
        const lift = Math.sin(Math.PI * (t % WAVE_PERIOD_S) / WAVE_LENGTH_S);
        angle += (2.3 + 0.3 * Math.sin(t * 14) - angle) * lift;
    }
    return angle;
}

/** One arm: a short, fat, rounded stub from the shoulder, curved a little by `bend`. No joints, no hands. */
function drawArm(cr, sx, sy, side, angle, bend, s) {
    const length = 0.19 * s;
    const dx = side * Math.sin(angle);
    const dy = Math.cos(angle);
    const hx = sx + dx * length;
    const hy = sy + dy * length;
    // Control point pushed sideways from the middle: the stub bows instead of kinking.
    const bow = bend * 0.03 * s;
    cr.moveTo(sx, sy);
    cr.curveTo(sx + dx * length * 0.4 - dy * bow, sy + dy * length * 0.4 + dx * bow,
        sx + dx * length * 0.8 - dy * bow, sy + dy * length * 0.8 + dx * bow, hx, hy);
    cr.stroke();
}

/**
 * Draw the blob into a w x h box at time `ms`. Pure drawing: no state, so a
 * mood is a function of (mood, time, shape); `shape` defaults to the mood's own
 * and is passed in by the widget while it eases from one shape to another.
 *
 * @param {Cairo.Context} cr
 */
export function paintMascot(cr, w, h, mood, ms, shape = SHAPES[mood] ?? SHAPES[Mood.IDLE]) {
    // Everything is sized in units of `s`, a bit smaller than the box, so the
    // tallest pose (full bounce plus the sprout) stays inside it instead of being clipped.
    const s = Math.min(w, h) / 1.4;
    const t = ms / 1000;
    const cx = w / 2;

    // Bounce and breathing amplitudes come from the (eased) shape, so a change of mood fades them in and out.
    const lift = Math.abs(Math.sin(t * BOUNCE_SPEED)) * shape.bounce * s;
    const squash = shape.squashBase + shape.breath * Math.sin(t * BREATH_SPEED);
    const look = mood === Mood.WORKING ? Math.sin(t * 1.7) * 0.05 * s : 0;

    const rx = 0.42 * s * shape.sx * (1 + (1 - squash) * 0.5);
    const ry = 0.36 * s * shape.sy * squash;
    const outline = bodyOutline(t, shape);
    // Standing is measured on the calm outline: the ripple must not lift the body off the ground.
    const calm = bodyOutline(t, {...shape, wobbleA: 0, wobbleB: 0});
    const lowest = Math.max(...calm.map(p => p[1]));
    const highest = Math.min(...calm.map(p => p[1]));
    // The body sits on the middle of the box (so the text beside it lines up with the face); lift bounces it up.
    const cy = h / 2 - lift;
    const ground = h / 2 + lowest * ry;
    const top = cy + highest * ry;
    const [r, g, b] = BODY[mood] ?? BODY[Mood.IDLE];

    // Shadow.
    cr.save();
    cr.translate(cx, ground + 0.02 * s);
    cr.scale(rx * 0.9, 0.05 * s);
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.restore();
    cr.setSourceRGBA(0, 0, 0, 0.28 * (1 - lift / s));
    cr.fill();

    // Arms go behind the body: their roots hide inside it, so only the reaching part shows.
    cr.setSourceRGBA(r, g, b, 1);
    cr.setLineWidth(Math.max(2.5, 0.11 * s));
    cr.setLineCap(Cairo.LineCap.ROUND);
    for (const side of [-1, 1])
        drawArm(cr, cx + side * rx * 0.85, cy + 0.06 * s, side, armAngle(mood, t, shape, side), shape.armBend, s);

    // Body.
    bodyPath(cr, cx, cy, rx, ry, outline);
    cr.setSourceRGBA(r, g, b, 1);
    cr.fill();

    // Belly highlight and blush stay on the body: clipped to it.
    cr.save();
    bodyPath(cr, cx, cy, rx, ry, outline);
    cr.clip();
    cr.save();
    cr.translate(cx - rx * 0.35, cy - ry * 0.45);
    cr.scale(rx * 0.28, ry * 0.18);
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.restore();
    cr.setSourceRGBA(1, 1, 1, 0.35);
    cr.fill();
    for (const side of [-1, 1]) {
        cr.save();
        cr.translate(cx + side * 0.30 * s, cy + 0.09 * s);
        cr.scale(0.07 * s, 0.045 * s);
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.restore();
        cr.setSourceRGBA(1, 0.45, 0.55, mood === Mood.SAD ? 0.2 : 0.5);
        cr.fill();
    }
    cr.restore();

    // Sprout on top, swaying: the cute bit.
    const sway = Math.sin(t * 2.2) * 0.04 * s;
    const topY = top + 0.02 * s;
    cr.setSourceRGBA(r * 0.55, g * 0.7, b * 0.55, 1);
    cr.setLineWidth(Math.max(1.2, 0.035 * s));
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.moveTo(cx, topY);
    cr.curveTo(cx, topY - 0.07 * s, cx + sway, topY - 0.09 * s, cx + sway, topY - 0.13 * s);
    cr.stroke();
    cr.save();
    cr.translate(cx + sway + 0.05 * s, topY - 0.13 * s);
    cr.rotate(-0.5);
    cr.scale(0.09 * s, 0.045 * s);
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.restore();
    cr.fill();

    // Face.
    const eyeY = cy - 0.02 * s;
    const eyeDx = 0.18 * s;
    const eyeR = (mood === Mood.ALERT ? 0.13 : 0.105) * s;
    const blinking = t % 3.2 < 0.12;
    cr.setSourceRGBA(INK[0], INK[1], INK[2], 1);
    cr.setLineWidth(Math.max(1.2, 0.045 * s));
    cr.setLineCap(Cairo.LineCap.ROUND);

    for (const side of [-1, 1]) {
        const ex = cx + side * eyeDx + (mood === Mood.WORKING ? look : 0);
        if (mood === Mood.SLEEPY || blinking) {
            cr.moveTo(ex - eyeR, eyeY);
            cr.curveTo(ex - eyeR * 0.5, eyeY + eyeR * 0.7, ex + eyeR * 0.5, eyeY + eyeR * 0.7, ex + eyeR, eyeY);
            cr.stroke();
        } else if (mood === Mood.HAPPY) {
            cr.moveTo(ex - eyeR, eyeY + eyeR * 0.4);
            cr.curveTo(ex - eyeR * 0.5, eyeY - eyeR * 0.9, ex + eyeR * 0.5, eyeY - eyeR * 0.9, ex + eyeR, eyeY + eyeR * 0.4);
            cr.stroke();
        } else {
            cr.arc(ex, eyeY, eyeR, 0, 2 * Math.PI);
            cr.fill();
            cr.setSourceRGBA(1, 1, 1, 0.95);
            cr.arc(ex + eyeR * 0.3, eyeY - eyeR * 0.35, eyeR * 0.38, 0, 2 * Math.PI);
            cr.fill();
            cr.arc(ex - eyeR * 0.3, eyeY + eyeR * 0.3, eyeR * 0.18, 0, 2 * Math.PI);
            cr.fill();
            cr.setSourceRGBA(INK[0], INK[1], INK[2], 1);
        }
    }

    cr.setSourceRGBA(INK[0], INK[1], INK[2], 1);
    cr.setLineWidth(Math.max(1.2, 0.045 * s));

    // Mouth.
    const my = cy + 0.15 * s;
    switch (mood) {
    case Mood.HAPPY:
        cr.moveTo(cx - 0.10 * s, my - 0.02 * s);
        cr.curveTo(cx - 0.06 * s, my + 0.09 * s, cx + 0.06 * s, my + 0.09 * s, cx + 0.10 * s, my - 0.02 * s);
        cr.stroke();
        break;
    case Mood.SAD:
        cr.moveTo(cx - 0.07 * s, my + 0.04 * s);
        cr.curveTo(cx - 0.04 * s, my - 0.04 * s, cx + 0.04 * s, my - 0.04 * s, cx + 0.07 * s, my + 0.04 * s);
        cr.stroke();
        break;
    case Mood.ALERT:
        cr.arc(cx, my + 0.02 * s, 0.04 * s, 0, 2 * Math.PI);
        cr.fill();
        break;
    case Mood.WORKING:
    case Mood.SLEEPY:
        cr.moveTo(cx - 0.04 * s, my);
        cr.lineTo(cx + 0.04 * s, my);
        cr.stroke();
        break;
    default:
        cr.moveTo(cx - 0.06 * s, my - 0.01 * s);
        cr.curveTo(cx - 0.03 * s, my + 0.05 * s, cx + 0.03 * s, my + 0.05 * s, cx + 0.06 * s, my - 0.01 * s);
        cr.stroke();
    }

    // Accessories: "!" when something needs an answer, "z" when asleep.
    if (mood === Mood.ALERT) {
        const bx = cx + 0.34 * s;
        const by = top + 0.04 * s;
        cr.setSourceRGBA(1, 0.35, 0.25, 1);
        cr.setLineWidth(Math.max(1.5, 0.06 * s));
        cr.moveTo(bx, by - 0.12 * s);
        cr.lineTo(bx, by + 0.02 * s);
        cr.stroke();
        cr.arc(bx, by + 0.09 * s, 0.035 * s, 0, 2 * Math.PI);
        cr.fill();
    } else if (mood === Mood.SLEEPY) {
        cr.setSourceRGBA(0.75, 0.82, 0.9, 0.5 + 0.4 * Math.sin(t * 1.2));
        cr.selectFontFace('sans-serif', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(0.22 * s);
        cr.moveTo(cx + 0.30 * s, top + 0.14 * s - ((t * 0.12 * s) % (0.12 * s)));
        cr.showText('z');
    }
}
