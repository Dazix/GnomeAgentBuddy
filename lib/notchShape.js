/**
 * The notch's outline, "organic" as in GnomeCodeNotchBar: a free notch is a
 * rounded pill; docked to a screen edge, the corners on that edge flare out in
 * a concave curve, so the notch grows out of the edge like a drop of the
 * screen itself. Pure geometry (no GNOME imports), unit-tested.
 *
 * The widget is the body plus a margin `m` on every side; the flares live in
 * that margin. Outlines of every dock state have the same number of points, so
 * two of them can be blended point for point to morph the shape.
 */

/** Points per corner; an outline is four corners, clockwise from the top left. */
export const CORNER_POINTS = 12;

/**
 * @param {number} scale
 * @returns {{radius: number, flare: number, margin: number}} pixel sizes
 */
export function notchMetrics(scale = 1) {
    const radius = Math.round(18 * scale);
    const flare = Math.round(14 * scale);
    return {radius, flare, margin: flare};
}

/** Corners in drawing order, with their direction signs and whether the path arrives along a vertical edge. */
const CORNERS = [
    {name: 'tl', sx: -1, sy: -1, vertFirst: true},
    {name: 'tr', sx: 1, sy: -1, vertFirst: false},
    {name: 'br', sx: 1, sy: 1, vertFirst: true},
    {name: 'bl', sx: -1, sy: 1, vertFirst: false},
];

/** How a corner is drawn for a dock state: round, square, or a flare along a horizontal ('h') or vertical ('v') wall. */
function cornerMode(name, {left, right, top}) {
    switch (name) {
    case 'tl': return top && left ? 'square' : top ? 'h' : left ? 'v' : 'round';
    case 'tr': return top && right ? 'square' : top ? 'h' : right ? 'v' : 'round';
    case 'br': return right ? 'v' : 'round';
    default: return left ? 'v' : 'round';
    }
}

/** `count` points on the circle of `center` and `radius` from point `a` to point `b`, the short way round. */
function arc(center, radius, a, b, count) {
    const from = Math.atan2(a[1] - center[1], a[0] - center[0]);
    let sweep = Math.atan2(b[1] - center[1], b[0] - center[0]) - from;
    while (sweep > Math.PI)
        sweep -= 2 * Math.PI;
    while (sweep < -Math.PI)
        sweep += 2 * Math.PI;
    return Array.from({length: count}, (_, i) => {
        const angle = from + sweep * (i / (count - 1));
        return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
    });
}

/**
 * Outline of a notch widget `width` x `height` whose body is inset by `margin`.
 *
 * @param {number} width
 * @param {number} height
 * @param {{radius: number, flare: number, margin: number}} metrics
 * @param {{left: boolean, right: boolean, top: boolean}} dock edges the body is flush with
 * @returns {[number, number][]} 4 * CORNER_POINTS points, clockwise from the top left corner
 */
export function notchOutline(width, height, {radius: R, flare: C, margin: M}, dock) {
    const x0 = M;
    const y0 = M;
    const x1 = width - M;
    const y1 = height - M;
    const points = [];
    for (const {name, sx, sy, vertFirst} of CORNERS) {
        const cx = sx < 0 ? x0 : x1;
        const cy = sy < 0 ? y0 : y1;
        const mode = cornerMode(name, dock);
        if (mode === 'square') {
            for (let i = 0; i < CORNER_POINTS; i++)
                points.push([cx, cy]);
        } else if (mode === 'round') {
            const center = [cx - sx * R, cy - sy * R];
            const alongVertical = [cx, cy - sy * R];
            const alongHorizontal = [cx - sx * R, cy];
            const [from, to] = vertFirst ? [alongVertical, alongHorizontal] : [alongHorizontal, alongVertical];
            points.push(...arc(center, R, from, to, CORNER_POINTS));
        } else if (mode === 'h') {
            // A flare along a horizontal wall (top): the body edge point is on the vertical edge.
            const center = [cx + sx * C, cy - sy * C];
            const edge = [cx, cy - sy * C];
            const wall = [cx + sx * C, cy];
            const [from, to] = vertFirst ? [edge, wall] : [wall, edge];
            points.push(...arc(center, C, from, to, CORNER_POINTS));
        } else {
            // A flare along a vertical wall (left or right): the body edge point is on the horizontal edge.
            const center = [cx - sx * C, cy + sy * C];
            const edge = [cx - sx * C, cy];
            const wall = [cx, cy + sy * C];
            const [from, to] = vertFirst ? [wall, edge] : [edge, wall];
            points.push(...arc(center, C, from, to, CORNER_POINTS));
        }
    }
    return points;
}

/** Blend two outlines: 0 is `a`, 1 is `b`. */
export function blendOutlines(a, b, f) {
    return a.map((p, i) => [p[0] + (b[i][0] - p[0]) * f, p[1] + (b[i][1] - p[1]) * f]);
}
