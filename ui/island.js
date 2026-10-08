import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {connectorForIndex, indexForConnector} from '../lib/monitors.js';
import {blendOutlines, notchMetrics, notchOutline} from '../lib/notchShape.js';
import {place, savedFrom} from '../lib/placement.js';
import {Mood, State} from '../model/sessionStore.js';
import {Mascot} from './mascot.js';
import {agentLabel, buildRequestCard, buildSessionList} from './cards.js';

const MASCOT_SIZE = 46;
const FOLD_MS = 150;
const PEEK_DELAY_MS = 80;
const MORPH_MS = 300;

/**
 * The notch: a tab at the top centre of the screen that shows the mascot and a
 * one-word status, and opens into the pending request or the session list.
 * Hidden altogether while nothing runs (unless `hide-when-idle` is off).
 */
export const Island = GObject.registerClass(
class Island extends St.Widget {
    /**
     * @param {import('../model/sessionStore.js').SessionStore} store
     * @param {import('gi://Gio').Settings} settings
     */
    _init(store, settings, onOpenPrefs = () => {}) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'ab-island', reactive: true, can_focus: true, track_hover: true, visible: false,
            clip_to_allocation: true,
        });
        this._shown = false;
        this._store = store;
        this._settings = settings;
        this._expanded = false;
        this._diffKey = null;
        this._lastRequestId = 0;
        this._content = null;

        // The background is drawn, not styled: a free notch is a pill, one docked to a screen
        // edge flares out into it (lib/notchShape.js). It is blended from one shape to the
        // other by `_morph` whenever the docked edges change.
        this._metrics = notchMetrics(1);
        this._dock = {left: false, right: false, top: true};
        this._dockFrom = this._dock;
        this._morph = new St.Adjustment({actor: this, value: 1, lower: 0, upper: 1});
        this._morph.connect('notify::value', () => this._bg.queue_repaint());
        this._bg = new St.DrawingArea({x_expand: true, y_expand: true});
        this._bg.connect('repaint', area => this._paintBackground(area));
        this.add_child(this._bg);

        this._box = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true, style_class: 'ab-box'});
        this.add_child(this._box);

        this._mascot = new Mascot(MASCOT_SIZE);
        this._title = new St.Label({style_class: 'ab-title', y_align: Clutter.ActorAlign.CENTER});
        this._badge = new St.Label({style_class: 'ab-badge', y_align: Clutter.ActorAlign.CENTER, visible: false});

        this._header = new St.Button({style_class: 'ab-header', can_focus: true, x_expand: true});
        const row = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        row.add_child(this._mascot);
        row.add_child(this._title);
        row.add_child(this._badge);
        this._header.set_child(row);
        this._header.connect('clicked', () => this.toggle());
        this._box.add_child(this._header);

        this._body = new St.BoxLayout({vertical: true, style_class: 'ab-body', visible: false});
        this._box.add_child(this._body);

        this.connect('key-press-event', (_actor, event) => {
            if (!this._expanded)
                return Clutter.EVENT_PROPAGATE;
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Escape) {
                this.fold();
                return Clutter.EVENT_STOP;
            }
            // 1-9 pick the matching choice on a permission card.
            const number = key >= Clutter.KEY_1 && key <= Clutter.KEY_9 ? key - Clutter.KEY_0 : 0;
            if (number && this._content?.choose?.(number))
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        });
        // Right click opens the settings; Super+drag moves the notch. Captured, so the
        // header button underneath never sees these presses.
        this._onOpenPrefs = onOpenPrefs;
        this._drag = null;
        this._grab = null;
        this.connect('captured-event', (_actor, event) => this._onCaptured(event));

        // Hover peek: a one-line-per-session preview, after a short rest of the pointer.
        this._peek = false;
        this.connect('notify::hover', () => this._onHover());
        // A new size (unfolding, a longer title) re-places the notch; our own glide to a new
        // spot changes the position only, so it is not cut short by this.
        this._size = [0, 0];
        this.connect('notify::allocation', () => {
            this._bg.queue_repaint();
            const size = this.get_size();
            if (size[0] !== this._size[0] || size[1] !== this._size[1]) {
                this._size = size;
                this._reposition();
            }
        });
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._reposition());
        this._outsideId = global.stage.connect('button-press-event', (_stage, event) => {
            if (this._expanded && !this.contains(event.get_source()))
                this.fold();
            return Clutter.EVENT_PROPAGATE;
        });

        this.applySettings();
        this.refresh();
    }

    applySettings() {
        const scale = this._settings.get_double('scale');
        this._mascot.setSize(Math.round(MASCOT_SIZE * scale));
        this.set_style(`font-size: ${Math.round(13 * scale)}px;`);
        // The widget is the body plus a margin the flares live in; the content sits inside the body.
        this._metrics = notchMetrics(scale);
        const pad = this._metrics.margin;
        const compact = this._settings.get_boolean('compact-height');
        this._box.set_style(`padding: ${pad + (compact ? 4 : 6)}px ${pad + 10}px;`);
        this._header.set_style(`padding: ${compact ? 0 : 4}px 12px;`);
        this._bg.queue_repaint();
        this._reposition();
        if (this._shown) {
            this.remove_transition('opacity');
            this.opacity = this._targetOpacity();
        }
        this.refresh();
    }

    _onCaptured(event) {
        switch (event.type()) {
        case Clutter.EventType.BUTTON_PRESS: {
            const button = event.get_button();
            if (button === Clutter.BUTTON_SECONDARY) {
                this._onOpenPrefs();
                return Clutter.EVENT_STOP;
            }
            const superKey = (event.get_state() & Clutter.ModifierType.MOD4_MASK) !== 0;
            if (button !== Clutter.BUTTON_PRIMARY || !superKey)
                return Clutter.EVENT_PROPAGATE;
            // Super+double-click: back to the default spot.
            if ((event.get_click_count?.() ?? 1) >= 2) {
                this._endDrag();
                this._savePosition(null);
                this._reposition(true);
                return Clutter.EVENT_STOP;
            }
            this._beginDrag(event);
            return Clutter.EVENT_STOP;
        }
        case Clutter.EventType.MOTION: {
            if (!this._drag)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            this.set_position(Math.round(this._drag.left + x - this._drag.x), Math.round(this._drag.top + y - this._drag.y));
            return Clutter.EVENT_STOP;
        }
        case Clutter.EventType.BUTTON_RELEASE:
            if (!this._drag)
                return Clutter.EVENT_PROPAGATE;
            this._endDrag();
            // Remember where it was dropped and on which monitor, then let placement keep it on screen.
            {
                // One atomic write: otherwise a half-saved spot (new monitor, old spot) flashes by.
                const m = this._metrics.margin;
                const saved = savedFrom(this.x + m, this.y + m, this.width - 2 * m);
                this._settings.delay();
                this._saveMonitorUnder(saved.x, saved.y);
                this._savePosition(saved);
                this._settings.apply();
            }
            // Glide to the snapped spot and flow into the edge it docks to.
            this._reposition(true);
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _beginDrag(event) {
        // A drag is not a hover: no peek, and the pointer is ours until the button goes up.
        if (this._peekTimer) {
            GLib.source_remove(this._peekTimer);
            this._peekTimer = 0;
        }
        const [x, y] = event.get_coords();
        // Picked up: it lets go of the edge and becomes a free pill again.
        this.remove_all_transitions();
        this._setDock({left: false, right: false, top: false}, true);
        this._drag = {x, y, left: this.x, top: this.y};
        this._grab = global.stage.grab(this);
    }

    /** Morph the background to the shape for these docked edges. */
    _setDock(dock, animate) {
        const same = this._dock.left === dock.left && this._dock.right === dock.right && this._dock.top === dock.top;
        if (same)
            return;
        this._dockFrom = this._dock;
        this._dock = dock;
        this._morph.remove_transition('value');
        if (animate) {
            this._morph.value = 0;
            this._morph.ease(1, {duration: MORPH_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        } else {
            this._morph.value = 1;
        }
        this._bg.queue_repaint();
    }

    _paintBackground(area) {
        const cr = area.get_context();
        try {
            const [w, h] = area.get_surface_size();
            const progress = this._morph.value;
            let outline = notchOutline(w, h, this._metrics, this._dock);
            if (progress < 1)
                outline = blendOutlines(notchOutline(w, h, this._metrics, this._dockFrom), outline, progress);
            cr.setSourceRGBA(0.05, 0.05, 0.05, 0.97);
            outline.forEach(([x, y], i) => {
                if (i === 0)
                    cr.moveTo(x, y);
                else
                    cr.lineTo(x, y);
            });
            cr.closePath();
            cr.fill();
        } finally {
            cr.$dispose();
        }
    }

    _endDrag() {
        this._drag = null;
        this._grab?.dismiss();
        this._grab = null;
    }

    /** Persist the dropped spot (centre x, top y); null forgets it, back to the default. */
    _savePosition(saved) {
        this._settings.set_int('position-x', saved ? saved.x : -1);
        this._settings.set_int('position-y', saved ? saved.y : -1);
    }

    _onHover() {
        if (this._peekTimer) {
            GLib.source_remove(this._peekTimer);
            this._peekTimer = 0;
        }
        if (!this.hover) {
            if (this._peek) {
                this._peek = false;
                this.refresh();
            }
            return;
        }
        this._peekTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PEEK_DELAY_MS, () => {
            this._peekTimer = 0;
            this._peek = true;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._peekTimer, '[GnomeAgentBuddy] peek');
    }

    toggle() {
        if (this._expanded)
            this.fold();
        else
            this.unfold();
    }

    unfold() {
        this._expanded = true;
        this.refresh();
        this.grab_key_focus();
    }

    fold() {
        this._expanded = false;
        this._diffKey = null;
        this.refresh();
    }

    /** Re-read the store: mood, title, badge, and the open card. */
    refresh() {
        const store = this._store;
        const request = store.current;
        // A new request only opens the island by itself when the setting says so
        // (`auto-open-requests`); otherwise the notch just signals it. Folding keeps it folded.
        if (request && request.id > this._lastRequestId) {
            this._lastRequestId = request.id;
            if (this._settings.get_boolean('auto-open-requests'))
                this._expanded = true;
        }
        // The tab itself glows while something waits for an answer.
        if (request)
            this._header.add_style_class_name('ab-attention');
        else
            this._header.remove_style_class_name('ab-attention');

        const mood = store.mood();
        this._mascot.setMood(mood);
        this._title.text = this._titleFor(mood, request);
        const count = store.pending.length;
        this._badge.visible = count > 0;
        this._badge.text = String(count);

        const idle = !store.sessions.size && !request;
        const hidden = idle && !this._expanded && this._settings.get_boolean('hide-when-idle');
        if (hidden) {
            this._fade(false);
            return;
        }
        this._fade(true);
        this._resizeAround(() => this._renderBody(request));
        this._reposition();
    }

    _targetOpacity() {
        return Math.round(this._settings.get_double('background-opacity') * 255);
    }

    /** Fade the whole notch in or out; it is only `visible` while it is (becoming) shown. */
    _fade(show) {
        if (show === this._shown)
            return;
        this._shown = show;
        this.remove_transition('opacity');
        if (show) {
            if (!this.visible)
                this.opacity = 0;
            this.visible = true;
            this.ease({opacity: this._targetOpacity(), duration: FOLD_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            this.ease({
                opacity: 0, duration: FOLD_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (!this._shown)
                        this.visible = false;
                },
            });
        }
    }

    /** Run `change`, then grow or shrink from the old size to the new one (width and height). */
    _resizeAround(change) {
        this.remove_transition('width');
        this.remove_transition('height');
        const [width, height] = this.get_size();
        const animate = this.visible && this._shown && !this._drag && width > 0;
        this.set_size(-1, -1);
        change();
        if (!animate)
            return;
        const [, , newWidth, newHeight] = this.get_preferred_size();
        if (Math.round(newWidth) === width && Math.round(newHeight) === height)
            return;
        this.set_size(width, height);
        this.ease({
            width: newWidth, height: newHeight, duration: FOLD_MS + 50,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => this.set_size(-1, -1),
        });
    }

    _titleFor(mood, request) {
        if (request)
            return request.questions ? `${agentLabel(request.agent)} asks` : `${agentLabel(request.agent)} waits`;
        const sessions = this._store.list();
        const working = sessions.filter(s => s.state === State.WORKING).length;
        switch (mood) {
        case Mood.WORKING: return working > 1 ? `${working} working` : 'Working';
        case Mood.HAPPY: return 'Done';
        case Mood.SAD: return 'Failed';
        case Mood.SLEEPY: return '';
        default: return sessions.length > 1 ? `${sessions.length} sessions` : 'Idle';
        }
    }

    _renderBody(request) {
        const peeking = !this._expanded && this._peek;
        if (!this._expanded && !peeking) {
            this._content?.destroy();
            this._content = null;
            this._contentKey = null;
            this._body.visible = false;
            this._syncCountdown();
            return;
        }
        // A request card keeps its picked options: rebuild it only for another request.
        const key = this._expanded && request ? `request:${request.id}` : null;
        if (key && key === this._contentKey)
            return;
        this._contentKey = key;
        this._content?.destroy();
        if (!this._expanded)
            this._content = buildSessionList(this._store.list(), {compact: true});
        else if (request)
            this._content = buildRequestCard(request, decision => this._store.resolve(request.id, decision));
        else
            this._content = buildSessionList(this._store.list(), {
                openDiff: this._diffKey,
                onToggleDiff: key => {
                    this._diffKey = this._diffKey === key ? null : key;
                    this._resizeAround(() => this._renderBody(this._store.current));
                    this._reposition();
                },
            });
        this._body.add_child(this._content);
        if (!this._body.visible) {
            this._body.visible = true;
            this._body.opacity = 0;
            this._body.ease({opacity: 255, duration: FOLD_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._syncCountdown();
    }

    /** Tick once a second while a card shows a countdown; no timer otherwise. */
    _syncCountdown() {
        const needed = Boolean(this._content?.updateCountdown);
        if (needed && !this._countdownId) {
            this._countdownId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._content?.updateCountdown?.();
                // Releases the request at 0 s rather than at the next 5 s sweep.
                this._store.prune();
                return GLib.SOURCE_CONTINUE;
            });
            GLib.Source.set_name_by_id(this._countdownId, '[GnomeAgentBuddy] countdown');
        } else if (!needed && this._countdownId) {
            GLib.source_remove(this._countdownId);
            this._countdownId = 0;
        }
    }

    /** The monitor chosen in the settings (by connector), else the primary one, also when it is unplugged. */
    _targetMonitor() {
        const {primaryMonitor, monitors} = Main.layoutManager;
        const index = indexForConnector(this._settings.get_string('monitor'));
        return monitors[index] ?? primaryMonitor;
    }

    /** Remember the monitor the notch was dropped on; the primary one is stored as "primary". */
    _saveMonitorUnder(centreX, top) {
        const {primaryMonitor, monitors} = Main.layoutManager;
        const dropped = monitors.find(m => centreX >= m.x && centreX < m.x + m.width &&
            top >= m.y && top < m.y + m.height);
        if (!dropped)
            return;
        this._settings.set_string('monitor', dropped === primaryMonitor ? '' : connectorForIndex(dropped.index));
    }

    /**
     * Where the user dropped it, snapped to the edges, else the top centre under the
     * panel (see lib/placement.js). `animate`: glide there and flow into the docked
     * shape, as after a drop; otherwise jump (unfolding, a new monitor).
     */
    _reposition(animate = false) {
        const {primaryMonitor, monitors} = Main.layoutManager;
        // While it is being dragged the pointer decides, not us.
        if (!primaryMonitor || this._drag)
            return;
        // The widget is the body plus a margin on every side; placement works on the body.
        const m = this._metrics.margin;
        const [width, height] = this.get_size();
        const {x, y, dock} = place({
            saved: {x: this._settings.get_int('position-x'), y: this._settings.get_int('position-y')},
            size: {width: Math.max(0, width - 2 * m), height: Math.max(0, height - 2 * m)},
            monitors,
            primary: this._targetMonitor(),
            panelHeight: Main.panel.height,
            overlay: this._settings.get_boolean('overlay-panel'),
            snap: this._settings.get_int('snap-threshold'),
        });
        this._setDock(dock, animate);
        if (animate) {
            this.ease({x: x - m, y: y - m, duration: MORPH_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        } else {
            // Only the position: a running fade or resize must go on.
            this.remove_transition('x');
            this.remove_transition('y');
            this.set_position(x - m, y - m);
        }
    }

    destroy() {
        this._endDrag();
        if (this._peekTimer) {
            GLib.source_remove(this._peekTimer);
            this._peekTimer = 0;
        }
        if (this._countdownId) {
            GLib.source_remove(this._countdownId);
            this._countdownId = 0;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._outsideId) {
            global.stage.disconnect(this._outsideId);
            this._outsideId = 0;
        }
        super.destroy();
    }
});
