import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {apply, installRelay, isInstalled, plan, relayInstallPath} from '../lib/configFile.js';
import {assertEqual, assertTrue, test} from './harness.js';

const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();

function tempHome() {
    return GLib.dir_make_tmp('agentbuddy-home-XXXXXX');
}

function write(path, text) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    Gio.File.new_for_path(path).replace_contents(new TextEncoder().encode(text), null, false,
        Gio.FileCreateFlags.NONE, null);
}

const read = path => new TextDecoder().decode(Gio.File.new_for_path(path).load_contents(null)[1]);

function remove(path) {
    const file = Gio.File.new_for_path(path);
    const info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        const children = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        for (let child = children.next_file(null); child; child = children.next_file(null))
            remove(GLib.build_filenamev([path, child.get_name()]));
    }
    file.delete(null);
}

test('install into a BOM file: backup holds the original bytes, other settings and hooks survive', () => {
    const home = tempHome();
    try {
        const path = `${home}/.claude/settings.json`;
        const original = '\u{FEFF}{"model":"opus","tui":{"x":1},"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"other-tool"}]}]}}';
        write(path, original);

        const planned = plan('claude', true, '/r/agentbuddy-hook', home);
        assertTrue(planned.changed);
        assertTrue(planned.diff.includes('agentbuddy-hook'));
        const backup = apply(planned);
        assertEqual(read(backup), original);

        const after = JSON.parse(read(path));
        assertEqual(after.model, 'opus');
        assertEqual(after.tui, {x: 1});
        assertTrue(JSON.stringify(after.hooks.PreToolUse).includes('other-tool'));
        assertTrue(isInstalled('claude', home));

        const removed = plan('claude', false, '/r/agentbuddy-hook', home);
        apply(removed);
        assertEqual(isInstalled('claude', home), false);
        assertEqual(JSON.parse(read(path)).hooks.PreToolUse.length, 1);
    } finally {
        remove(home);
    }
});

test('a file that changed since the preview is refused and left alone', () => {
    const home = tempHome();
    try {
        const path = `${home}/.gemini/settings.json`;
        write(path, '{"theme":"dark"}');
        const planned = plan('gemini', true, '/r/agentbuddy-hook', home);
        write(path, '{"theme":"someone-else-edited-this"}');
        let message = '';
        try {
            apply(planned);
        } catch (e) {
            message = e.message;
        }
        assertTrue(message.includes('changed since the preview'), message);
        assertEqual(read(path), '{"theme":"someone-else-edited-this"}');
    } finally {
        remove(home);
    }
});

test('broken JSON is refused before anything is written', () => {
    const home = tempHome();
    try {
        const path = `${home}/.claude/settings.json`;
        write(path, '{ broken');
        let threw = false;
        try {
            plan('claude', true, '/r/agentbuddy-hook', home);
        } catch (_e) {
            threw = true;
        }
        assertTrue(threw);
        assertEqual(read(path), '{ broken');
        assertEqual(isInstalled('claude', home), false);
    } finally {
        remove(home);
    }
});

test('a missing file is created with no backup, and a copilot file is removed on uninstall', () => {
    const home = tempHome();
    try {
        const planned = plan('copilot', true, '/r/agentbuddy-hook', home);
        assertEqual(planned.backup, '');
        apply(planned);
        const path = `${home}/.copilot/hooks/agentbuddy.json`;
        assertTrue(JSON.parse(read(path)).hooks.permissionRequest.length === 1);
        apply(plan('copilot', false, '/r/agentbuddy-hook', home));
        assertEqual(Gio.File.new_for_path(path).query_exists(null), false);
    } finally {
        remove(home);
    }
});

test('a symlinked config (dotfiles) is written through and the link stays', () => {
    const home = tempHome();
    try {
        const real = `${home}/dotfiles/claude-settings.json`;
        write(real, '{"theme":"dark"}');
        GLib.mkdir_with_parents(`${home}/.claude`, 0o755);
        Gio.File.new_for_path(`${home}/.claude/settings.json`).make_symbolic_link(real, null);

        apply(plan('claude', true, '/r/agentbuddy-hook', home));
        const link = Gio.File.new_for_path(`${home}/.claude/settings.json`)
            .query_info('standard::is-symlink', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        assertTrue(link.get_is_symlink());
        assertTrue(JSON.parse(read(real)).hooks.Stop.length === 1);
    } finally {
        remove(home);
    }
});

const modeOf = path => Gio.File.new_for_path(path)
    .query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode') & 0o7777;

test('permissions: a private config stays private (file, backup), and a new one is created private', () => {
    const home = tempHome();
    try {
        const path = `${home}/.claude/settings.json`;
        write(path, '{"env":{"API_KEY":"secret"}}');
        GLib.chmod(path, 0o600);

        const backup = apply(plan('claude', true, '/r/agentbuddy-hook', home));
        assertEqual(modeOf(path).toString(8), '600');
        assertEqual(modeOf(backup).toString(8), '600');

        // A mode the user chose is kept as it was, not widened to the default.
        GLib.chmod(path, 0o640);
        apply(plan('claude', false, '/r/agentbuddy-hook', home));
        assertEqual(modeOf(path).toString(8), '640');

        // A file that did not exist is not world-readable either.
        apply(plan('gemini', true, '/r/agentbuddy-hook', home));
        assertEqual(modeOf(`${home}/.gemini/settings.json`).toString(8), '600');
    } finally {
        remove(home);
    }
});

test('installRelay copies the relay executable and is idempotent', () => {
    const home = tempHome();
    try {
        const path = installRelay(root, home);
        assertEqual(path, relayInstallPath(home));
        const info = Gio.File.new_for_path(path).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
        assertEqual(info.get_attribute_uint32('unix::mode') & 0o777, 0o755);
        assertEqual(installRelay(root, home), path);
        assertTrue(read(path).startsWith('#!/usr/bin/env python3'));
    } finally {
        remove(home);
    }
});
