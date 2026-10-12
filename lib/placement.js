/** A dragged notch within this many px of a monitor's horizontal centre snaps back to it. */
export const SNAP_PX = 24;

/** Default distance from a screen edge (px) within which the notch docks to it. */
export const EDGE_SNAP_PX = 100;

const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * Where the notch goes. Pure: no GNOME imports, so it is unit-tested.
 *
 * `saved` is what the user left behind by dragging: the horizontal centre and the
 * top edge in screen coordinates, or null / negative for "never moved" (the
 * default is the top centre of the chosen monitor, under the panel unless
 * `overlay` says to cover it). A saved spot is kept fully on the monitor it sits
 * on; one that is not on the chosen monitor (or on a monitor that is gone)
 * falls back to the default.
 *
 * Snapping, as in GnomeCodeNotchBar: within `snap` px of the left or right edge
 * the notch docks flush to it, within `snap` px of the top (the default y) it
 * docks to the top; near the monitor's horizontal centre it centres. `dock` says
 * which edges it is flush with, so the UI can square off those corners.
 *
 * @param {object} args
 * @param {{x: number, y: number, edge?: string}|null} args.saved centre x, top y, and the
 *   side edge ('left' / 'right') it was docked to when dropped
 * @param {{width: number, height: number}} args.size
 * @param {{x: number, y: number, width: number, height: number}[]} args.monitors
 * @param {{x: number, y: number, width: number, height: number}} args.primary the chosen monitor
 * @param {number} args.panelHeight
 * @param {boolean} args.overlay
 * @param {number} [args.snap] edge snap distance in px
 * @returns {{x: number, y: number, dock: {left: boolean, right: boolean, top: boolean}}} top-left corner and docked edges
 */
export function place({saved, size, monitors, primary, panelHeight, overlay, snap = EDGE_SNAP_PX}) {
    const flatTop = overlay ? primary.y : primary.y + panelHeight;
    const centred = {
        x: Math.round(primary.x + (primary.width - size.width) / 2),
        y: flatTop,
        dock: {left: false, right: false, top: true},
    };
    if (!saved || saved.x < 0 || saved.y < 0)
        return centred;

    const monitor = monitors.find(m => saved.x >= m.x && saved.x < m.x + m.width &&
        saved.y >= m.y && saved.y < m.y + m.height);
    // A spot left on another monitor than the chosen one is not this notch's place.
    if (!monitor || !sameRect(monitor, primary))
        return centred;

    const dock = {left: false, right: false, top: false};
    let left = clamp(saved.x - size.width / 2, monitor.x, monitor.x + monitor.width - size.width);
    let top = clamp(saved.y, monitor.y, monitor.y + monitor.height - size.height);

    const rightGap = monitor.x + monitor.width - (left + size.width);
    const middle = monitor.x + monitor.width / 2;
    // A notch dropped on a side edge stays on it however its size changes (folding shrinks it
    // around its centre, which alone would move it out of the snap distance).
    if (saved.edge === 'left' || (saved.edge !== 'right' && left - monitor.x <= snap)) {
        left = monitor.x;
        dock.left = true;
    } else if (saved.edge === 'right' || rightGap <= snap) {
        left = monitor.x + monitor.width - size.width;
        dock.right = true;
    } else if (Math.abs(left + size.width / 2 - middle) <= SNAP_PX) {
        left = middle - size.width / 2;
    }
    if (Math.abs(top - flatTop) <= snap) {
        top = flatTop;
        dock.top = true;
    }
    return {x: Math.round(left), y: Math.round(top), dock};
}

/** The `saved` value for a notch whose top-left corner is at (x, y): centre x, top y. */
export const savedFrom = (x, y, width) => ({x: Math.round(x + width / 2), y: Math.round(y)});
