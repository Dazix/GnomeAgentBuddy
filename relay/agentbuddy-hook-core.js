/**
 * The logic of agentbuddy-hook, the relay an AI coding agent runs on each hook event.
 *
 * It reads the hook JSON from stdin, maps the agent's event and field names onto Claude
 * Code's, and hands it to the AgentBuddy extension over the Unix socket
 * $XDG_RUNTIME_DIR/agentbuddy.sock. The entry point is the `agentbuddy-hook` script
 * beside this file; the code here has no side effects on import, so tests can load it.
 *
 * Hard rule: never block the agent.
 *   - No socket (extension off) means we exit 0 at once with only the "no opinion"
 *     reply the agent expects.
 *   - Only a PermissionRequest waits for an answer. No answer means no decision and
 *     the agent asks in its terminal exactly as without the extension.
 *   - Nothing that allows anything is ever printed without a decision a human clicked.
 *
 * The normalisation and reply tables are a port of the MIT-licensed relay of
 * Louis-CFM/coucou (windows/hook/src/{normalize,reply}.rs), Copyright (c) 2026 Louis Raille.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const CONNECT_TIMEOUT_S = 1;
const FIRE_AND_FORGET_BUDGET_S = 2;
const DECISION_BUDGET_S = 890;
export const MAX_FIELD_LEN = 2000;
const DROPPED_FIELDS = ['tool_response', 'tool_output'];
const DIFF_TOOLS = ['Edit', 'MultiEdit', 'Write'];
const DIFF_FIELDS = ['old_string', 'new_string', 'content'];
export const MAX_DIFF_FIELD_LEN = 256 * 1024;
const MAX_DIFF_TOTAL = 512 * 1024;
const SOCKET_NAME = 'agentbuddy.sock';
export const MAX_ANCESTORS = 12;

const EVENT_NAMES = {
    // Gemini CLI
    BeforeTool: 'PreToolUse', BeforeToolSelection: 'PreToolUse',
    AfterTool: 'PostToolUse', AfterModel: 'PostToolUse',
    BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop',
    startup: 'SessionStart', exit: 'SessionEnd',
    // Antigravity
    PreInvocation: 'UserPromptSubmit', PostInvocation: 'PostToolUse',
    // snake_case relays
    pre_tool_use: 'PreToolUse', post_tool_use: 'PostToolUse',
    user_prompt_submit: 'UserPromptSubmit', session_start: 'SessionStart',
    session_end: 'SessionEnd', stop: 'Stop',
    // Copilot CLI (camelCase), Cursor shares most
    sessionStart: 'SessionStart', userPromptSubmitted: 'UserPromptSubmit',
    agentStop: 'Stop', notification: 'Notification',
    preToolUse: 'PreToolUse', postToolUse: 'PostToolUse',
    permissionRequest: 'PermissionRequest', sessionEnd: 'SessionEnd',
    // Cursor
    beforeSubmitPrompt: 'UserPromptSubmit', postToolUseFailure: 'PostToolUseFailure',
    subagentStart: 'SubagentStart', subagentStop: 'SubagentStop',
};

const ARG_ALIASES = [
    ['CommandLine', 'command'], ['FilePath', 'file_path'], ['Path', 'path'],
    ['Url', 'url'], ['Query', 'query'], ['Pattern', 'pattern'],
];

/** Agents whose permission requests the island can answer ('' is Claude Code). */
const DECIDING_AGENTS = ['', 'codex', 'copilot'];
/** Agents that read a JSON object on stdout after every hook. */
const JSON_AGENTS = ['gemini', 'antigravity', 'copilot'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function canonicalEvent(name) {
    return has(EVENT_NAMES, name) ? EVENT_NAMES[name] : name;
}

function nonEmptyString(object, key) {
    const value = object[key];
    return typeof value === 'string' && value ? value : null;
}

/**
 * Fill tool_name, tool_input, session_id and cwd from wherever the agent put them. A
 * field the payload already has is never overwritten.
 */
export function normalizeFields(payload, env) {
    const toolCall = isObject(payload.toolCall) ? payload.toolCall : null;

    if (!has(payload, 'tool_name')) {
        const name = nonEmptyString(payload, 'toolName')
            || (toolCall && nonEmptyString(toolCall, 'name'))
            || nonEmptyString(payload, 'tool');
        if (name)
            payload.tool_name = name;
    }

    if (!has(payload, 'tool_input')) {
        let args = null;
        const toolArgs = payload.toolArgs;
        if (isObject(toolArgs)) {
            args = {...toolArgs};
        } else if (typeof toolArgs === 'string') {
            try {
                const parsed = JSON.parse(toolArgs);
                if (isObject(parsed))
                    args = parsed;
            } catch (_e) {
                // Not JSON: no arguments.
            }
        }
        if (args === null && toolCall !== null && isObject(toolCall.args)) {
            args = {...toolCall.args};
            for (const [source, target] of ARG_ALIASES) {
                if (has(args, source))
                    args[target] = args[source];
            }
        }
        if (args !== null)
            payload.tool_input = args;
    }

    if (!nonEmptyString(payload, 'session_id')) {
        let sid = null;
        for (const key of ['conversationId', 'conversation_id', 'sessionId', 'GEMINI_SESSION_ID']) {
            sid = nonEmptyString(payload, key);
            if (sid)
                break;
        }
        sid = sid || env('GEMINI_SESSION_ID');
        if (sid)
            payload.session_id = sid;
    }

    if (!nonEmptyString(payload, 'cwd')) {
        let cwd = nonEmptyString(payload, 'workdir');
        if (!cwd) {
            for (const key of ['workspacePaths', 'workspace_roots']) {
                const roots = payload[key];
                if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0]) {
                    cwd = roots[0];
                    break;
                }
            }
        }
        if (cwd)
            payload.cwd = cwd;
    }
}

/** A stop that reports an error (Cursor's status: error) is a StopFailure. */
export function refineEvent(event, payload) {
    return event === 'Stop' && payload.status === 'error' ? 'StopFailure' : event;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `text` cut to `limit` UTF-8 bytes on a character boundary, with "…" when it was cut. */
function cut(text, limit) {
    const bytes = encoder.encode(text);
    if (bytes.length <= limit)
        return [text, false];
    let end = limit;
    // Never end inside a multi-byte character: step back to where it starts.
    while (end > 0 && (bytes[end] & 0xC0) === 0x80)
        end--;
    return [`${decoder.decode(bytes.subarray(0, end))}…`, true];
}

const byteLength = text => encoder.encode(text).length;

function truncateStrings(value, limit = MAX_FIELD_LEN) {
    if (typeof value === 'string')
        return cut(value, limit)[0];
    if (Array.isArray(value))
        return value.map(item => truncateStrings(item, limit));
    if (isObject(value)) {
        const out = {};
        for (const [key, item] of Object.entries(value))
            out[key] = truncateStrings(item, limit);
        return out;
    }
    return value;
}

/**
 * tool_input of a diff tool: the edit strings share `budget.left`, each capped; any
 * other string gets the ordinary cap. Returns [value, cutAny].
 */
function capDiffStrings(value, budget) {
    if (isObject(value)) {
        const out = {};
        let cutAny = false;
        for (const [key, item] of Object.entries(value)) {
            if (typeof item === 'string' && DIFF_FIELDS.includes(key)) {
                const [text, wasCut] = cut(item, Math.min(MAX_DIFF_FIELD_LEN, budget.left));
                budget.left = Math.max(0, budget.left - byteLength(text));
                cutAny = cutAny || wasCut;
                out[key] = text;
            } else {
                const [capped, inner] = capDiffStrings(item, budget);
                out[key] = capped;
                cutAny = cutAny || inner;
            }
        }
        return [out, cutAny];
    }
    if (Array.isArray(value)) {
        let cutAny = false;
        const out = value.map(item => {
            const [capped, inner] = capDiffStrings(item, budget);
            cutAny = cutAny || inner;
            return capped;
        });
        return [out, cutAny];
    }
    if (typeof value === 'string')
        return [cut(value, MAX_FIELD_LEN)[0], false];
    return [value, false];
}

/**
 * Cap every string, except the edit text of a finished Edit/MultiEdit/Write, which the
 * live diff needs whole (within its own limits).
 */
export function truncatePayload(payload, event) {
    const keepsDiff = event === 'PostToolUse' && DIFF_TOOLS.includes(payload.tool_name);
    const rest = {...payload};
    const toolInput = keepsDiff ? rest.tool_input : undefined;
    if (keepsDiff)
        delete rest.tool_input;
    const result = truncateStrings(rest);
    if (toolInput !== undefined) {
        const [capped, cutAny] = capDiffStrings(toolInput, {left: MAX_DIFF_TOTAL});
        result.tool_input = capped;
        if (cutAny)
            result.agentbuddy_diff_truncated = true;
    }
    return result;
}

function terminalContext(payload, env) {
    for (const [key, variable] of [['term_program', 'TERM_PROGRAM'], ['term_session_id', 'TERM_SESSION_ID'],
        ['vscode_pid', 'VSCODE_PID'], ['session_pid', 'CLAUDE_CODE_SSE_PORT']]) {
        if (!has(payload, key))
            payload[key] = env(variable) || '';
    }
}

/**
 * Parent pid from the text of /proc/<pid>/stat, or null. The command name sits in
 * parentheses and may contain spaces and parentheses, so cut after the last one.
 */
export function parentFromStat(stat) {
    const close = stat.lastIndexOf(')');
    if (close < 0)
        return null;
    const parent = Number.parseInt(stat.slice(close + 1).trim().split(/\s+/)[1], 10);
    return Number.isInteger(parent) ? parent : null;
}

function procParent(pid) {
    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
        return ok ? parentFromStat(decoder.decode(bytes)) : null;
    } catch (_e) {
        return null;
    }
}

/**
 * `pid` and its parents, nearest first, up to init: the extension looks for the window
 * of a terminal among them to bring it forward.
 */
export function ancestorsFrom(pid, parentOf = procParent) {
    const chain = [];
    while (pid && pid > 1 && !chain.includes(pid) && chain.length < MAX_ANCESTORS) {
        chain.push(pid);
        pid = parentOf(pid);
    }
    return chain;
}

function agentTag(arg, env) {
    if (arg)
        return arg;
    return env('CLAUDE_CODE_ENTRYPOINT') === 'claude-desktop' ? 'claude-desktop' : null;
}

/**
 * The event to forward from the raw stdin bytes, or null when unreadable.
 *
 * @param {Uint8Array} raw
 * @returns {{line: string, name: string, question: ?object, suggestions: ?Array}|null}
 */
export function prepare(raw, agent, eventArg, env, cwd, ancestors = []) {
    if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF)
        raw = raw.subarray(3);
    let payload;
    try {
        payload = JSON.parse(decoder.decode(raw));
    } catch (_e) {
        return null;
    }
    if (!isObject(payload))
        return null;

    const tag = agentTag(agent, env);
    if (tag)
        payload.agentbuddy_agent = tag;

    const rawEvent = nonEmptyString(payload, 'hook_event_name') || eventArg;
    normalizeFields(payload, env);
    const name = refineEvent(canonicalEvent(rawEvent), payload);
    payload.hook_event_name = name;

    for (const field of DROPPED_FIELDS)
        delete payload[field];
    if (!nonEmptyString(payload, 'cwd') && cwd)
        payload.cwd = cwd;
    terminalContext(payload, env);
    if (ancestors.length)
        payload.agentbuddy_pids = [...ancestors];

    // Kept whole: what goes back to Claude Code must be its own input.
    const question = payload.tool_name === 'AskUserQuestion' ? payload.tool_input ?? null : null;

    // Also kept whole: a suggestion the user picks is echoed back verbatim, so a cut
    // copy must never be what goes into the agent's permission rules.
    const suggestions = Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions : null;

    return {line: `${JSON.stringify(truncatePayload(payload, name))}\n`, name, question, suggestions};
}

export const takesDecisions = agent => DECIDING_AGENTS.includes(agent);

function answersFit(question, answers) {
    const items = isObject(question) ? question.questions : null;
    if (!Array.isArray(items) || !items.length || items.length !== Object.keys(answers).length)
        return false;
    for (const item of items) {
        const text = isObject(item) ? item.question : null;
        if (typeof text !== 'string')
            return false;
        const labels = (Array.isArray(item.options) ? item.options : []).filter(isObject).map(o => o.label);
        const multi = item.multiSelect === true;
        const pick = answers[text];
        if (typeof pick === 'string' && !multi) {
            if (!labels.includes(pick))
                return false;
        } else if (Array.isArray(pick) && multi) {
            if (!pick.length || new Set(pick).size !== pick.length || !pick.every(p => labels.includes(p)))
                return false;
        } else {
            return false;
        }
    }
    return true;
}

const SUGGESTION_DESTINATIONS = ['session', 'localSettings', 'projectSettings', 'userSettings'];

/**
 * A permission update the agent itself suggested, safe to hand back as accepted: it may
 * only add an allow rule, change to a mode below bypass, or add a directory.
 */
function usableSuggestion(entry) {
    if (!isObject(entry) || !SUGGESTION_DESTINATIONS.includes(entry.destination))
        return false;
    switch (entry.type) {
    case 'addRules':
        return entry.behavior === 'allow' && Array.isArray(entry.rules) && entry.rules.length > 0;
    case 'setMode':
        return typeof entry.mode === 'string' && entry.mode !== 'bypassPermissions';
    case 'addDirectories':
        return Array.isArray(entry.directories) && entry.directories.length > 0;
    default:
        return false;
    }
}

const permissionReply = decision => JSON.stringify({hookSpecificOutput: {hookEventName: 'PermissionRequest', decision}});

/** The documented PermissionRequest output; anything unrecognised prints nothing (null). */
export function decisionJson(decision, question, suggestions = null) {
    decision = decision.trim();
    if (decision.startsWith('{')) {
        let reply;
        try {
            reply = JSON.parse(decision);
        } catch (_e) {
            return null;
        }
        if (isObject(reply) && has(reply, 'suggestion')) {
            // "Yes, and don't ask again...": only the index travels; the rule is the agent's own.
            const index = reply.suggestion;
            if (!Number.isInteger(index) || !Array.isArray(suggestions) ||
                index < 0 || index >= suggestions.length || !usableSuggestion(suggestions[index]))
                return null;
            return permissionReply({behavior: 'allow', updatedPermissions: [suggestions[index]]});
        }
        const answers = isObject(reply) ? reply.answers : null;
        if (!isObject(answers) || !isObject(question) || !answersFit(question, answers))
            return null;
        return permissionReply({behavior: 'allow', updatedInput: {...question, answers}});
    }
    if (decision === 'allow' || decision === 'always')
        return permissionReply({behavior: 'allow'});
    if (decision === 'deny')
        return permissionReply({behavior: 'deny', message: 'Denied from AgentBuddy'});
    return null;
}

/** The line to print for `event` from `agent`; null means print nothing. */
export function replyStdout(agent, event, decision, question, suggestions = null) {
    if (event !== 'PermissionRequest') {
        // Antigravity reads "{}" on PreToolUse as a denial; "ask" keeps its own prompt.
        if (agent.toLowerCase() === 'antigravity' && event === 'PreToolUse')
            return '{"decision":"ask"}';
        return JSON_AGENTS.includes(agent) ? '{}' : null;
    }
    if (!takesDecisions(agent))
        decision = null;
    if (agent === 'copilot') {
        const word = {allow: 'allow', always: 'allow', deny: 'deny'}[(decision ?? '').trim()];
        return JSON.stringify({permissionDecision: word ?? 'ask'});
    }
    if (decision === null || decision === undefined)
        return null;
    // Only Claude Code asks questions and takes its own permission suggestions.
    return decisionJson(decision, agent === '' ? question : null, agent === '' ? suggestions : null);
}

/** The uid this process runs as (the owner of /proc/self). */
function ownUid() {
    return Gio.File.new_for_path('/proc/self')
        .query_info('unix::uid', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::uid');
}

/**
 * The extension's socket, or null when the runtime directory is not a private directory
 * of ours (a socket in a directory others can write to could be an impostor's).
 */
export function socketPath(env = GLib.getenv, uid = ownUid()) {
    let directory = env('XDG_RUNTIME_DIR');
    if (!directory || !GLib.path_is_absolute(directory))
        directory = `/run/user/${uid}`;
    try {
        // NOFOLLOW: a symlink in place of the directory is refused, like lstat.
        const info = Gio.File.new_for_path(directory).query_info(
            'standard::type,unix::uid,unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        const private_ = info.get_file_type() === Gio.FileType.DIRECTORY &&
            info.get_attribute_uint32('unix::uid') === uid &&
            (info.get_attribute_uint32('unix::mode') & 0o077) === 0;
        return private_ ? GLib.build_filenamev([directory, SOCKET_NAME]) : null;
    } catch (_e) {
        return null;
    }
}

/** A connected socket to the extension, or null (not running, or not run by us). */
function connect(path) {
    if (!path)
        return null;
    let socket = null;
    try {
        socket = Gio.Socket.new(Gio.SocketFamily.UNIX, Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT);
        socket.set_blocking(true);
        socket.set_timeout(CONNECT_TIMEOUT_S);
        socket.connect(Gio.UnixSocketAddress.new(path), null);
        // Whoever listens there must be us, or the event would go to somebody else.
        if (socket.get_credentials().get_unix_user() !== ownUid()) {
            socket.close();
            return null;
        }
        return socket;
    } catch (_e) {
        try {
            socket?.close();
        } catch (_closeError) {
            // Never opened.
        }
        return null;
    }
}

/**
 * Send the event; for a permission request wait for the island's word (one line), at most
 * `budget` seconds. Returns the answer, or null for none.
 */
export function talk(path, line, waitsForAnswer, budget) {
    const deadline = GLib.get_monotonic_time() + budget * 1e6;
    const remaining = () => Math.max(0, deadline - GLib.get_monotonic_time());
    const socket = connect(path);
    if (!socket)
        return null;
    try {
        const bytes = encoder.encode(line);
        let sent = 0;
        while (sent < bytes.length) {
            socket.set_timeout(Math.max(1, Math.ceil(remaining() / 1e6)));
            sent += socket.send(bytes.subarray(sent), null);
        }
        if (!waitsForAnswer)
            return null;
        // Bytes are collected and decoded once: a character may be split between two reads.
        const received = [];
        while (!received.includes(0x0A) && remaining() > 0) {
            const chunk = socket.receive_bytes(4096, remaining(), null).toArray();
            if (!chunk.length)
                break;
            received.push(...chunk);
        }
        return decoder.decode(new Uint8Array(received)).trim() || null;
    } catch (_e) {
        // Timed out or the extension hung up: no answer.
        return null;
    } finally {
        try {
            socket.close();
        } catch (_e) {
            // Already closed.
        }
    }
}

/** `--agent <name>` and the event name, in either order. */
export function parseArgs(argv) {
    let agent = '';
    let event = '';
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--agent')
            agent = argv[++i] ?? '';
        else if (!event)
            event = argv[i];
    }
    return {agent, event};
}

/**
 * One hook run. Returns the line to print on stdout, or null for nothing.
 *
 * @param {string[]} argv
 * @param {Uint8Array} raw the hook JSON from stdin
 */
export function run(argv, raw, {env = GLib.getenv, cwd = GLib.get_current_dir(), ancestors = []} = {}) {
    const {agent, event: eventArg} = parseArgs(argv);
    const prepared = prepare(raw, agent, eventArg, env, cwd, ancestors);
    if (prepared === null)
        return replyStdout(agent, canonicalEvent(eventArg), null, null);
    const {line, name, question, suggestions} = prepared;
    const waits = name === 'PermissionRequest' && takesDecisions(agent);
    const decision = talk(socketPath(env), line, waits, waits ? DECISION_BUDGET_S : FIRE_AND_FORGET_BUDGET_S);
    return replyStdout(agent, name, decision, question, suggestions);
}

/** The pid of the process that started this one (the agent), from /proc/self/stat. */
export function parentPid() {
    return procParent('self');
}
