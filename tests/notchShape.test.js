import {CORNER_POINTS, blendOutlines, notchMetrics, notchOutline} from '../lib/notchShape.js';
import {assertEqual, assertTrue, test} from './harness.js';

const W = 200;
const H = 80;
const metrics = notchMetrics(1);
const {margin: M, flare: C, radius: R} = metrics;
const EPS = 1e-6;

/** Smallest and largest x (axis 0) or y (axis 1) of an outline, without float noise. */
const lo = (points, axis) => Math.round(Math.min(...points.map(p => p[axis])) * 1e6) / 1e6;
const hi = (points, axis) => Math.round(Math.max(...points.map(p => p[axis])) * 1e6) / 1e6;

const DOCKS = [];
for (const left of [false, true]) {
    for (const right of [false, true]) {
        for (const top of [false, true]) {
            if (!(left && right))
                DOCKS.push({left, right, top});
        }
    }
}

test('notchShape: every dock state has the same number of points, all inside the widget', () => {
    for (const dock of DOCKS) {
        const outline = notchOutline(W, H, metrics, dock);
        assertEqual(outline.length, 4 * CORNER_POINTS, JSON.stringify(dock));
        for (const [x, y] of outline) {
            assertTrue(Number.isFinite(x) && Number.isFinite(y), 'finite');
            assertTrue(x >= -EPS && x <= W + EPS && y >= -EPS && y <= H + EPS,
                `${JSON.stringify(dock)} point ${x.toFixed(1)},${y.toFixed(1)} outside`);
        }
    }
});

test('notchShape: a free notch stays inside its body, a docked one reaches into the margin only along its wall', () => {
    const free = notchOutline(W, H, metrics, {left: false, right: false, top: false});
    for (const [x, y] of free)
        assertTrue(x >= M - EPS && x <= W - M + EPS && y >= M - EPS && y <= H - M + EPS, 'free stays in the body');

    // Docked to the top: flush with y = M along the wall, flaring out sideways into the margin.
    const top = notchOutline(W, H, metrics, {left: false, right: false, top: true});
    assertEqual(lo(top, 1), M);
    assertEqual(lo(top, 0), M - C);
    assertEqual(hi(top, 0), W - M + C);
    assertEqual(hi(top, 1), H - M);

    // Docked left: flush with x = M, flaring up and down.
    const left = notchOutline(W, H, metrics, {left: true, right: false, top: false});
    assertEqual(lo(left, 0), M);
    assertEqual(lo(left, 1), M - C);
    assertEqual(hi(left, 1), H - M + C);

    // Docked right.
    const right = notchOutline(W, H, metrics, {left: false, right: true, top: false});
    assertEqual(hi(right, 0), W - M);
});

test('notchShape: a notch in the screen corner has a square corner there and flares on its two walls', () => {
    const corner = notchOutline(W, H, metrics, {left: true, right: false, top: true});
    // The top-left corner is the first CORNER_POINTS points: all on the body's corner.
    for (const [x, y] of corner.slice(0, CORNER_POINTS)) {
        assertEqual(Math.round(x * 1e6) / 1e6, M);
        assertEqual(Math.round(y * 1e6) / 1e6, M);
    }
    assertEqual(lo(corner, 0), M);
    assertEqual(lo(corner, 1), M);
});

test('notchShape: corners are rounded by the radius and flares are concave', () => {
    const free = notchOutline(W, H, metrics, {left: false, right: false, top: false});
    // First point of the top-left corner is on the left edge R below the top, last on the top edge R right of the left.
    assertEqual([Math.round(free[0][0]), Math.round(free[0][1])], [M, M + R]);
    assertEqual([Math.round(free[CORNER_POINTS - 1][0]), Math.round(free[CORNER_POINTS - 1][1])], [M + R, M]);
    // A flare bulges towards the body's corner: its middle point is nearer to it than the chord's middle.
    const top = notchOutline(W, H, metrics, {left: false, right: false, top: true});
    const a = top[0];
    const b = top[CORNER_POINTS - 1];
    const mid = top[Math.floor(CORNER_POINTS / 2)];
    const chordMid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const corner = [M, M];
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    assertTrue(dist(mid, corner) < dist(chordMid, corner), 'flare is concave');
});

test('notchShape: blending goes from one outline to the other', () => {
    const a = notchOutline(W, H, metrics, {left: false, right: false, top: false});
    const b = notchOutline(W, H, metrics, {left: false, right: false, top: true});
    const round = o => o.map(p => p.map(v => Math.round(v * 1e6) / 1e6));
    assertEqual(round(blendOutlines(a, b, 0)), round(a));
    assertEqual(round(blendOutlines(a, b, 1)), round(b));
    const mid = blendOutlines(a, b, 0.5);
    assertEqual(Math.round(mid[3][0] * 1e6), Math.round((a[3][0] + b[3][0]) / 2 * 1e6));
});

test('notchShape: metrics follow the scale', () => {
    assertEqual(notchMetrics(1), {radius: 18, flare: 14, margin: 14});
    assertEqual(notchMetrics(2), {radius: 36, flare: 28, margin: 28});
});
