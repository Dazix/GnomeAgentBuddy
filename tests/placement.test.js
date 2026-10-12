import Gio from 'gi://Gio';

import {SNAP_PX, place, savedFrom} from '../lib/placement.js';
import {assertEqual, assertTrue, test} from './harness.js';

const primary = {x: 0, y: 0, width: 1920, height: 1080};
const second = {x: 1920, y: 0, width: 1280, height: 1024};
const size = {width: 200, height: 40};
const base = {size, monitors: [primary, second], primary, panelHeight: 32, overlay: false, snap: 20};

/** Position only; the docked edges have their own tests. */
const at = args => {
    const {x, y} = place(args);
    return {x, y};
};

test('placement: never moved is the top centre under the panel, or over it', () => {
    assertEqual(at({...base, saved: null}), {x: 860, y: 32});
    assertEqual(at({...base, saved: {x: -1, y: -1}}), {x: 860, y: 32});
    assertEqual(at({...base, saved: null, overlay: true}), {x: 860, y: 0});
});

test('placement: the chosen monitor decides where the default goes', () => {
    assertEqual(at({...base, primary: second, saved: null}), {x: 2460, y: 32});
});

test('placement: a saved spot is kept, as a centre', () => {
    assertEqual(at({...base, saved: {x: 400, y: 300}}), {x: 300, y: 300});
});

test('placement: stays fully inside its monitor on every edge', () => {
    assertEqual(at({...base, saved: {x: 10, y: 5}}), {x: 0, y: 5});
    assertEqual(at({...base, saved: {x: 1915, y: 1075}}), {x: 1720, y: 1040});
    assertEqual(at({...base, primary: second, saved: {x: 3199, y: 1000}}), {x: 3000, y: 984});
});

test('placement: near the monitor centre it snaps back to it', () => {
    assertEqual(at({...base, saved: {x: 960 + SNAP_PX, y: 100}}), {x: 860, y: 100});
    assertEqual(at({...base, saved: {x: 960 + SNAP_PX + 1, y: 100}}), {x: 861 + SNAP_PX, y: 100});
    // The second monitor has its own centre.
    assertEqual(at({...base, primary: second, saved: {x: 2560 - 10, y: 100}}), {x: 2460, y: 100});
});

test('placement: a spot on another monitor than the chosen one is not used', () => {
    assertEqual(at({...base, saved: {x: 2500, y: 100}}), {x: 860, y: 32});
    assertEqual(at({...base, primary: second, saved: {x: 400, y: 300}}), {x: 2460, y: 32});
});

test('placement: a spot on a monitor that is gone falls back to the default', () => {
    assertEqual(at({...base, monitors: [primary], saved: {x: 2500, y: 100}}), {x: 860, y: 32});
    assertEqual(at({...base, saved: {x: 500, y: 5000}}), {x: 860, y: 32});
});

test('placement: a notch wider than the monitor is pinned to its left edge', () => {
    const small = {x: 0, y: 0, width: 150, height: 100};
    assertEqual(at({...base, size: {width: 200, height: 40}, monitors: [small], primary: small,
        saved: {x: 120, y: 10}}), {x: 0, y: 10});
});

test('snap: within the distance of the left or right edge it docks flush to it', () => {
    const near = {...base, snap: 100};
    // The centre is saved: a 200 px wide body with its centre at 190 starts 90 px from the left wall.
    const left = place({...near, saved: {x: 190, y: 400}});
    assertEqual([left.x, left.dock], [0, {left: true, right: false, top: false}]);

    // 101 px away is free.
    const free = place({...near, saved: {x: 201, y: 400}});
    assertEqual([free.x, free.dock.left], [101, false]);

    // And the right side: 50 px from the wall docks, 101 does not.
    const closeRight = place({...near, saved: {x: 1770, y: 400}});
    assertEqual([closeRight.x, closeRight.dock.right], [1720, true]);
    const farRight = place({...near, saved: {x: 1719, y: 400}});
    assertEqual([farRight.x, farRight.dock.right], [1619, false]);
});

test('snap: a remembered side edge keeps a shrunken notch docked', () => {
    // Folded to 60 px wide, the saved centre (100) is 70 px from the wall: beyond snap 20, but the edge wins.
    const folded = {...base, size: {width: 60, height: 40}};
    const left = place({...folded, saved: {x: 100, y: 400, edge: 'left'}});
    assertEqual([left.x, left.dock.left], [0, true]);
    assertEqual(place({...folded, saved: {x: 100, y: 400}}).dock.left, false);

    const right = place({...folded, saved: {x: 1820, y: 400, edge: 'right'}});
    assertEqual([right.x, right.dock.right], [1860, true]);

    // On another monitor the edge is that monitor's, and a spot off the chosen monitor still falls back.
    const onSecond = place({...folded, primary: second, saved: {x: 2020, y: 400, edge: 'left'}});
    assertEqual([onSecond.x, onSecond.dock.left], [1920, true]);
    assertEqual(place({...folded, saved: {x: 2500, y: 100, edge: 'left'}}).dock.left, false);
});

test('snap: within the distance of the top it docks to the top, otherwise it hangs free', () => {
    const near = place({...base, snap: 100, saved: {x: 600, y: 32 + 90}});
    assertEqual([near.y, near.dock.top], [32, true]);
    const far = place({...base, snap: 100, saved: {x: 600, y: 32 + 101}});
    assertEqual([far.y, far.dock.top], [133, false]);
    // Over the panel the top is the monitor's own.
    const over = place({...base, overlay: true, snap: 100, saved: {x: 600, y: 60}});
    assertEqual([over.y, over.dock.top], [0, true]);
});

test('snap: a corner docks to both walls, and a snap distance of 0 only docks when already flush', () => {
    const corner = place({...base, snap: 100, saved: {x: 140, y: 40}});
    assertEqual([corner.x, corner.y, corner.dock], [0, 32, {left: true, right: false, top: true}]);
    const exact = place({...base, snap: 0, saved: {x: 100, y: 32}});
    assertEqual([exact.x, exact.dock.left, exact.dock.top], [0, true, true]);
    assertEqual(place({...base, snap: 0, saved: {x: 101, y: 33}}).dock, {left: false, right: false, top: false});
});

test('snap: the default spot is docked to the top, and the centre snap leaves the sides free', () => {
    assertEqual(place({...base, saved: null}).dock, {left: false, right: false, top: true});
    assertEqual(place({...base, snap: 100, saved: {x: 960, y: 500}}).dock, {left: false, right: false, top: false});
});

test('savedFrom: corner to centre x and top y, and back', () => {
    assertEqual(savedFrom(300, 300, 200), {x: 400, y: 300});
    assertEqual(at({...base, saved: savedFrom(300, 300, 200)}), {x: 300, y: 300});
});

test('remembering: the schema keeps the spot and the monitor, with "never moved" defaults', () => {
    const dir = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('schemas');
    const source = Gio.SettingsSchemaSource.new_from_directory(dir.get_path(), null, false);
    const schema = source.lookup('org.gnome.shell.extensions.agentbuddy', false);
    for (const key of ['position-x', 'position-y'])
        assertEqual(schema.get_key(key).get_default_value().deep_unpack(), -1);
    assertEqual(schema.get_key('monitor').get_default_value().deep_unpack(), '');

    // A written spot reads back as it was written (memory backend: nothing touches real settings).
    const settings = new Gio.Settings({
        settings_schema: schema,
        backend: Gio.memory_settings_backend_new(),
    });
    const saved = savedFrom(300, 300, 200);
    settings.set_int('position-x', saved.x);
    settings.set_int('position-y', saved.y);
    settings.set_string('monitor', 'HDMI-1');
    assertEqual({x: settings.get_int('position-x'), y: settings.get_int('position-y')}, saved);
    assertEqual(settings.get_string('monitor'), 'HDMI-1');
    assertTrue(true);
});
