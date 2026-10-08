import {AGENTS, AGENT_IDS, entryIsOurs, lineDiff, pretty, relayCommand, shellQuote} from '../lib/hookInstaller.js';
import {assertEqual, assertTrue, test} from './harness.js';

const RELAY = '/home/me/.local/share/GnomeAgentBuddy/bin/agentbuddy-hook';

test('shellQuote and relayCommand quote one shell word', () => {
    assertEqual(shellQuote("it's"), `'it'\\''s'`);
    assertEqual(relayCommand('/a b/hook', '', 'Stop'), `'/a b/hook' Stop`);
    assertEqual(relayCommand(RELAY, 'gemini', 'PreToolUse'), `'${RELAY}' --agent gemini PreToolUse`);
});

test('claude: install keeps every other setting and every foreign hook, uninstall restores', () => {
    const existing = {
        model: 'opus', theme: 'dark', enabledPlugins: ['a'],
        hooks: {
            PreToolUse: [{hooks: [{type: 'command', command: 'someone-elses-tool'}]}],
            Custom: [{hooks: [{type: 'command', command: 'keep-me'}]}],
        },
    };
    const claude = AGENTS.claude;
    assertEqual(claude.installed(existing), false);
    const after = claude.install(existing, RELAY);
    assertEqual(after.model, 'opus');
    assertEqual(after.enabledPlugins, ['a']);
    assertTrue(after.hooks.PreToolUse.some(e => JSON.stringify(e).includes('someone-elses-tool')));
    assertTrue(after.hooks.PreToolUse.some(entryIsOurs));
    assertEqual(after.hooks.Custom, existing.hooks.Custom);
    assertEqual(after.hooks.PermissionRequest[0].hooks[0].timeout, 120);
    assertEqual(claude.installed(after), true);
    // Twice: still one entry of ours per event.
    const twice = claude.install(after, RELAY);
    assertEqual(twice.hooks.PreToolUse.filter(entryIsOurs).length, 1);
    assertEqual(claude.uninstall(after), existing);
});

test('claude: an empty or missing config gets a fresh hooks object, uninstall leaves {}', () => {
    const after = AGENTS.claude.install(undefined, RELAY);
    assertEqual(Object.keys(after), ['hooks']);
    assertEqual(AGENTS.claude.uninstall(after), {});
});

test('values of an unexpected type are refused, not replaced', () => {
    for (const odd of [{hooks: 'a string'}, {hooks: [1, 2]}, {hooks: {PreToolUse: {not: 'a list'}}}]) {
        let threw = false;
        try {
            AGENTS.claude.install(odd, RELAY);
        } catch (_e) {
            threw = true;
        }
        assertTrue(threw, JSON.stringify(odd));
    }
    // An event we do not install stays as it is, whatever its shape.
    const kept = {hooks: {Custom: 'anything'}};
    assertEqual(AGENTS.claude.uninstall(kept), kept);
});

test('codex: no matcher, seconds, the waiting message on PermissionRequest', () => {
    const after = AGENTS.codex.install({}, RELAY);
    const permission = after.hooks.PermissionRequest[0].hooks[0];
    assertEqual(permission.timeout, 120);
    assertTrue(permission.command.includes('--agent codex PermissionRequest'));
    assertTrue(permission.statusMessage.includes('GnomeAgentBuddy'));
    assertEqual(after.hooks.PreToolUse[0].matcher, undefined);
});

test('gemini: star matcher, milliseconds, relay event names on the command line', () => {
    const after = AGENTS.gemini.install({theme: 'x'}, RELAY);
    const group = after.hooks.BeforeTool[0];
    assertEqual(group.matcher, '*');
    assertEqual(group.hooks[0].timeout, 5000);
    assertTrue(group.hooks[0].command.endsWith('--agent gemini PreToolUse'));
    assertEqual(after.theme, 'x');
    assertEqual(AGENTS.gemini.uninstall(after), {theme: 'x'});
});

test('copilot: own file, version 1, removing the last entry removes the file', () => {
    const after = AGENTS.copilot.install(undefined, RELAY);
    assertEqual(after.version, 1);
    assertEqual(after.hooks.permissionRequest[0].timeoutSec, 120);
    assertTrue(after.hooks.preToolUse[0].bash.includes('--agent copilot preToolUse'));
    assertEqual(AGENTS.copilot.uninstall(after), null);
    // Someone else's entry in the same file keeps it alive.
    const shared = {version: 1, hooks: {preToolUse: [{type: 'command', bash: 'theirs'}]}};
    const merged = AGENTS.copilot.install(shared, RELAY);
    assertEqual(AGENTS.copilot.uninstall(merged), shared);
});

test('every agent has a path under home and a label', () => {
    for (const id of AGENT_IDS) {
        assertTrue(AGENTS[id].path('/h').startsWith('/h/.'));
        assertTrue(AGENTS[id].label.length > 0);
    }
});

test('lineDiff: shows only changes with context, nothing for equal text', () => {
    assertEqual(lineDiff('a\nb\nc', 'a\nb\nc'), '');
    const diff = lineDiff(pretty({a: 1}), pretty({a: 1, b: 2}));
    assertTrue(diff.includes('+   "b": 2'));
    assertTrue(diff.includes('-   "a": 1'));
    assertTrue(diff.includes('+   "a": 1,'));
    const far = lineDiff(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n'),
        ['x', '2', '3', '4', '5', '6', '7', '8', '9', 'y'].join('\n'));
    assertTrue(far.includes('...'));
});
