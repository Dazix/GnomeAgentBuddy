import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Mood} from '../model/sessionStore.js';
import {SHAPES, paintMascot} from './mascotPaint.js';

/** How slowly the body melts from one mood's shape into the next: the time constant, in seconds. */
const SHAPE_EASE_S = 0.5;

/** Frame interval per mood; a sleeping blob barely needs redrawing. */
const FRAME_MS = {
    [Mood.SLEEPY]: 160,
    [Mood.IDLE]: 66,
    [Mood.WORKING]: 33,
    [Mood.ALERT]: 33,
    [Mood.HAPPY]: 33,
    [Mood.SAD]: 66,
};

/** The blob as a widget: repaints itself only while it is on screen. */
export const Mascot = GObject.registerClass(
class Mascot extends St.DrawingArea {
    _init(size = 28) {
        super._init({
            width: size, height: size,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        this._mood = Mood.SLEEPY;
        // The shape drawn right now; it eases towards the mood's own, so a change of
        // mood melts from one body into the other instead of jumping.
        this._shape = {...SHAPES[this._mood]};
        this._settling = false;
        this._lastFrame = GLib.get_monotonic_time();
        this._timer = 0;
        this._t0 = GLib.get_monotonic_time();
        this.connect('repaint', () => this._repaint());
        this.connect('notify::mapped', () => this._syncTimer());
        this.connect('destroy', () => this._stopTimer());
    }

    setSize(size) {
        this.set_size(size, size);
    }

    setMood(mood) {
        if (mood === this._mood)
            return;
        this._mood = mood;
        this._settling = true;
        this._syncTimer();
        this.queue_repaint();
    }

    /** Move the drawn shape towards the mood's; true once it has arrived. */
    _easeShape(now) {
        const target = SHAPES[this._mood] ?? SHAPES[Mood.IDLE];
        const seconds = Math.min(0.1, (now - this._lastFrame) / 1e6);
        const k = 1 - Math.exp(-seconds / SHAPE_EASE_S);
        let settled = true;
        for (const key of Object.keys(target)) {
            const gap = target[key] - this._shape[key];
            if (Math.abs(gap) > 0.004) {
                this._shape[key] += gap * k;
                settled = false;
            } else {
                this._shape[key] = target[key];
            }
        }
        return settled;
    }

    _repaint() {
        const cr = this.get_context();
        try {
            const [w, h] = this.get_surface_size();
            const now = GLib.get_monotonic_time();
            const settled = this._easeShape(now);
            this._lastFrame = now;
            paintMascot(cr, w, h, this._mood, (now - this._t0) / 1000, this._shape);
            // Full frame rate only while melting between shapes; a sleeping blob goes back to slow.
            if (settled === this._settling) {
                this._settling = !settled;
                this._syncTimer();
            }
        } finally {
            cr.$dispose();
        }
    }

    _syncTimer() {
        this._stopTimer();
        // Hidden means no timer at all: zero CPU while the island is away.
        if (!this.mapped)
            return;
        const interval = this._settling ? 33 : FRAME_MS[this._mood] ?? 66;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
        GLib.Source.set_name_by_id(this._timer, '[GnomeAgentBuddy] mascot');
    }

    _stopTimer() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
    }
});
