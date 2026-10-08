/**
 * Line diffs for the file-editing tools (Edit, MultiEdit, Write), for the ticker
 * (`file +N −M`) and the diff view. Pure logic, unit-tested with gjs.
 */

import {displayText} from './sessionStore.js';

/** Most diff lines kept per edit; the counts still cover the whole change. */
export const MAX_DIFF_LINES = 200;
const CONTEXT = 2;
/** Above this many cells the LCS table is not built: the middle is shown as replaced. */
const MAX_LCS_CELLS = 250_000;

const splitLines = text => {
    if (text === '')
        return [];
    const lines = String(text).split('\n');
    if (lines[lines.length - 1] === '')
        lines.pop();
    return lines;
};

/**
 * Line diff of two texts: `{op, text}` with op ` ` (same), `-` (removed) or `+`
 * (added). Common start and end are peeled off, the rest is an LCS diff.
 */
export function diffLines(oldText, newText) {
    const a = splitLines(oldText);
    const b = splitLines(newText);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start])
        start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }

    const out = a.slice(0, start).map(text => ({op: ' ', text}));
    out.push(...middle(a.slice(start, endA), b.slice(start, endB)));
    out.push(...a.slice(endA).map(text => ({op: ' ', text})));
    return out;
}

function middle(a, b) {
    if (!a.length || !b.length || a.length * b.length > MAX_LCS_CELLS)
        return [...a.map(text => ({op: '-', text})), ...b.map(text => ({op: '+', text}))];

    // lcs[i][j]: length of the LCS of a[i..] and b[j..].
    const lcs = Array.from({length: a.length + 1}, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--)
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            out.push({op: ' ', text: a[i]});
            i++;
            j++;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            out.push({op: '-', text: a[i++]});
        } else {
            out.push({op: '+', text: b[j++]});
        }
    }
    while (i < a.length)
        out.push({op: '-', text: a[i++]});
    while (j < b.length)
        out.push({op: '+', text: b[j++]});
    return out;
}

/** Only changed lines and `CONTEXT` lines around them; gaps become one `@` line. */
function withContext(lines) {
    const keep = new Array(lines.length).fill(false);
    lines.forEach((line, index) => {
        if (line.op === ' ')
            return;
        for (let k = Math.max(0, index - CONTEXT); k <= Math.min(lines.length - 1, index + CONTEXT); k++)
            keep[k] = true;
    });
    const out = [];
    lines.forEach((line, index) => {
        if (keep[index])
            out.push(line);
        else if (out.length && out[out.length - 1].op !== '@' && keep.slice(index).some(Boolean))
            out.push({op: '@', text: '…'});
    });
    return out;
}

const basename = path => String(path ?? '').split('/').filter(Boolean).pop() ?? '';

/**
 * What a finished Edit / MultiEdit / Write changed, or null when the call is not
 * one of those or changed nothing.
 *
 * @returns {{file: string, path: string, added: number, removed: number,
 *            lines: {op: string, text: string}[], truncated: boolean}|null}
 */
export function editFromTool(tool, input) {
    if (!input || typeof input !== 'object' || typeof input.file_path !== 'string')
        return null;

    let pairs;
    if (tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string')
        pairs = [[input.old_string, input.new_string]];
    else if (tool === 'MultiEdit' && Array.isArray(input.edits))
        pairs = input.edits.filter(e => e && typeof e.old_string === 'string' && typeof e.new_string === 'string')
            .map(e => [e.old_string, e.new_string]);
    else if (tool === 'Write' && typeof input.content === 'string')
        pairs = [['', input.content]];
    if (!pairs?.length)
        return null;

    let added = 0;
    let removed = 0;
    let lines = [];
    for (const [oldText, newText] of pairs) {
        const diff = diffLines(oldText, newText);
        added += diff.filter(l => l.op === '+').length;
        removed += diff.filter(l => l.op === '-').length;
        if (lines.length && diff.some(l => l.op !== ' '))
            lines.push({op: '@', text: '…'});
        lines.push(...withContext(diff));
    }
    if (!added && !removed)
        return null;

    const truncated = lines.length > MAX_DIFF_LINES;
    if (truncated)
        lines = lines.slice(0, MAX_DIFF_LINES);
    return {
        file: basename(input.file_path),
        path: input.file_path,
        added,
        removed,
        lines: lines.map(l => ({op: l.op, text: displayText(l.text)})),
        truncated,
    };
}
