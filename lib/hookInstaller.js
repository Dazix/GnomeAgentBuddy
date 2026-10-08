/**
 * What GnomeAgentBuddy writes into each agent's hook config, and how it takes it
 * out again. Pure logic (no GNOME imports); reading, diffing the file on disk,
 * backups and writing live in configFile.js.
 *
 * The rules, same as Coucou's installers (MIT, Louis-CFM/coucou agents.rs / hooks.rs):
 * merge without touching anybody else's hooks, refuse values of an unexpected
 * type instead of replacing them, and uninstall removes only our own entries.
 * Formats and paths follow Coucou's so a dotfiles config looks the same everywhere.
 */

/** Marker that identifies one of our entries: the relay's file name. */
export const MARKER = 'agentbuddy-hook';

/** Single-quoted shell word. */
export function shellQuote(text) {
    return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

/** The command line a hook runs: the relay, then `--agent <name>` and the event. */
export function relayCommand(relayPath, agent, event) {
    const parts = [shellQuote(relayPath)];
    if (agent)
        parts.push('--agent', agent);
    if (event)
        parts.push(event);
    return parts.join(' ');
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function unexpected(what, file) {
    return new Error(`${file}: ${what} has an unexpected type, GnomeAgentBuddy has not touched it.`);
}

const entryText = entry => JSON.stringify(entry ?? null);

/** A Claude-style group `{hooks: [{command}]}` or a Copilot entry `{bash}` that runs our relay. */
export function entryIsOurs(entry) {
    return entryText(entry).includes(MARKER);
}

function objectAt(root, key, file) {
    const value = root[key];
    if (value === undefined)
        return {};
    if (!isObject(value))
        throw unexpected(`"${key}"`, file);
    return {...value};
}

function listAt(hooks, event, file) {
    const value = hooks[event];
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw unexpected(`"hooks"."${event}"`, file);
    return [...value];
}

/** Add `entries` ([event, entry] pairs) under root.hooks, replacing any earlier entry of ours. */
function groupsInstall(root, entries, file) {
    const out = isObject(root) ? {...root} : {};
    const hooks = objectAt(out, 'hooks', file);
    for (const [event, entry] of entries) {
        const list = listAt(hooks, event, file).filter(e => !entryIsOurs(e));
        list.push(entry);
        hooks[event] = list;
    }
    out.hooks = hooks;
    return out;
}

/** Remove every entry of ours; events and `hooks` that end up empty go too. */
function groupsUninstall(root, file) {
    const out = isObject(root) ? {...root} : {};
    if (out.hooks === undefined)
        return out;
    const hooks = objectAt(out, 'hooks', file);
    for (const [event, value] of Object.entries(hooks)) {
        if (!Array.isArray(value))
            continue;
        const kept = value.filter(e => !entryIsOurs(e));
        if (kept.length)
            hooks[event] = kept;
        else
            delete hooks[event];
    }
    if (Object.keys(hooks).length)
        out.hooks = hooks;
    else
        delete out.hooks;
    return out;
}

function groupsHaveOurs(root) {
    if (!isObject(root) || !isObject(root.hooks))
        return false;
    return Object.values(root.hooks).some(list => Array.isArray(list) && list.some(entryIsOurs));
}

// Claude Code: every event the island reacts to, with the hook timeout in seconds.
// PermissionRequest waits for a human, so it gets the longest one.
const CLAUDE_EVENTS = [
    ['SessionStart', 10], ['SessionEnd', 10], ['UserPromptSubmit', 10], ['PreToolUse', 10],
    ['PostToolUse', 10], ['PostToolUseFailure', 10], ['PermissionRequest', 120], ['Notification', 10],
    ['Stop', 10], ['StopFailure', 10], ['SubagentStart', 10], ['SubagentStop', 10],
];

// Codex: Claude-style groups without a matcher, seconds; trusted once with /hooks.
const CODEX_EVENTS = [
    ['SessionStart', 10], ['UserPromptSubmit', 10], ['PreToolUse', 10], ['PermissionRequest', 120],
    ['PostToolUse', 10], ['Stop', 10], ['SubagentStart', 10], ['SubagentStop', 10],
    ['Interrupt', 3], ['SessionEnd', 3],
];

// Gemini CLI: groups with a `*` matcher, milliseconds. AfterModel is left out, it
// fires on every response chunk. [geminiEvent, relayEvent, timeout]
const GEMINI_EVENTS = [
    ['SessionStart', 'SessionStart', 10000], ['SessionEnd', 'SessionEnd', 10000],
    ['BeforeTool', 'PreToolUse', 5000], ['AfterTool', 'PostToolUse', 5000],
    ['BeforeAgent', 'UserPromptSubmit', 5000], ['AfterAgent', 'Stop', 5000],
];

// Copilot CLI: camelCase events, entries `{type, bash, timeoutSec}`, own file.
const COPILOT_EVENTS = [
    ['sessionStart', 10], ['userPromptSubmitted', 10], ['preToolUse', 10], ['permissionRequest', 120],
    ['postToolUse', 10], ['agentStop', 10], ['sessionEnd', 3], ['notification', 10],
];

const hookGroup = (command, timeout, extra = {}) =>
    ({hooks: [{type: 'command', command, timeout, ...extra}]});

/**
 * Per-agent installers. `path(home)` is the config file; `install(root, relay)`
 * returns the new content; `uninstall(root)` returns the new content, or null
 * when the file was ours alone and should go; `installed(root)` says whether
 * our entries are there; `approvals` tells whether Allow/Deny works for it.
 */
export const AGENTS = {
    claude: {
        id: 'claude',
        label: 'Claude Code',
        approvals: true,
        note: 'Start a new Claude Code session to pick the hooks up.',
        path: home => `${home}/.claude/settings.json`,
        install: (root, relay) => groupsInstall(root, CLAUDE_EVENTS.map(([event, timeout]) =>
            [event, hookGroup(relayCommand(relay, '', event), timeout)]), 'settings.json'),
        uninstall: root => groupsUninstall(root, 'settings.json'),
        installed: groupsHaveOurs,
    },
    codex: {
        id: 'codex',
        label: 'Codex',
        approvals: true,
        note: 'Codex runs new hooks only once you trust them: start Codex and review them once with /hooks.',
        path: home => `${home}/.codex/hooks.json`,
        install: (root, relay) => groupsInstall(root, CODEX_EVENTS.map(([event, timeout]) =>
            [event, hookGroup(relayCommand(relay, 'codex', event), timeout,
                event === 'PermissionRequest' ? {statusMessage: 'Waiting for your answer in the notch (GnomeAgentBuddy)'} : {})]),
            'hooks.json'),
        uninstall: root => groupsUninstall(root, 'hooks.json'),
        installed: groupsHaveOurs,
    },
    gemini: {
        id: 'gemini',
        label: 'Gemini CLI',
        approvals: false,
        note: 'Start a new Gemini CLI session to pick the hooks up.',
        path: home => `${home}/.gemini/settings.json`,
        install: (root, relay) => groupsInstall(root, GEMINI_EVENTS.map(([event, relayEvent, timeout]) =>
            [event, {matcher: '*', ...hookGroup(relayCommand(relay, 'gemini', relayEvent), timeout)}]),
            'settings.json'),
        uninstall: root => groupsUninstall(root, 'settings.json'),
        installed: groupsHaveOurs,
    },
    copilot: {
        id: 'copilot',
        label: 'GitHub Copilot CLI',
        approvals: true,
        note: 'Start a new Copilot CLI session to pick the hooks up.',
        path: home => `${home}/.copilot/hooks/agentbuddy.json`,
        install: (root, relay) => {
            const out = groupsInstall(root, COPILOT_EVENTS.map(([event, timeoutSec]) =>
                [event, {type: 'command', bash: relayCommand(relay, 'copilot', event), timeoutSec}]),
                'agentbuddy.json');
            out.version = 1;
            return out;
        },
        uninstall: root => {
            const out = groupsUninstall(root, 'agentbuddy.json');
            // Nothing of anyone else's left: the file was ours, and goes.
            return Object.keys(out).every(k => k === 'version') ? null : out;
        },
        installed: groupsHaveOurs,
    },
};

export const AGENT_IDS = Object.keys(AGENTS);

/**
 * Line diff of two texts, as unified-style lines (` `, `-`, `+`) with `context`
 * unchanged lines around each change and `...` between hunks.
 */
export function lineDiff(before, after, context = 2) {
    const a = before === '' ? [] : before.split('\n');
    const b = after === '' ? [] : after.split('\n');
    // Longest common subsequence table; config files are small.
    const table = Array.from({length: a.length + 1}, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--)
            table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            ops.push([' ', a[i]]);
            i++;
            j++;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
            ops.push(['-', a[i++]]);
        } else {
            ops.push(['+', b[j++]]);
        }
    }
    while (i < a.length)
        ops.push(['-', a[i++]]);
    while (j < b.length)
        ops.push(['+', b[j++]]);

    const keep = new Array(ops.length).fill(false);
    ops.forEach(([kind], index) => {
        if (kind === ' ')
            return;
        for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++)
            keep[k] = true;
    });
    const lines = [];
    let gap = false;
    ops.forEach(([kind, text], index) => {
        if (!keep[index]) {
            gap = true;
            return;
        }
        if (gap && lines.length)
            lines.push('...');
        gap = false;
        lines.push(`${kind} ${text}`);
    });
    return lines.join('\n');
}

/** The text written to disk for a config value: 2-space JSON and a final newline. */
export const pretty = value => `${JSON.stringify(value, null, 2)}\n`;
