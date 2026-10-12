import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    MAX_ANCESTORS, MAX_DIFF_FIELD_LEN, MAX_FIELD_LEN,
    ancestorsFrom, canonicalEvent, decisionJson, normalizeFields, parentFromStat, prepare, refineEvent,
    replyStdout, socketPath, takesDecisions, talk, truncatePayload,
} from '../relay/agentbuddy-hook-core.js';
import {assertEqual, assertTrue, test} from './harness.js';

const AGENTS = ['', 'gemini', 'antigravity', 'cursor', 'codex', 'copilot', 'opencode', 'my-tool'];
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest',
    'Notification', 'Stop', 'StopFailure', 'SessionEnd', ''];

const noEnv = () => null;
const bytes = text => new TextEncoder().encode(text);
const byteLength = text => bytes(text).length;
const run = (raw, agent = '', event = '') => {
    const {line, name, question} = prepare(bytes(raw), agent, event, noEnv, '/home/me/here');
    return {value: JSON.parse(line), name, question};
};
const parseReply = out => JSON.parse(out).hookSpecificOutput.decision;

/** Whether a reply tells the agent to allow something. */
function allows(out) {
    const value = JSON.parse(out);
    const decided = 'decision' in value && value.decision !== 'ask';
    return JSON.stringify(value).includes('allow') || decided;
}

test('hook: agent event names map onto Claude Code', () => {
    for (const [raw, canonical] of [['BeforeTool', 'PreToolUse'], ['AfterAgent', 'Stop'],
        ['PreInvocation', 'UserPromptSubmit'], ['preToolUse', 'PreToolUse'],
        ['permissionRequest', 'PermissionRequest'], ['beforeSubmitPrompt', 'UserPromptSubmit'],
        ['subagentStop', 'SubagentStop']])
        assertEqual(canonicalEvent(raw), canonical);
    for (const same of ['PreToolUse', 'Interrupt', 'somethingNew', 'toString'])
        assertEqual(canonicalEvent(same), same);
});

test('hook: a stop that reports an error is a failure', () => {
    assertEqual(refineEvent('Stop', {status: 'error'}), 'StopFailure');
    assertEqual(refineEvent('Stop', {status: 'completed'}), 'Stop');
    assertEqual(refineEvent('PreToolUse', {status: 'error'}), 'PreToolUse');
});

test('hook fields: Antigravity tool call', () => {
    const payload = {conversationId: 'c1', workspacePaths: ['/w'],
        toolCall: {name: 'run_command', args: {CommandLine: 'ls'}}};
    normalizeFields(payload, noEnv);
    assertEqual(payload.tool_name, 'run_command');
    assertEqual(payload.tool_input.command, 'ls');
    assertEqual(payload.session_id, 'c1');
    assertEqual(payload.cwd, '/w');
});

test('hook fields: Copilot arguments as JSON text', () => {
    const payload = {toolName: 'bash', toolArgs: '{"command":"npm test"}', sessionId: 's9', workdir: '/app'};
    normalizeFields(payload, noEnv);
    assertEqual(payload.tool_input.command, 'npm test');
    assertEqual(payload.cwd, '/app');
});

test('hook fields: what the payload already has is kept', () => {
    const payload = {tool_name: 'Bash', session_id: 'keep', cwd: '/keep',
        toolName: 'other', conversationId: 'no', workdir: '/no'};
    normalizeFields(payload, () => 'env');
    assertEqual([payload.tool_name, payload.session_id, payload.cwd], ['Bash', 'keep', '/keep']);
});

test('hook fields: the Gemini session id from the environment comes last', () => {
    const payload = {};
    normalizeFields(payload, key => key === 'GEMINI_SESSION_ID' ? 'g7' : null);
    assertEqual(payload.session_id, 'g7');
});

test('hook fields: odd shapes are ignored', () => {
    const payload = {toolCall: 'nope', toolArgs: 'not json', workspacePaths: 'x', tool: 3};
    normalizeFields(payload, noEnv);
    for (const key of ['tool_name', 'tool_input', 'cwd'])
        assertTrue(!(key in payload), key);
});

test('hook prepare: a Claude Code payload passes through', () => {
    const {value, name} = run('{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"/p"}');
    assertEqual(name, 'PreToolUse');
    assertTrue(!('agentbuddy_agent' in value));
    assertEqual(value.cwd, '/p');
});

test('hook prepare: another agent is tagged and renamed', () => {
    const {value, name} = run('{"hook_event_name":"BeforeTool","toolCall":{"name":"shell",' +
        '"args":{"CommandLine":"ls"}}}', 'gemini');
    assertEqual(name, 'PreToolUse');
    assertEqual(value.agentbuddy_agent, 'gemini');
    assertEqual(value.tool_input.command, 'ls');
    assertEqual(value.cwd, '/home/me/here');
});

test('hook prepare: unreadable input is not forwarded', () => {
    for (const raw of [new Uint8Array(0), bytes('not json'), bytes('[1,2]')])
        assertEqual(prepare(raw, '', '', noEnv, '/'), null);
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF, ...bytes('{"hook_event_name":"Stop"}')]);
    assertTrue(prepare(bom, '', '', noEnv, '/') !== null);
});

test('hook prepare: a question is kept whole for the answer, cut in what is sent', () => {
    const long = 'x'.repeat(3000);
    const raw = JSON.stringify({hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion',
        tool_input: {questions: [{question: long}]}});
    const {value, question} = run(raw);
    assertEqual(question.questions[0].question.length, 3000);
    assertTrue(value.tool_input.questions[0].question.endsWith('…'));
});

test('hook prepare: long strings are cut on a character boundary', () => {
    const text = truncatePayload({tool_input: {content: 'é'.repeat(4000)}}, 'PreToolUse').tool_input.content;
    assertTrue(text.endsWith('…'));
    assertTrue(byteLength(text) <= MAX_FIELD_LEN + 4);
    assertTrue(!text.includes('�'));
});

test('hook prepare: a finished edit keeps its text whole', () => {
    const big = 'line\n'.repeat(4000);
    const value = truncatePayload({tool_name: 'Edit', cwd: 'x'.repeat(4000),
        tool_input: {file_path: '/p/a.ts', old_string: big, new_string: big}}, 'PostToolUse');
    assertEqual(value.tool_input.old_string.length, big.length);
    assertTrue(byteLength(value.cwd) <= MAX_FIELD_LEN + 4);
    assertTrue(!('agentbuddy_diff_truncated' in value));
});

test('hook prepare: an edit is capped before it happens, and for other tools', () => {
    const big = 'é'.repeat(4000);
    for (const [event, tool] of [['PreToolUse', 'Edit'], ['PermissionRequest', 'Write'], ['PostToolUse', 'Bash']]) {
        const value = truncatePayload({tool_name: tool, tool_input: {content: big}}, event);
        assertTrue(byteLength(value.tool_input.content) <= MAX_FIELD_LEN + 4, `${event} ${tool}`);
    }
});

test('hook prepare: an edit beyond the budget is cut and flagged', () => {
    const value = truncatePayload({tool_name: 'Write',
        tool_input: {content: 'x'.repeat(MAX_DIFF_FIELD_LEN + 10)}}, 'PostToolUse');
    assertEqual(value.agentbuddy_diff_truncated, true);
});

test('hook reply: nothing is allowed without a decision', () => {
    for (const agent of AGENTS) {
        for (const event of EVENTS) {
            for (const decision of [null, '', 'ask', 'maybe', '{"permissionDecision":"allow"}']) {
                const out = replyStdout(agent, event, decision, null);
                if (out)
                    assertTrue(!allows(out), `${agent} ${event} ${decision} ${out}`);
            }
        }
    }
});

test('hook reply: a decision counts only on a permission request of a deciding agent', () => {
    for (const agent of AGENTS) {
        for (const event of EVENTS.filter(e => e !== 'PermissionRequest')) {
            const out = replyStdout(agent, event, 'allow', null);
            if (out)
                assertTrue(!allows(out));
        }
        const out = replyStdout(agent, 'PermissionRequest', 'allow', null);
        assertEqual(Boolean(out && allows(out)), takesDecisions(agent), agent);
    }
});

test('hook reply: shapes', () => {
    const allow = {behavior: 'allow'};
    for (const agent of ['', 'codex']) {
        assertEqual(parseReply(replyStdout(agent, 'PermissionRequest', 'allow', null)), allow);
        assertEqual(parseReply(replyStdout(agent, 'PermissionRequest', 'always', null)), allow);
        assertEqual(parseReply(replyStdout(agent, 'PermissionRequest', 'deny', null)).behavior, 'deny');
        assertEqual(replyStdout(agent, 'PermissionRequest', null, null), null);
        assertEqual(replyStdout(agent, 'PreToolUse', null, null), null);
    }
    assertEqual(replyStdout('copilot', 'PermissionRequest', 'deny', null), '{"permissionDecision":"deny"}');
    assertEqual(replyStdout('copilot', 'PermissionRequest', null, null), '{"permissionDecision":"ask"}');
    assertEqual(replyStdout('copilot', 'PreToolUse', null, null), '{}');
    assertEqual(replyStdout('antigravity', 'PreToolUse', null, null), '{"decision":"ask"}');
    assertEqual(replyStdout('antigravity', 'Stop', null, null), '{}');
    assertEqual(replyStdout('gemini', 'PreToolUse', null, null), '{}');
    assertEqual(replyStdout('cursor', 'PreToolUse', null, null), null);
    assertEqual(replyStdout('gemini', 'PermissionRequest', 'allow', null), null);
});

const QUESTION = {questions: [
    {question: 'Which?', options: [{label: 'A'}, {label: 'B'}]},
    {question: 'Extras?', multiSelect: true, options: [{label: 'Tests'}, {label: 'Docs'}]},
]};

test('hook reply: answers must match the questions', () => {
    const ok = answers => decisionJson(JSON.stringify({answers}), QUESTION) !== null;
    assertTrue(ok({'Which?': 'A', 'Extras?': ['Tests', 'Docs']}));
    assertTrue(!ok({'Which?': 'C', 'Extras?': ['Tests']}));
    assertTrue(!ok({'Which?': 'A'}));
    assertTrue(!ok({'Which?': ['A'], 'Extras?': ['Tests']}));
    assertTrue(!ok({'Which?': 'A', 'Extras?': 'Tests'}));
    assertTrue(!ok({'Which?': 'A', 'Extras?': []}));
    assertTrue(!ok({'Which?': 'A', 'Extras?': ['Tests', 'Tests']}));
    assertEqual(decisionJson('{"answers":{"q":"a"}}', null), null);
});

test('hook reply: an answered question returns the same input plus the answers', () => {
    const question = {questions: [{question: 'Which?', options: [{label: 'A'}, {label: 'B'}]}]};
    const decision = parseReply(replyStdout('', 'PermissionRequest', '{"answers":{"Which?":"B"}}', question));
    assertEqual(decision.updatedInput.questions, question.questions);
    assertEqual(decision.updatedInput.answers, {'Which?': 'B'});
    assertEqual(replyStdout('codex', 'PermissionRequest', '{"answers":{"Which?":"B"}}', question), null);
});

const RULE = {type: 'addRules', rules: [{toolName: 'Bash', ruleContent: 'node --check'}],
    behavior: 'allow', destination: 'localSettings'};
const MODE = {type: 'setMode', mode: 'auto', destination: 'session'};
const choose = (index, suggestions, agent = '') =>
    replyStdout(agent, 'PermissionRequest', JSON.stringify({suggestion: index}), null, suggestions);

test('hook suggestions: the picked one is echoed back verbatim', () => {
    assertEqual(parseReply(choose(1, [RULE, MODE])), {behavior: 'allow', updatedPermissions: [MODE]});
    assertEqual(parseReply(choose(0, [RULE])).updatedPermissions, [RULE]);
});

test('hook suggestions: whole suggestions survive the field cap', () => {
    const longRule = {...RULE, rules: [{toolName: 'Bash', ruleContent: 'x'.repeat(5000)}]};
    const raw = JSON.stringify({hook_event_name: 'PermissionRequest', tool_name: 'Bash',
        permission_suggestions: [longRule]});
    const {line, suggestions} = prepare(bytes(raw), '', '', noEnv, '/');
    assertEqual(suggestions[0].rules[0].ruleContent.length, 5000);
    assertTrue(JSON.parse(line).permission_suggestions[0].rules[0].ruleContent.endsWith('…'));
});

test('hook suggestions: nothing unsafe or out of range is accepted', () => {
    const entries = [
        {...RULE, behavior: 'deny'},
        {type: 'setMode', mode: 'bypassPermissions', destination: 'session'},
        {...RULE, destination: '/etc'},
        {type: 'replaceRules', rules: [], behavior: 'allow', destination: 'session'},
        'text', null,
    ];
    for (const index of [5, -1, '0', true, 1.5])
        assertEqual(choose(index, [RULE]), null, String(index));
    for (const entry of entries)
        assertEqual(choose(0, [entry]), null, JSON.stringify(entry));
    assertEqual(choose(0, null), null);
});

test('hook suggestions: only Claude Code takes them', () => {
    assertEqual(choose(0, [RULE], 'codex'), null);
    assertEqual(choose(0, [RULE], 'gemini'), null);
});

/** A listening Unix socket in a fresh private directory; `handler(connection)` runs once on connect. */
function listen(handler) {
    const dir = GLib.dir_make_tmp('agentbuddy-hook-XXXXXX');
    const path = GLib.build_filenamev([dir, 'agentbuddy.sock']);
    const service = new Gio.SocketService();
    service.add_address(Gio.UnixSocketAddress.new(path), Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT, null);
    service.connect('incoming', (_service, connection) => {
        handler(connection);
        return true;
    });
    service.start();
    const cleanup = () => {
        service.stop();
        service.close();
        for (const name of [path, GLib.build_filenamev([dir, 'talk.js'])]) {
            try {
                Gio.File.new_for_path(name).delete(null);
            } catch (_e) {
                // The child script is only there once a test ran one.
            }
        }
        Gio.File.new_for_path(dir).delete(null);
    };
    return {path, cleanup};
}

/** Run a blocking `talk()` while the main loop serves the socket, in a thread-free way: a child gjs does the talking. */
function talkInChild(path, line, waits) {
    const script = `import {talk} from '${Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_uri()}` +
        `/relay/agentbuddy-hook-core.js'; print(String(talk(${JSON.stringify(path)}, ${JSON.stringify(line)}, ${waits}, 5)));`;
    const file = GLib.build_filenamev([GLib.path_get_dirname(path), 'talk.js']);
    Gio.File.new_for_path(file).replace_contents(new TextEncoder().encode(script), null, false,
        Gio.FileCreateFlags.NONE, null);
    const proc = Gio.Subprocess.new(['gjs', '-m', file], Gio.SubprocessFlags.STDOUT_PIPE);
    return new Promise((resolve, reject) => {
        proc.communicate_utf8_async(null, null, (_p, result) => {
            try {
                resolve(proc.communicate_utf8_finish(result)[1].trim());
            } catch (e) {
                reject(e);
            }
        });
    });
}

test('hook transport: no socket means no answer', () => {
    assertEqual(talk(null, '{}\n', true, 1), null);
    assertEqual(talk('/nonexistent/agentbuddy.sock', '{}\n', true, 1), null);
});

test('hook transport: a permission request waits for the answer', async () => {
    const received = [];
    const {path, cleanup} = listen(connection => {
        const input = new Gio.DataInputStream({base_stream: connection.get_input_stream()});
        input.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, result) => {
            received.push(new TextDecoder().decode(input.read_line_finish(result)[0]));
            connection.get_output_stream().write_all(new TextEncoder().encode('allow\n'), null);
            connection.close(null);
        });
    });
    try {
        assertEqual(await talkInChild(path, '{"a":1}\n', true), 'allow');
        assertEqual(received, ['{"a":1}']);
    } finally {
        cleanup();
    }
});

test('hook transport: fire and forget does not wait for an answer', async () => {
    const received = [];
    const {path, cleanup} = listen(connection => {
        const input = new Gio.DataInputStream({base_stream: connection.get_input_stream()});
        input.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, result) => {
            received.push(new TextDecoder().decode(input.read_line_finish(result)[0]));
        });
        // The connection stays open and silent: waiting for it would hang the test.
        connection.ref_me = true;
    });
    try {
        assertEqual(await talkInChild(path, '{"b":2}\n', false), 'null');
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
        assertEqual(received, ['{"b":2}']);
    } finally {
        cleanup();
    }
});

test('hook transport: the socket path needs a private runtime directory', () => {
    const dir = GLib.dir_make_tmp('agentbuddy-hook-XXXXXX');
    try {
        GLib.chmod(dir, 0o700);
        assertEqual(socketPath(() => dir), `${dir}/agentbuddy.sock`);
        GLib.chmod(dir, 0o755);
        assertEqual(socketPath(() => dir), null);
    } finally {
        Gio.File.new_for_path(dir).delete(null);
    }
});

test('hook ancestors: the walk goes up to init', () => {
    const parents = {500: 400, 400: 300, 300: 1};
    assertEqual(ancestorsFrom(500, pid => parents[pid] ?? null), [500, 400, 300]);
});

test('hook ancestors: stops at an unknown process and at a loop', () => {
    assertEqual(ancestorsFrom(500, pid => ({500: 400})[pid] ?? null), [500, 400]);
    assertEqual(ancestorsFrom(7, pid => ({7: 8, 8: 7})[pid] ?? null), [7, 8]);
});

test('hook ancestors: the walk is bounded', () => {
    assertEqual(ancestorsFrom(900, pid => pid - 1).length, MAX_ANCESTORS);
});

test('hook ancestors: the parent is read from a stat line with an odd name', () => {
    assertEqual(parentFromStat('42 (my) app) S 7 42 42 0'), 7);
    assertEqual(parentFromStat('garbage'), null);
});

test('hook ancestors: prepare forwards the chain', () => {
    const raw = bytes('{"hook_event_name":"Stop","session_id":"s"}');
    assertEqual(JSON.parse(prepare(raw, '', '', noEnv, '/', [5, 4]).line).agentbuddy_pids, [5, 4]);
    assertTrue(!('agentbuddy_pids' in JSON.parse(prepare(raw, '', '', noEnv, '/').line)));
});
