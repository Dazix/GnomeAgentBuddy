import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {RelayServer} from '../lib/relayServer.js';
import {SessionStore} from '../model/sessionStore.js';
import {assertEqual, assertTrue, test} from './harness.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

const relayPath = GLib.build_filenamev([
    Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path(),
    'relay', 'agentbuddy_hook.py',
]);

function withServer(fn) {
    return async () => {
        const dir = GLib.dir_make_tmp('agentbuddy-test-XXXXXX');
        const store = new SessionStore();
        const server = new RelayServer(store, GLib.build_filenamev([dir, 'agentbuddy.sock']));
        server.start();
        try {
            await fn({store, dir});
        } finally {
            server.stop();
            Gio.File.new_for_path(dir).delete(null);
        }
    };
}

async function runRelay(dir, payload, args = []) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
    });
    launcher.setenv('XDG_RUNTIME_DIR', dir, true);
    const proc = launcher.spawnv(['python3', relayPath, ...args]);
    const [stdout] = await proc.communicate_utf8_async(JSON.stringify(payload), null);
    return stdout;
}

test('relay to extension: a tool event is folded into a session', withServer(async ({store, dir}) => {
    const out = await runRelay(dir, {hook_event_name: 'PreToolUse', session_id: 's', cwd: '/p/app',
        tool_name: 'Bash', tool_input: {command: 'ls'}});
    assertEqual(out, '');
    // The server handles the event asynchronously after the relay exits.
    for (let i = 0; i < 50 && store.sessions.size === 0; i++)
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => resolve() || false));
    assertEqual(store.list()[0].steps, ['Bash · ls']);
}));

test('relay to extension: Allow travels back to the agent', withServer(async ({store, dir}) => {
    store.onChange(() => {
        if (store.current)
            store.resolve(store.current.id, 'allow');
    });
    const out = await runRelay(dir, {hook_event_name: 'PermissionRequest', session_id: 's',
        tool_name: 'Bash', tool_input: {command: 'ls'}});
    const reply = JSON.parse(out);
    assertEqual(reply.hookSpecificOutput.decision.behavior, 'allow');
}));

test('relay to extension: Deny, and a gemini request gets no allow', withServer(async ({store, dir}) => {
    store.onChange(() => {
        if (store.current)
            store.resolve(store.current.id, 'deny');
    });
    const denied = JSON.parse(await runRelay(dir, {hook_event_name: 'PermissionRequest', session_id: 's',
        tool_name: 'Bash'}));
    assertEqual(denied.hookSpecificOutput.decision.behavior, 'deny');
}));

test('relay with no extension listening exits quietly', async () => {
    const dir = GLib.dir_make_tmp('agentbuddy-test-XXXXXX');
    try {
        const out = await runRelay(dir, {hook_event_name: 'PermissionRequest', tool_name: 'Bash'});
        assertEqual(out, '');
        const gemini = await runRelay(dir, {hook_event_name: 'BeforeTool'}, ['--agent', 'gemini']);
        assertEqual(gemini.trim(), '{}');
    } finally {
        Gio.File.new_for_path(dir).delete(null);
    }
});

test('garbage on the socket is dropped without breaking the server', withServer(async ({store, dir}) => {
    const client = new Gio.SocketClient();
    const connection = client.connect(
        Gio.UnixSocketAddress.new(GLib.build_filenamev([dir, 'agentbuddy.sock'])), null);
    connection.get_output_stream().write_all(new TextEncoder().encode('not json\n'), null);
    connection.close(null);
    assertEqual(store.sessions.size, 0);
    assertTrue(true);
}));
