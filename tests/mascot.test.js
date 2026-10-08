import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import {Mood} from '../model/sessionStore.js';
import {SHAPES, paintMascot} from '../ui/mascotPaint.js';
import {assertEqual, test} from './harness.js';

const SIZE = 80;

/** Alpha of the outermost ring of pixels after painting one frame: anything above 0 is clipped. */
function edgeAlpha(mood, ms, shape) {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, SIZE, SIZE);
    const cr = new Cairo.Context(surface);
    paintMascot(cr, SIZE, SIZE, mood, ms, shape);
    cr.$dispose();
    // The surface has no pixel accessor in gjs: round-trip it through a PNG.
    const [fd, path] = GLib.file_open_tmp('agentbuddy-mascot-XXXXXX.png');
    GLib.close(fd);
    try {
        surface.writeToPNG(path);
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
        const data = pixbuf.get_pixels();
        const stride = pixbuf.get_rowstride();
        let worst = 0;
        for (let i = 0; i < SIZE; i++) {
            for (const [x, y] of [[i, 0], [i, SIZE - 1], [0, i], [SIZE - 1, i]])
                worst = Math.max(worst, data[y * stride + x * 4 + 3]);
        }
        return worst;
    } finally {
        GLib.unlink(path);
    }
}

test('mascot: every mood has a complete shape', () => {
    const keys = Object.keys(SHAPES[Mood.IDLE]).sort();
    for (const mood of Object.values(Mood))
        assertEqual(Object.keys(SHAPES[mood]).sort(), keys, mood);
});

test('mascot: no mood ever touches the edge of its box (nothing is clipped)', () => {
    for (const mood of Object.values(Mood)) {
        // Steps of 50 ms walk through every phase of the bounce and the wobble.
        // Long enough to catch the idle blob's hello wave, which comes every 9 s.
        for (let ms = 0; ms < 10000; ms += 50)
            assertEqual(edgeAlpha(mood, ms, SHAPES[mood]), 0, `${mood} at ${ms} ms`);
    }
});

test('mascot: halfway between two moods is still inside the box', () => {
    const a = SHAPES[Mood.ALERT];
    const b = SHAPES[Mood.SAD];
    const mid = Object.fromEntries(Object.keys(a).map(k => [k, (a[k] + b[k]) / 2]));
    for (let ms = 0; ms < 2000; ms += 50)
        assertEqual(edgeAlpha(Mood.WORKING, ms, mid), 0, `at ${ms} ms`);
});
