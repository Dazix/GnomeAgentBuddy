import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {isTranscriptPath, readTitle, titleFromText} from '../lib/transcriptTitle.js';
import {assertEqual, assertTrue, test} from './harness.js';

const ai = title => `{"type":"ai-title","aiTitle":${JSON.stringify(title)},"sessionId":"s"}`;
const custom = title => `{"type":"custom-title","customTitle":${JSON.stringify(title)},"sessionId":"s"}`;

test('titleFromText: the last generated title wins, a custom one beats it', () => {
    assertEqual(titleFromText(`${ai('old')}\n{"type":"user"}\n${ai('new one')}\n`), 'new one');
    assertEqual(titleFromText(`${custom('mine')}\n${ai('generated')}\n`), 'mine');
    assertEqual(titleFromText(`${ai('generated')}\n${custom('first')}\n${custom('renamed')}\n`), 'renamed');
});

test('titleFromText: escapes, unicode, and nothing', () => {
    assertEqual(titleFromText(ai('Řekni "ahoj" \\ ok')), 'Řekni "ahoj" \\ ok');
    assertEqual(titleFromText('{"type":"user","message":"hi"}\n'), null);
    assertEqual(titleFromText(ai('   ')), null);
    // A cut first line (tail read) is just ignored.
    assertEqual(titleFromText(`Title":"x"}\n${ai('ok')}\n`), 'ok');
});

test('isTranscriptPath: only .jsonl under ~/.claude, no traversal', () => {
    assertTrue(isTranscriptPath('/h/.claude/projects/p/s.jsonl', '/h'));
    assertEqual(isTranscriptPath('/h/.claude/projects/../../.ssh/key.jsonl', '/h'), false);
    assertEqual(isTranscriptPath('/etc/passwd', '/h'), false);
    assertEqual(isTranscriptPath('/h/.claude/settings.json', '/h'), false);
    assertEqual(isTranscriptPath('relative/s.jsonl', '/h'), false);
    assertEqual(isTranscriptPath(undefined, '/h'), false);
});

test('readTitle: finds the title near the end of a big transcript, null for a missing file', async () => {
    const home = GLib.dir_make_tmp('agentbuddy-title-XXXXXX');
    try {
        const dir = `${home}/.claude/projects/p`;
        GLib.mkdir_with_parents(dir, 0o755);
        const path = `${dir}/s.jsonl`;
        const filler = `{"type":"user","message":"${'x'.repeat(1000)}"}\n`.repeat(600);
        // The only title sits before the last 256 KB, so the second, larger read has to find it.
        Gio.File.new_for_path(path).replace_contents(
            new TextEncoder().encode(`${ai('deep title')}\n${filler}`), null, false, Gio.FileCreateFlags.NONE, null);
        assertEqual(await readTitle(path, home), 'deep title');
        assertEqual(await readTitle(`${dir}/missing.jsonl`, home), null);
        assertEqual(await readTitle('/etc/passwd', home), null);
    } finally {
        GLib.spawn_command_line_sync(`rm -rf ${home}`);
    }
});
