import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {AGENTS, lineDiff, pretty} from './hookInstaller.js';

const BOM = '\u{FEFF}';

/** Follow symlinks (dotfiles) so a write goes to the real file and keeps the link. */
export function resolveSymlinks(path) {
    let current = path;
    for (let hops = 0; hops < 8; hops++) {
        let info;
        try {
            info = Gio.File.new_for_path(current)
                .query_info('standard::is-symlink,standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        } catch (_e) {
            return current;
        }
        if (!info.get_is_symlink())
            return current;
        const target = info.get_symlink_target();
        current = GLib.path_is_absolute(target) ? target : GLib.build_filenamev([GLib.path_get_dirname(current), target]);
    }
    throw new Error(`${path}: too many symlinks`);
}

/** The file's bytes, or null when it does not exist. */
function readBytes(path) {
    try {
        const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
        return ok ? contents : null;
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return null;
        throw e;
    }
}

const fingerprintOf = bytes =>
    GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes ? new GLib.Bytes(bytes) : new GLib.Bytes(new Uint8Array(0)));

/** Parsed JSON of a config's bytes (BOM tolerated); `undefined` for a missing or empty file. */
export function parseJson(bytes, name) {
    if (bytes === null)
        return undefined;
    let text = new TextDecoder().decode(bytes);
    if (text.startsWith(BOM))
        text = text.slice(1);
    if (text.trim() === '')
        return undefined;
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`${name} is not valid JSON (${e.message}), GnomeAgentBuddy has not touched it.`);
    }
}

/** A dated backup name that is not taken yet (two runs in one second get -2, -3...). */
function backupName(path) {
    const base = `${path}.agentbuddy-backup-${GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S')}`;
    let name = base;
    for (let n = 2; Gio.File.new_for_path(name).query_exists(null); n++)
        name = `${base}-${n}`;
    return name;
}

/**
 * What installing or uninstalling would do to an agent's config, without
 * writing anything. The fingerprint identifies the bytes the diff was computed
 * from; hand it back to `apply` so only what the user looked at is applied.
 *
 * @param {string} agentId
 * @param {boolean} install
 * @param {string} relayPath  absolute path of the installed relay
 * @param {string} [home]
 */
export function plan(agentId, install, relayPath, home = GLib.get_home_dir()) {
    const agent = AGENTS[agentId];
    const path = resolveSymlinks(agent.path(home));
    const bytes = readBytes(path);
    const root = parseJson(bytes, path);
    const next = install ? agent.install(root, relayPath) : agent.uninstall(root);
    const before = bytes === null ? '' : new TextDecoder().decode(bytes).replace(BOM, '');
    const after = next === null ? '' : pretty(next);
    return {
        agentId,
        path,
        install,
        fingerprint: fingerprintOf(bytes),
        diff: lineDiff(before, after),
        changed: before !== after,
        // Nothing to back up when the file does not exist yet.
        backup: bytes === null ? '' : backupName(path),
        text: after,
        removesFile: next === null,
    };
}

/**
 * Write a plan after a dated backup, refusing a file that changed since the
 * preview. Returns where the backup went ('' when there was nothing to back up).
 */
export function apply(planned) {
    const bytes = readBytes(planned.path);
    if (fingerprintOf(bytes) !== planned.fingerprint)
        throw new Error(`${planned.path} changed since the preview, nothing was written. Review it again.`);

    const file = Gio.File.new_for_path(planned.path);
    if (bytes !== null) {
        // The backup must succeed before anything is written.
        file.copy(Gio.File.new_for_path(planned.backup), Gio.FileCopyFlags.NONE, null, null);
    }
    if (planned.removesFile) {
        if (bytes !== null)
            file.delete(null);
        return planned.backup;
    }
    GLib.mkdir_with_parents(GLib.path_get_dirname(planned.path), 0o755);
    // A config can hold keys, so it must never get wider permissions than it had.
    // REPLACE_DESTINATION drops the old mode, so keep it by hand; a new file is private.
    const mode = bytes === null ? 0o600
        : file.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode') & 0o7777;
    // replace_contents writes to a temp file and renames it over the target: atomic.
    // PRIVATE: the temp file is 0600 from the start, never briefly readable by others.
    file.replace_contents(new TextEncoder().encode(planned.text), null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);
    GLib.chmod(planned.path, mode);
    return planned.backup;
}

/** Whether an agent's config currently holds our entries; never throws. */
export function isInstalled(agentId, home = GLib.get_home_dir()) {
    try {
        const agent = AGENTS[agentId];
        return agent.installed(parseJson(readBytes(resolveSymlinks(agent.path(home))), agentId));
    } catch (_e) {
        return false;
    }
}

/** Where the relay lives once installed. */
export function relayInstallPath(home = GLib.get_home_dir()) {
    return GLib.build_filenamev([home, '.local', 'share', 'GnomeAgentBuddy', 'bin', 'agentbuddy-hook']);
}

/**
 * Copy the relay out of the extension into a stable path the agents' configs
 * point at, so a hook keeps working across extension updates. Written beside the
 * old copy and renamed over it, so a hook starting meanwhile runs one or the other.
 *
 * @param {Gio.File} extensionDir
 */
export function installRelay(extensionDir, home = GLib.get_home_dir()) {
    const source = extensionDir.get_child('relay').get_child('agentbuddy_hook.py');
    const dest = Gio.File.new_for_path(relayInstallPath(home));
    const dir = dest.get_parent();
    GLib.mkdir_with_parents(dir.get_path(), 0o700);

    const [, wanted] = source.load_contents(null);
    const current = readBytes(dest.get_path());
    if (current && fingerprintOf(current) === fingerprintOf(wanted)) {
        GLib.chmod(dest.get_path(), 0o755);
        return dest.get_path();
    }
    const temp = dir.get_child(`agentbuddy-hook.new-${GLib.random_int()}`);
    temp.replace_contents(wanted, null, false, Gio.FileCreateFlags.NONE, null);
    GLib.chmod(temp.get_path(), 0o755);
    temp.move(dest, Gio.FileCopyFlags.OVERWRITE, null, null);
    return dest.get_path();
}
