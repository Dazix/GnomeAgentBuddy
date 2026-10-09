import {cleanPids, pickWindow} from '../lib/windowMatch.js';
import {assertEqual, test} from './harness.js';

const win = (id, pid, title = '') => ({id, pid, title});

test('cleanPids: only a short list of positive integers', () => {
    assertEqual(cleanPids([5, 4, 3]), [5, 4, 3]);
    assertEqual(cleanPids([5, '4', -1, 0, 1.5, null, 5]), [5]);
    assertEqual(cleanPids('nope'), []);
    assertEqual(cleanPids(Array.from({length: 50}, (_, i) => i + 2)).length, 16);
});

test('pickWindow: the window owned by an ancestor', () => {
    const windows = [win('a', 10), win('b', 20), win('c', 30)];
    assertEqual(pickWindow(windows, [99, 20, 5], {})?.id, 'b');
});

test('pickWindow: nothing matches, nothing is picked', () => {
    assertEqual(pickWindow([win('a', 10)], [99, 98], {}), null);
    assertEqual(pickWindow([win('a', 10)], [], {}), null);
});

test('pickWindow: a terminal server owns several windows, the title with the project wins', () => {
    const windows = [win('a', 7, 'vim notes'), win('b', 7, 'claude · my-app'), win('c', 7, 'htop')];
    assertEqual(pickWindow(windows, [50, 7], {project: 'my-app'})?.id, 'b');
});

test('pickWindow: no title hint, the most recently used window of that owner', () => {
    const windows = [win('a', 7, 'one'), win('b', 7, 'two')];
    assertEqual(pickWindow(windows, [7], {project: 'zzz'})?.id, 'a');
});

test('pickWindow: the nearest ancestor with a window beats a farther one', () => {
    const windows = [win('far', 30), win('near', 20)];
    assertEqual(pickWindow(windows, [20, 30], {})?.id, 'near');
});

test('pickWindow: a title hint is not case sensitive and an empty hint is ignored', () => {
    const windows = [win('a', 7, 'x'), win('b', 7, 'My-App: ~/src')];
    assertEqual(pickWindow(windows, [7], {project: 'my-app'})?.id, 'b');
    assertEqual(pickWindow(windows, [7], {project: ''})?.id, 'a');
});
