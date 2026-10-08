import {diffLines, editFromTool, MAX_DIFF_LINES} from '../model/editDiff.js';
import {assertEqual, assertTrue, test} from './harness.js';

const ops = lines => lines.map(l => l.op + l.text);

test('diffLines: identical text has no changes', () => {
    assertEqual(diffLines('a\nb', 'a\nb').filter(l => l.op !== ' ').length, 0);
});

test('diffLines: a changed middle line keeps the context around it', () => {
    assertEqual(ops(diffLines('a\nb\nc', 'a\nB\nc')), [' a', '-b', '+B', ' c']);
});

test('diffLines: pure insertion and pure deletion', () => {
    assertEqual(ops(diffLines('a\nc', 'a\nb\nc')), [' a', '+b', ' c']);
    assertEqual(ops(diffLines('a\nb\nc', 'a\nc')), [' a', '-b', ' c']);
});

test('diffLines: empty old text is all additions, empty new text all removals', () => {
    assertEqual(ops(diffLines('', 'x\ny')), ['+x', '+y']);
    assertEqual(ops(diffLines('x\ny', '')), ['-x', '-y']);
});

test('diffLines: moved block still counts only real changes (LCS, not prefix/suffix)', () => {
    const lines = diffLines('a\nb\nc\nd\ne', 'a\nc\nX\ne');
    assertEqual(lines.filter(l => l.op === '+').length, 1);
    assertEqual(lines.filter(l => l.op === '-').length, 2);
});

test('editFromTool: Edit gives file, counts and diff', () => {
    const edit = editFromTool('Edit', {file_path: '/p/src/a.js', old_string: 'one\ntwo', new_string: 'one\n2\nthree'});
    assertEqual(edit.file, 'a.js');
    assertEqual(edit.path, '/p/src/a.js');
    assertEqual([edit.added, edit.removed], [2, 1]);
    assertEqual(ops(edit.lines), [' one', '-two', '+2', '+three']);
    assertEqual(edit.truncated, false);
});

test('editFromTool: Write counts every line as added', () => {
    const edit = editFromTool('Write', {file_path: '/p/new.txt', content: 'a\nb\nc'});
    assertEqual([edit.added, edit.removed], [3, 0]);
});

test('editFromTool: MultiEdit sums its edits and separates hunks', () => {
    const edit = editFromTool('MultiEdit', {file_path: '/p/a.js', edits: [
        {old_string: 'a', new_string: 'b'},
        {old_string: 'c\nd', new_string: 'c'},
    ]});
    assertEqual([edit.added, edit.removed], [1, 2]);
    assertTrue(edit.lines.some(l => l.op === '@'), 'hunk separator');
});

test('editFromTool: not an edit, or nothing usable, is null', () => {
    assertEqual(editFromTool('Bash', {command: 'ls'}), null);
    assertEqual(editFromTool('Edit', {file_path: '/p/a.js'}), null);
    assertEqual(editFromTool('Edit', null), null);
    assertEqual(editFromTool('Edit', {file_path: '/p/a.js', old_string: 'x', new_string: 'x'}), null);
});

test('editFromTool: a huge change keeps true counts but shows a capped diff', () => {
    const big = Array.from({length: 5000}, (_, i) => `line ${i}`).join('\n');
    const edit = editFromTool('Write', {file_path: '/p/big.txt', content: big});
    assertEqual(edit.added, 5000);
    assertEqual(edit.lines.length <= MAX_DIFF_LINES + 1, true);
    assertEqual(edit.truncated, true);
});

test('editFromTool: control characters in the diff text are made visible', () => {
    const edit = editFromTool('Write', {file_path: '/p/a.txt', content: 'ok‮evil'});
    assertTrue(edit.lines[0].text.includes('<U+202E>'));
});
